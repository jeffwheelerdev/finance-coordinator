import test from 'node:test';
import assert from 'node:assert/strict';
import { readMonthlyEvidence, checkMonthlyRothEvidence } from '../lib/monthly-evidence.mjs';

// Synthetic account IDs, cash snapshots and transactions only.
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2030-02-01T15:00:00.000Z');
const iso = n => new Date(n).toISOString();
const clone = value => structuredClone(value);
const roles = { income: ID(1), bills: ID(2), general: ID(3), emergency: ID(4), project: ID(5), personalInvestment: ID(6), roth: ID(7) };
const actor = (id, type = 'EXTERNAL_ACCOUNT') => ({ id, type, isDeleted: false });

function account(id, amount = 100000) {
  return { id, type: 'EXTERNAL_ACCOUNT', externalAccountType: 'DEPOSITORY', institutionName: 'Synthetic bank',
    deletedAt: null, canBeSource: true, canBeDestination: true,
    balance: { balanceInCents: amount, availableBalanceInCents: amount, holdInCents: null,
      balanceLastUpdatedAt: '2030-02-01T14:59:00.000Z', error: null } };
}

function bankRow(overrides = {}) {
  return { id: ID(100), accountId: roles.income, amountInCents: 500000, direction: 'MONEY_IN', status: 'COMPLETE',
    transactionDate: '2030-01-31T12:00:00.000Z', description: 'Synthetic payroll description', merchantName: null,
    category: 'Income', ...overrides };
}

function fixture() {
  const config = { accounts: { income: roles.income, bills: roles.bills, general: roles.general, emergency: roles.emergency, pod: ID(8) },
    monthly: { enabled: true, projectAccountId: roles.project, personalAccountId: roles.personalInvestment },
    roth: { enabled: true, accountId: roles.roth }, maxBalanceAgeMs: 26 * 3600000,
    rules: { funding: ID(11), payout: ID(12), legacyGeneral: ID(13), emergencyFallback: ID(14) } };
  const accounts = new Map(Object.values(roles).map(id => [id, account(id)]));
  accounts.set(roles.income, account(roles.income, 900000));
  accounts.set(roles.emergency, account(roles.emergency, 1050000));
  for (const id of [roles.personalInvestment, roles.roth]) {
    Object.assign(accounts.get(id), { externalAccountType: 'INVESTMENT', canBeSource: false, institutionName: 'Fidelity' });
    // Retirement market value is not needed to establish safe cash funding.
    delete accounts.get(id).balance;
  }
  const s = { config, accounts, knownTransfers: [], transfers: [], externalRows: [],
    rules: new Map(Object.values(config.rules).map(id => [id, { id, status: 'DISABLED', deletedAt: null }])),
    calls: [], now: NOW, externalFrom: '2030-01-01T00:00:00.000Z', completeTransfers: true, completeExternal: true,
    windowOverride: null };
  s.client = {
    async getRule(id) { s.calls.push({ method: 'getRule', id }); return clone(s.rules.get(id)); },
    async getAccount(id) { s.calls.push({ method: 'getAccount', id }); return clone(s.accounts.get(id)); },
    async listTransfers(options) { s.calls.push({ method: 'listTransfers', options }); return { items: clone(s.transfers), complete: s.completeTransfers }; },
    async listExternalTransactions(options) { s.calls.push({ method: 'listExternalTransactions', options });
      return { items: clone(s.externalRows), complete: s.completeExternal,
        window: s.windowOverride ?? { from: options.from, to: options.to, truncated: false } }; },
  };
  s.read = (options = {}) => readMonthlyEvidence(s.client, s.config, { now: s.now, externalFrom: s.externalFrom,
    knownTransfers: s.knownTransfers, ...options });
  s.transfer = (overrides = {}, known = true) => {
    const transfer = { id: ID(200 + s.transfers.length), source: actor(roles.income), destination: actor(roles.bills),
      amountInCents: 10000, executionMode: 'LIVE', origin: 'USER', ruleId: null, ruleExecutionId: null,
      status: 'PENDING', createdAt: '2030-02-01T14:00:01.000Z', completedAt: null, errorCode: null, ...overrides };
    s.transfers.push(transfer);
    if (known) s.knownTransfers.push({ transferId: transfer.id, sourceAccountId: transfer.source.id,
      destinationAccountId: transfer.destination.id, amountInCents: transfer.amountInCents,
      firstAttemptAt: '2030-02-01T14:00:00.000Z', status: transfer.status === 'COMPLETE' ? 'COMPLETE' : 'PENDING', completedAt: transfer.completedAt });
    return transfer;
  };
  s.rothProof = { schemaVersion: 1, updatedAt: '2030-01-01T00:00:00.000Z',
    route: { status: 'verified', sourceAccountId: roles.income, destinationAccountId: roles.roth, custodian: 'fidelity',
      contributionYear: 'current_calendar_year', verifiedAt: '2030-01-01T00:00:00.000Z', reference: 'Synthetic current-year route proof' },
    upstream: { status: 'unverified' } };
  s.checkRoth = evidence => checkMonthlyRothEvidence(evidence, s.config,
    { now: s.now, rothEvidence: s.rothProof, outsideContributionsVerifiedAt: '2030-01-01T00:00:00.000Z', knownTransfers: s.knownTransfers });
  return s;
}

const rejects = (work, code) => assert.rejects(work, error => error?.code === code);

function retiringFixture() {
  const s = fixture();
  const { emergencyFallback, ...mapped } = s.config.rules;
  s.config.rules = { ...mapped, excess: emergencyFallback };
  s.config.monthly.sequenceRetirement = { schemaVersion: 1, authorizedAt: '2030-01-31T15:00:00.000Z',
    reference: 'Synthetic user-authorized cleanup', podAccountId: s.config.accounts.pod,
    rules: { payout: s.config.rules.payout, funding: s.config.rules.funding, legacyGeneral: s.config.rules.legacyGeneral, excess: s.config.rules.excess } };
  s.inventory = () => [...s.rules.values()].map(row => ({ isSupported: true,
    createdAt: '2029-12-01T00:00:00.000Z', updatedAt: '2030-01-31T12:00:00.000Z', ...row }));
  s.client.listRules = async () => { s.calls.push({ method: 'listRules' });
    return { items: clone(s.inventory()), complete: true, unfiltered: true }; };
  return s;
}

test('retirement stages with disabled archives and then tolerates absence without claiming deletion', async () => {
  const s = retiringFixture(); let result = await s.read();
  assert.equal(result.nativeRuleInventory.presentDisabledCount, 4); assert.equal(result.nativeRuleInventory.absentCount, 0);
  assert.equal(s.calls.some(row => row.method === 'getRule'), false);
  s.rules.clear(); result = await s.read();
  assert.ok(Object.values(result.nativeRuleStatuses).every(status => status === 'ABSENT'));
  assert.equal(result.nativeRuleInventory.absentCount, 4); assert.equal(result.nativeRuleInventory.explicitlyDeletedCount, 0);
  assert.equal(result.nativeRuleInventory.visibility, 'not_inferred_from_listing');
  assert.equal(s.calls.some(row => row.id === s.config.accounts.pod), false);
});

test('only an explicit valid provider deletion timestamp is reported as DELETED', async () => {
  const s = retiringFixture(); s.rules.get(s.config.rules.funding).deletedAt = '2030-01-31T14:00:00.000Z';
  const result = await s.read(); assert.equal(result.nativeRuleStatuses.funding, 'DELETED');
  assert.equal(result.nativeRuleInventory.explicitlyDeletedCount, 1); assert.equal(result.nativeRuleInventory.presentDisabledCount, 3);
});

test('retirement never treats authentication errors, generic 404s, timeouts or partial listing as successful cleanup', async t => {
  for (const code of ['ACCESS_DENIED', 'UNAUTHORIZED', 'HTTP_ERROR', 'RESOURCE_NOT_FOUND', 'REQUEST_TIMEOUT']) await t.test(code, async () => {
    const s = retiringFixture(); s.client.listRules = async () => { throw Object.assign(new Error('Synthetic read failure'), { code }); };
    await rejects(s.read(), code); assert.equal(s.calls.some(row => row.method === 'listTransfers'), false);
  });
  for (const change of [{ complete: false }, { unfiltered: false }]) await t.test(JSON.stringify(change), async () => {
    const s = retiringFixture(); s.client.listRules = async () => ({ items: [], complete: true, unfiltered: true, ...change });
    await rejects(s.read(), 'MONTHLY_RULE_INVENTORY_INCOMPLETE');
  });
});

test('authorized retirement still blocks reenabled old rules and newly active competing routes', async t => {
  await t.test('old enabled rule', async () => {
    const s = retiringFixture(); s.rules.get(s.config.rules.payout).status = 'ENABLED';
    await rejects(s.read(), 'MONTHLY_LEGACY_RULE_ENABLED');
  });
  for (const touched of [roles.income, roles.emergency, roles.roth, ID(8)]) await t.test(touched, async () => {
    const s = retiringFixture(); s.rules.set(ID(900), { id: ID(900), status: 'ENABLED', deletedAt: null,
      steps: [{ actions: [{ source: { id: ID(901) }, destination: { id: touched } }] }] });
    await rejects(s.read(), 'MONTHLY_CONFLICTING_NATIVE_RULE_ENABLED');
    assert.equal(s.calls.some(row => row.method === 'listTransfers'), false);
  });
  await t.test('uninspectable active rule', async () => {
    const s = retiringFixture(); s.rules.set(ID(900), { id: ID(900), status: 'ENABLED', deletedAt: null, isSupported: false });
    await rejects(s.read(), 'MONTHLY_ACTIVE_RULE_UNVERIFIED');
    assert.equal(s.calls.some(row => row.method === 'getRule'), false);
  });
  await t.test('independent active rule', async () => {
    const s = retiringFixture(); s.rules.set(ID(900), { id: ID(900), status: 'ENABLED', deletedAt: null,
      steps: [{ actions: [{ source: { id: ID(901) }, destination: { id: ID(902) } }] }] });
    assert.equal((await s.read()).nativeRuleInventory.unrelatedActiveCount, 1);
  });
});

test('a completed historical transfer may name only the exact retired deleted Pod and still constrains balance freshness', async () => {
  const s = retiringFixture();
  const historical = s.transfer({ source: { id: s.config.accounts.pod, type: 'POD', isDeleted: true }, destination: actor(roles.income),
    status: 'COMPLETE', createdAt: '2030-01-31T10:00:00.000Z', completedAt: '2030-01-31T12:00:00.000Z' }, false);
  assert.equal((await s.read()).transfers[0].source.isDeleted, true);
  historical.completedAt = '2030-02-01T14:59:00.000Z';
  await rejects(s.read(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
});

test('retirement never relaxes pending actors, current financial roles, other deleted Pods or actor types', async t => {
  const cases = [
    { source: { id: ID(8), type: 'POD', isDeleted: true }, status: 'PENDING' },
    { source: { id: ID(8), type: 'EXTERNAL_ACCOUNT', isDeleted: true } },
    { source: { id: ID(90), type: 'POD', isDeleted: true } },
    { source: { id: roles.emergency, type: 'EXTERNAL_ACCOUNT', isDeleted: true } },
  ];
  for (const patch of cases) await t.test(JSON.stringify(patch), async () => {
    const s = retiringFixture(); s.transfer({ destination: actor(roles.income), status: 'COMPLETE',
      completedAt: '2030-02-01T14:30:00.000Z', ...patch }, false);
    await rejects(s.read(), 'MONTHLY_TRANSFER_HISTORY_INVALID');
  });
});

test('monthly evidence reads every live role and disabled rule without using the Pod or a refund', async () => {
  const s = fixture(), evidence = await s.read();
  assert.equal(evidence.sourceBalanceCents, 900000);
  assert.equal(evidence.sourceCashCents, 900000);
  assert.equal(evidence.sourceSpendableCents, 900000);
  assert.equal(evidence.incomeBalanceUpdatedAt, '2030-02-01T14:59:00.000Z');
  assert.equal(evidence.accountSnapshots.emergency.spendableCents, 1050000);
  assert.equal(evidence.accountSnapshots.personalInvestment.balanceCents, undefined);
  assert.equal(evidence.accountSnapshots.roth.balanceCents, undefined);
  assert.equal(s.calls.some(call => call.id === s.config.accounts.pod), false);
  assert.deepEqual(evidence.nativeRuleStatuses, { funding: 'DISABLED', payout: 'DISABLED', legacyGeneral: 'DISABLED', emergencyFallback: 'DISABLED' });
  assert.deepEqual(s.calls.find(call => call.method === 'listExternalTransactions').options,
    { accountIds: [roles.income], from: s.externalFrom, to: iso(NOW) });
});

test('current and available bank cash remain separate for accounting and spending', async () => {
  const s = fixture(); s.accounts.get(roles.income).balance.availableBalanceInCents = 850000;
  const evidence = await s.read();
  assert.equal(evidence.sourceBalanceCents, 900000);
  assert.equal(evidence.sourceCashCents, 850000);
  assert.equal(evidence.sourceSpendableCents, 850000);
});

test('multiple exact owned pending transfers reserve source cash and count toward target funding', async () => {
  const s = fixture(); s.transfer({ amountInCents: 300000 }); s.transfer({ destination: actor(roles.general), amountInCents: 100000 });
  const evidence = await s.read();
  assert.equal(evidence.pendingSourceDebitCents, 400000);
  assert.equal(evidence.sourceSpendableCents, 500000);
  assert.equal(evidence.accountSnapshots.bills.fundingBalanceCents, 400000);
  assert.equal(evidence.accountSnapshots.general.fundingBalanceCents, 200000);
  assert.equal(evidence.targetPendingIncomingCents.bills, 300000);
});

test('a known Emergency excess return is reserved without becoming new Income before settlement', async () => {
  const s = fixture(); s.transfer({ source: actor(roles.emergency), destination: actor(roles.income), amountInCents: 50000 });
  const evidence = await s.read();
  assert.equal(evidence.pendingIncomeCreditCents, 50000);
  assert.equal(evidence.sourceSpendableCents, 850000);
  assert.equal(evidence.accountSnapshots.emergency.spendableCents, 1000000);
  assert.equal(evidence.accountSnapshots.emergency.fundingBalanceCents, 1050000);
});

test('an incoming commitment never increases refundable Emergency cash', async () => {
  const s = fixture(); s.transfer({ destination: actor(roles.emergency), amountInCents: 200000 });
  const evidence = await s.read();
  assert.equal(evidence.accountSnapshots.emergency.fundingBalanceCents, 1250000);
  assert.equal(evidence.accountSnapshots.emergency.spendableCents, 850000);
});

test('unlinked provider incoming and pending bank credits/debits are reserved separately without assumed matching', async () => {
  const s = fixture(); s.transfer({ source: actor(ID(99)), destination: actor(roles.income), amountInCents: 20000 }, false);
  s.externalRows.push(bankRow({ status: 'PENDING', amountInCents: 20000 }),
    bankRow({ id: ID(101), status: 'PENDING', direction: 'MONEY_OUT', amountInCents: 30000 }));
  const evidence = await s.read();
  assert.equal(evidence.pendingIncomeCreditCents, 20000);
  assert.equal(evidence.pendingExternalIncomeCreditCents, 20000);
  assert.equal(evidence.pendingExternalIncomeDebitCents, 30000);
  assert.equal(evidence.sourceSpendableCents, 830000);
});

test('regular-looking payroll text is returned unchanged and cannot classify an identical-looking bonus', async () => {
  const s = fixture();
  const description = 'SYNTHETIC DFAS NAVY PAY';
  s.externalRows = [bankRow({ amountInCents: 500000, description }), bankRow({ id: ID(101), amountInCents: 400000, description })];
  const evidence = await s.read();
  assert.deepEqual(evidence.externalTransactions.items, s.externalRows);
  assert.equal(evidence.openingRegularCents, undefined);
  assert.equal(evidence.windfallHeldCents, undefined);
  assert.equal(evidence.sourceBalanceCents, 900000);
});

test('unknown Income and Emergency outgoing movements block even if they resemble a recorded request', async t => {
  for (const source of [roles.income, roles.emergency]) await t.test(source, async () => {
    const s = fixture(); s.transfer({ source: actor(source), destination: actor(roles.personalInvestment) }, false);
    await rejects(s.read(), 'MONTHLY_UNKNOWN_OUTGOING');
  });
});

test('an unknown outgoing is not adopted by matching its amount, destination, and time to another owned ID', async () => {
  const s = fixture(); s.transfer(); s.transfers[0].id = ID(999);
  await rejects(s.read(), 'MONTHLY_UNKNOWN_OUTGOING');
});

test('owned transfer amount, route, origin, status and attempt time cannot change', async t => {
  for (const [name, change, code] of [
    ['amount', row => { row.amountInCents += 1; }, 'MONTHLY_OWN_TRANSFER_CHANGED'],
    ['destination', row => { row.destination.id = roles.project; }, 'MONTHLY_OWN_TRANSFER_CHANGED'],
    ['source', row => { row.source.id = ID(99); }, 'MONTHLY_OWN_TRANSFER_CHANGED'],
    ['origin', row => { row.origin = 'RULE'; row.ruleId = ID(11); }, 'MONTHLY_OWN_TRANSFER_CHANGED'],
    ['before attempt', row => { row.createdAt = '2030-02-01T13:59:59.000Z'; }, 'MONTHLY_OWN_TRANSFER_CHANGED'],
    ['failure', row => { row.status = 'ERROR'; row.errorCode = 'SYNTHETIC_ERROR'; }, 'MONTHLY_OWN_TRANSFER_FAILED'],
  ]) await t.test(name, async () => { const s = fixture(); change(s.transfer()); await rejects(s.read(), code); });
});

test('completed owned transfers must already be reconciled in the durable ledger', async () => {
  const s = fixture(); const row = s.transfer(); row.status = 'COMPLETE'; row.completedAt = '2030-02-01T14:30:00.000Z';
  await rejects(s.read(), 'MONTHLY_OWN_TRANSFER_UNRECONCILED');
  s.knownTransfers[0].status = 'COMPLETE'; s.knownTransfers[0].completedAt = row.completedAt;
  assert.equal((await s.read()).pendingSourceDebitCents, 0);
});

test('a missing owned transfer stays reserved through an evidence failure', async () => {
  const s = fixture(); s.transfer(); s.transfers = [];
  await rejects(s.read(), 'MONTHLY_OWN_TRANSFER_MISSING');
});

test('owned transfer records cannot authorize arbitrary accounts or a duplicate identity', async t => {
  await t.test('wrong pair', async () => { const s = fixture(); s.transfer(); s.knownTransfers[0].sourceAccountId = roles.project; await rejects(s.read(), 'MONTHLY_OWN_TRANSFERS_INVALID'); });
  await t.test('duplicate', async () => { const s = fixture(); s.transfer(); s.knownTransfers.push(clone(s.knownTransfers[0])); await rejects(s.read(), 'MONTHLY_OWN_TRANSFERS_INVALID'); });
  await t.test('future first attempt', async () => { const s = fixture(); s.transfer(); s.knownTransfers[0].firstAttemptAt = '2030-02-02T00:00:00.000Z'; await rejects(s.read(), 'MONTHLY_OWN_TRANSFER_TIME_INVALID'); });
});

test('Income and target observations must postdate each affected completed settlement', async () => {
  const s = fixture(); s.transfer({ status: 'COMPLETE', completedAt: '2030-02-01T14:59:00.000Z' });
  await rejects(s.read(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  s.accounts.get(roles.income).balance.balanceLastUpdatedAt = '2030-02-01T14:59:01.000Z';
  await rejects(s.read(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  s.accounts.get(roles.bills).balance.balanceLastUpdatedAt = '2030-02-01T14:59:01.000Z';
  assert.equal((await s.read()).sourceSpendableCents, 900000);
});

test('the shared settlement anchor remains a lower bound for source cash freshness', async () => {
  await rejects(fixture().read({ lastSettledAt: '2030-02-01T14:59:00.000Z' }), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
});

test('complete external activity newer than the bank cash snapshot blocks pool reconciliation', async () => {
  const s = fixture(); s.externalRows = [bankRow({ transactionDate: '2030-02-01T14:59:01.000Z' })];
  await rejects(s.read(), 'INCOME_BALANCE_BEFORE_POSTED_ACTIVITY');
});

test('unavailable, stale and future cash balances block every allocation role', async t => {
  for (const [role, patch, code] of [
    ['income', { availableBalanceInCents: null }, 'BALANCE_UNAVAILABLE'],
    ['bills', { balanceLastUpdatedAt: '2030-01-30T12:00:00.000Z' }, 'BALANCE_TOO_OLD'],
    ['general', { balanceLastUpdatedAt: '2030-02-01T15:00:01.000Z' }, 'BALANCE_TIMESTAMP_UNAVAILABLE'],
    ['emergency', { error: 'unavailable' }, 'BALANCE_UNAVAILABLE'],
    ['project', { balanceInCents: -1 }, 'BALANCE_UNAVAILABLE'],
  ]) await t.test(role, async () => { const s = fixture(); Object.assign(s.accounts.get(roles[role]).balance, patch); await rejects(s.read(), code); });
});

test('account roles remain exact and cannot turn investments into cash or cash into brokerage destinations', async t => {
  for (const [role, patch, code] of [
    ['income', { id: ID(999) }, 'MONTHLY_ACCOUNT_IDENTITY_INVALID'],
    ['income', { type: 'POD' }, 'MONTHLY_ACCOUNT_IDENTITY_INVALID'],
    ['general', { externalAccountType: 'INVESTMENT' }, 'MONTHLY_ACCOUNT_NOT_CASH'],
    ['emergency', { canBeSource: false }, 'MONTHLY_ACCOUNT_CANNOT_SEND'],
    ['project', { canBeDestination: false }, 'MONTHLY_ACCOUNT_CANNOT_RECEIVE'],
    ['personalInvestment', { externalAccountType: 'DEPOSITORY' }, 'MONTHLY_PERSONAL_ACCOUNT_NOT_INVESTMENT'],
    ['roth', { institutionName: 'Different institution' }, 'ROTH_CUSTODIAN_MISMATCH'],
  ]) await t.test(role, async () => { const s = fixture(); Object.assign(s.accounts.get(roles[role]), patch); await rejects(s.read(), code); });
});

test('a role alias collision or accidental Pod destination fails before any provider call', async () => {
  const s = fixture(); s.config.monthly.projectAccountId = s.config.accounts.pod;
  await rejects(s.read(), 'MONTHLY_ACCOUNT_MAPPING_INVALID'); assert.equal(s.calls.length, 0);
});

test('every mapped legacy rule must be disabled before cash evidence is accepted', async t => {
  for (const [name, ruleId] of Object.entries(fixture().config.rules)) await t.test(name, async () => {
    const s = fixture(); s.rules.get(ruleId).status = 'ENABLED';
    await rejects(s.read(), 'MONTHLY_LEGACY_RULE_ENABLED');
    assert.equal(s.calls.some(call => call.method === 'listTransfers'), false);
  });
});

test('missing rules, unknown statuses and a mismatched rule ID fail closed', async t => {
  for (const change of [s => { s.rules.delete(s.config.rules.funding); }, s => { s.rules.get(s.config.rules.funding).status = 'UNKNOWN'; },
    s => { s.rules.get(s.config.rules.funding).id = ID(999); }]) await t.test('invalid native rule', async () => {
      const s = fixture(); change(s); await rejects(s.read(), 'MONTHLY_LEGACY_RULE_IDENTITY_INVALID');
    });
});

test('incomplete transfer and external histories cannot become complete evidence', async t => {
  for (const [field, code] of [['completeTransfers', 'MONTHLY_TRANSFER_HISTORY_INCOMPLETE'], ['completeExternal', 'MONTHLY_EXTERNAL_HISTORY_INCOMPLETE']]) {
    await t.test(field, async () => { const s = fixture(); s[field] = false; await rejects(s.read(), code); });
  }
});

test('clamped or changing external windows require durable coverage repair', async t => {
  for (const [window, code] of [
    [{ from: '2030-01-01T00:00:00.000Z', to: iso(NOW), truncated: true }, 'MONTHLY_EXTERNAL_HISTORY_INCOMPLETE'],
    [{ from: '2030-01-02T00:00:00.000Z', to: iso(NOW), truncated: false }, 'MONTHLY_EXTERNAL_WINDOW_INVALID'],
    [{ from: '2030-01-01T00:00:00.000Z', to: '2030-02-01T14:00:00.000Z', truncated: false }, 'MONTHLY_EXTERNAL_WINDOW_INVALID'],
  ]) await t.test(JSON.stringify(window), async () => { const s = fixture(); s.windowOverride = window; await rejects(s.read(), code); });
});

test('external records require exact account identities, stable ordering, full fields and unique IDs', async t => {
  for (const [name, rows, code] of [
    ['other account', [bankRow({ accountId: roles.bills })], 'MONTHLY_EXTERNAL_TRANSACTION_INVALID'],
    ['missing amount', [bankRow({ amountInCents: undefined })], 'MONTHLY_EXTERNAL_TRANSACTION_INVALID'],
    ['unknown direction', [bankRow({ direction: 'UNKNOWN' })], 'MONTHLY_EXTERNAL_TRANSACTION_INVALID'],
    ['duplicate', [bankRow(), bankRow()], 'MONTHLY_EXTERNAL_HISTORY_CHANGED'],
    ['changed duplicate', [bankRow(), bankRow({ amountInCents: 400000 })], 'MONTHLY_EXTERNAL_HISTORY_CHANGED'],
    ['before window', [bankRow({ transactionDate: '2029-12-31T00:00:00.000Z' })], 'MONTHLY_EXTERNAL_WINDOW_INVALID'],
    ['reversed', [bankRow({ transactionDate: '2030-01-01T00:00:00.000Z' }), bankRow({ id: ID(101) })], 'MONTHLY_EXTERNAL_WINDOW_INVALID'],
  ]) await t.test(name, async () => { const s = fixture(); s.externalRows = rows; await rejects(s.read(), code); });
});

test('unrequested or repeated transfer rows cannot silently alter cash coverage', async t => {
  await t.test('wrong accounts', async () => { const s = fixture(); s.transfer({ source: actor(ID(98)), destination: actor(ID(99)) }, false); await rejects(s.read(), 'MONTHLY_TRANSFER_HISTORY_INVALID'); });
  await t.test('duplicate', async () => { const s = fixture(); const row = s.transfer(); s.transfers.push(clone(row)); await rejects(s.read(), 'MONTHLY_TRANSFER_HISTORY_CHANGED'); });
  await t.test('simulation', async () => { const s = fixture(); s.transfer({ executionMode: 'SIMULATION' }); await rejects(s.read(), 'MONTHLY_TRANSFER_HISTORY_INVALID'); });
});

test('monthly Roth route proof does not require the obsolete native savings rule to be enabled', async () => {
  const s = fixture(), evidence = await s.read();
  assert.equal(s.checkRoth(evidence).routeVerified, true);
});

test('unknown Roth credits invalidate only the feature-specific contribution check', async t => {
  for (const [status, code] of [['PENDING', 'ROTH_UNKNOWN_CONTRIBUTION_PENDING'], ['COMPLETE', 'ROTH_OUTSIDE_CONTRIBUTIONS_CHANGED']]) {
    await t.test(status, async () => {
      const s = fixture(); s.transfer({ source: actor(ID(99)), destination: actor(roles.roth), status,
        completedAt: status === 'COMPLETE' ? '2030-02-01T14:30:00.000Z' : null }, false);
      const evidence = await s.read();
      assert.equal(evidence.sourceSpendableCents, 900000);
      assert.throws(() => s.checkRoth(evidence), { code });
    });
  }
});

test('owned pending and completed Roth requests remain compatible with separately reserved annual room', async t => {
  for (const status of ['PENDING', 'COMPLETE']) await t.test(status, async () => {
    const s = fixture(); s.transfer({ destination: actor(roles.roth), status,
      completedAt: status === 'COMPLETE' ? '2030-02-01T14:30:00.000Z' : null });
    assert.equal(s.checkRoth(await s.read()).routeVerified, true);
  });
});

test('unverified or redirected Roth route proof cannot authorize a contribution', async t => {
  for (const [name, change, code] of [
    ['unverified', proof => { proof.route = { status: 'unverified' }; }, 'ROTH_ROUTE_UNVERIFIED'],
    ['redirected', proof => { proof.route.destinationAccountId = ID(99); }, 'ROTH_ROUTE_MISMATCH'],
  ]) await t.test(name, async () => { const s = fixture(); change(s.rothProof); const evidence = await s.read();
    assert.throws(() => s.checkRoth(evidence), { code }); });
});
