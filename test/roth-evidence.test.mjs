import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuleFingerprint, parseRothEvidence, rothFundingPlan, validateRothDestination } from '../lib/roth-evidence.mjs';
import { validateAccount } from '../lib/evidence.mjs';

// Entirely synthetic identifiers, institutions' public names, and cash amounts.
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2030-01-01T15:00:00.000Z');
const iso = n => new Date(n).toISOString();
const clone = value => structuredClone(value);
const ACTORS = { income: ID(1), pod: ID(2), bills: ID(3), general: ID(4), project: ID(5), roth: ID(6) };
const actor = (id, type = 'EXTERNAL_ACCOUNT') => ({ id, type, isDeleted: false });

function cash(id, value, at = iso(NOW - 60_000)) {
  return { id, type: 'EXTERNAL_ACCOUNT', externalAccountType: 'DEPOSITORY', deletedAt: null,
    canBeSource: true, canBeDestination: true,
    balance: { balanceInCents: value, availableBalanceInCents: value, holdInCents: null,
      balanceLastUpdatedAt: at, error: null } };
}

function percentage(destination, type, amount) {
  return { type: 'PERCENTAGE', source: { id: ACTORS.income, type: 'EXTERNAL_ACCOUNT', name: 'Synthetic income' },
    destination: { id: destination, type, name: 'Synthetic savings' }, groupIndex: 0,
    upToEnabled: false, limit: null, achDescription: 'SAVE', isDirectDeposit: false,
    percentageValue: amount, percentageTarget: 'SOURCE_ACCOUNT' };
}

function fixture() {
  const config = { accounts: { income: ACTORS.income, pod: ACTORS.pod, bills: ACTORS.bills, general: ACTORS.general },
    roth: { enabled: true, accountId: ACTORS.roth }, rules: { funding: ID(11), payout: ID(12) },
    activationAt: '2030-01-01T00:00:00.000Z', incomeReserveCents: 10000,
    maxBalanceAgeMs: 26 * 3600000, billsBufferCents: 50000,
    calculatedBillsTarget: { targetCents: 50000 },
    allocations: [{ id: 'bills', destinationAccountId: ACTORS.bills, targetCents: 50000, priority: 0, enabled: true }] };
  const rule = { id: config.rules.funding, name: 'Synthetic funding', status: 'ENABLED', deletedAt: null,
    trigger: { type: 'SCHEDULED', scheduleType: 'BI_WEEKLY', startDate: '2029-01-01T14:00:00.000Z', accountId: ACTORS.income },
    steps: [{ conditions: { all: [{ condition: { fact: 'BALANCE', operator: 'GREATER_THAN', value: 0, valueFact: null,
      params: { accountId: ACTORS.income } } }] }, actions: [percentage(ACTORS.pod, 'POD', 7.5), percentage(ACTORS.project, 'EXTERNAL_ACCOUNT', 5)] },
    { actions: [percentage(ACTORS.project, 'EXTERNAL_ACCOUNT', 5)] }] };
  const run = { id: ID(20), ruleId: config.rules.funding, createdAt: '2030-01-01T14:00:00.000Z',
    status: 'IN_PROGRESS', executionMode: 'LIVE', triggerDetails: { type: 'SCHEDULED' },
    conditionsNotMet: false, stepIndexMatched: 0, transfersAttempted: 2, transfersCompleted: 0,
    transfersPending: 2, transfersFailed: 0, transferIds: [ID(30), ID(31)], errorMessage: null, nextAttemptAt: null };
  const transfers = new Map([
    [ID(30), { id: ID(30), amountInCents: 7500, source: actor(ACTORS.income), destination: actor(ACTORS.pod, 'POD'),
      origin: 'RULE', ruleId: rule.id, ruleExecutionId: run.id, status: 'PENDING', executionMode: 'LIVE',
      createdAt: '2030-01-01T14:00:01.000Z', completedAt: null, errorCode: null }],
    [ID(31), { id: ID(31), amountInCents: 5000, source: actor(ACTORS.income), destination: actor(ACTORS.project),
      origin: 'RULE', ruleId: rule.id, ruleExecutionId: run.id, status: 'PROCESSING', executionMode: 'LIVE',
      createdAt: '2030-01-01T14:00:02.000Z', completedAt: null, errorCode: null }],
  ]);
  const accounts = new Map([
    [ACTORS.income, cash(ACTORS.income, 500000)], [ACTORS.bills, cash(ACTORS.bills, 50000)],
    [ACTORS.roth, { id: ACTORS.roth, type: 'EXTERNAL_ACCOUNT', externalAccountType: 'INVESTMENT', deletedAt: null,
      institutionName: 'Fidelity', canBeSource: false, canBeDestination: true }],
    // The Pod is deliberately nonempty. No Roth cash decision should read it.
    [ACTORS.pod, { id: ACTORS.pod, type: 'POD', balance: { balanceInCents: 999999, availableBalanceInCents: 999999 } }],
  ]);
  const evidence = { schemaVersion: 1, updatedAt: '2029-12-31T12:00:00.000Z',
    route: { status: 'verified', sourceAccountId: ACTORS.income, destinationAccountId: ACTORS.roth,
      custodian: 'fidelity', contributionYear: 'current_calendar_year', verifiedAt: '2029-12-31T12:00:00.000Z', reference: 'Synthetic route attestation' },
    upstream: { status: 'verified', ruleId: rule.id, definitionHash: nativeRuleFingerprint(rule),
      verifiedAt: '2029-12-31T12:00:00.000Z', reference: 'Synthetic reviewed funding definition' } };
  const s = { config, rule, run, evidence, transfers, accounts, executions: new Map([[run.id, run]]), now: NOW,
    completeNative: true, completeTransfers: true, historyOverride: null, calls: [] };
  s.client = {
    async getRule(id) { s.calls.push({ method: 'getRule', id }); return clone(s.rule); },
    async getRuleExecution(ruleId, id) { s.calls.push({ method: 'getRuleExecution', ruleId, id }); return clone(s.executions.get(id)); },
    async getTransfer(id) { s.calls.push({ method: 'getTransfer', id }); return clone(s.transfers.get(id)); },
    async getAccount(id) { s.calls.push({ method: 'getAccount', id }); return clone(s.accounts.get(id)); },
    async listRuleExecutions(options) {
      s.calls.push({ method: 'listRuleExecutions', options });
      return { complete: s.completeNative, items: clone([...s.executions.values()].filter(row => row.ruleId === options.ruleId &&
        row.executionMode === options.executionMode && Date.parse(row.createdAt) >= Date.parse(options.from) && Date.parse(row.createdAt) <= Date.parse(options.to))) };
    },
    async listTransfers(options) { s.calls.push({ method: 'listTransfers', options });
      return { complete: s.completeTransfers, items: clone(s.historyOverride ?? [...s.transfers.values()]) }; },
  };
  s.plan = (amount = 62500, options = {}) => rothFundingPlan(s.client, s.config, s.evidence, amount,
    { now: s.now, outsideContributionsVerifiedAt: '2030-01-01T00:00:00.000Z', ...options });
  s.addTransfer = (overrides = {}) => {
    const transfer = { id: ID(40), amountInCents: 2000, source: actor(ACTORS.pod, 'POD'), destination: actor(ACTORS.income),
      origin: 'RULE', ruleId: config.rules.payout, ruleExecutionId: ID(21), status: 'PENDING', executionMode: 'LIVE',
      createdAt: '2030-01-01T14:20:00.000Z', completedAt: null, errorCode: null, ...overrides };
    s.transfers.set(transfer.id, transfer);
    return transfer;
  };
  s.completeNativeRun = (at = '2030-01-01T14:30:00.000Z') => {
    Object.assign(run, { status: 'EXECUTED', transfersCompleted: 2, transfersPending: 0 });
    for (const id of run.transferIds) Object.assign(transfers.get(id), { status: 'COMPLETE', completedAt: at });
  };
  return s;
}

const rejects = (work, code) => assert.rejects(work, error => error?.code === code);

test('a fully known native pending action set permits the complete installment without a refund or empty Pod', async () => {
  const s = fixture(), result = await s.plan();
  assert.equal(result.amountInCents, 62500);
  assert.equal(result.pendingNativeCents, 12500);
  assert.equal(result.protectedIncomeCents, 22500);
  assert.equal(result.usableIncomeCents, 477500);
  assert.equal(result.nativeCycleAt, '2030-01-01T14:00:00.000Z');
  assert.deepEqual(result.nativeExecutionIds, [s.run.id]);
  assert.equal(result.reason, 'READY');
  assert.equal(s.calls.some(call => call.method === 'getAccount' && call.id === ACTORS.pod), false);
  assert.equal(s.calls.some(call => call.method === 'getRule' && call.id === s.config.rules.payout), false);
});

test('activation at 14:30 includes the native savings run before activation', async () => {
  const s = fixture(); s.config.activationAt = '2030-01-01T14:30:00.000Z';
  assert.equal((await s.plan()).amountInCents, 62500);
  assert.equal(s.calls.find(call => call.method === 'listRuleExecutions').options.from, '2030-01-01T14:00:00.000Z');
});

test('a pending Pod refund does not block but is never counted as spendable future money', async () => {
  const s = fixture(); s.addTransfer({ amountInCents: 40000 });
  const plan = await s.plan();
  assert.equal(plan.amountInCents, 62500);
  assert.equal(plan.pendingIncomeCreditsCents, 40000);
  assert.equal(plan.usableIncomeCents, 437500);
});

test('the smaller available cash value and Bills deficit protect Income cash', async () => {
  const s = fixture();
  s.accounts.get(ACTORS.income).balance.availableBalanceInCents = 100000;
  s.accounts.get(ACTORS.bills).balance.availableBalanceInCents = 20000;
  const plan = await s.plan();
  assert.equal(plan.billsShortfallCents, 30000);
  assert.equal(plan.usableIncomeCents, 47500);
  assert.equal(plan.amountInCents, 0);
  assert.equal(plan.reason, 'CASH_INSUFFICIENT');
});

test('pending Bills debits lower the protected Bills cash instead of inflating spendable Income', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ACTORS.bills), destination: actor(ID(99)), amountInCents: 20000 });
  const plan = await s.plan();
  assert.equal(plan.pendingBillsCents, 20000);
  assert.equal(plan.billsShortfallCents, 20000);
  assert.equal(plan.usableIncomeCents, 457500);
});

test('less than a complete installment produces no partial contribution', async () => {
  const s = fixture(); s.accounts.set(ACTORS.income, cash(ACTORS.income, 84999));
  const plan = await s.plan();
  assert.equal(plan.usableIncomeCents, 62499);
  assert.equal(plan.amountInCents, 0);
  assert.equal(plan.reason, 'CASH_INSUFFICIENT');
});

test('exact remaining cash funds the complete installment', async () => {
  const s = fixture(); s.accounts.set(ACTORS.income, cash(ACTORS.income, 85000));
  assert.equal((await s.plan()).amountInCents, 62500);
});

test('amounts below the transfer provider minimum stay zero', async () => {
  const plan = await fixture().plan(99);
  assert.equal(plan.amountInCents, 0); assert.equal(plan.reason, 'BELOW_PROVIDER_MINIMUM');
});

test('unknown pending Income outflows block even when cash looks ample', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ACTORS.income), destination: actor(ACTORS.general), origin: 'USER', ruleId: null, ruleExecutionId: null });
  await rejects(s.plan(), 'ROTH_UNKNOWN_INCOME_OUTGOING');
});

test('a pending Roth contribution from another source blocks contribution duplication', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ID(99)), destination: actor(ACTORS.roth), origin: 'USER', ruleId: null, ruleExecutionId: null });
  await rejects(s.plan(), 'ROTH_UNKNOWN_CONTRIBUTION_PENDING');
});

test('completed native debits require an Income observation after their settlement', async () => {
  const s = fixture(); s.completeNativeRun();
  s.accounts.get(ACTORS.income).balance.balanceLastUpdatedAt = '2030-01-01T14:29:00.000Z';
  await rejects(s.plan(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  s.accounts.get(ACTORS.income).balance.balanceLastUpdatedAt = '2030-01-01T14:31:00.000Z';
  const plan = await s.plan(); assert.equal(plan.amountInCents, 62500); assert.equal(plan.pendingNativeCents, 0);
});

test('all other completed Income movements also require a post-settlement cash observation', async () => {
  const s = fixture(); s.addTransfer({ status: 'COMPLETE', completedAt: '2030-01-01T14:59:00.000Z' });
  await rejects(s.plan(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
});

test('the shared coordinator settlement anchor protects source cash across features', async () => {
  const s = fixture(); await rejects(s.plan(62500, { lastSettledAt: '2030-01-01T14:59:00.000Z' }), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
});

test('Bills cash independently must postdate Bills settlements', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ID(99)), destination: actor(ACTORS.bills), status: 'COMPLETE', completedAt: '2030-01-01T14:59:00.000Z' });
  await rejects(s.plan(), 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
});

test('stale, future, errored and missing available bank balances block cash planning', async t => {
  for (const [label, change, code] of [
    ['stale', { balanceLastUpdatedAt: '2029-12-30T12:00:00.000Z' }, 'BALANCE_TOO_OLD'],
    ['future', { balanceLastUpdatedAt: '2030-01-01T15:01:00.000Z' }, 'BALANCE_TIMESTAMP_UNAVAILABLE'],
    ['error', { error: 'unavailable' }, 'BALANCE_UNAVAILABLE'],
    ['missing available', { availableBalanceInCents: null }, 'BALANCE_UNAVAILABLE'],
  ]) await t.test(label, async () => { const s = fixture(); Object.assign(s.accounts.get(ACTORS.income).balance, change); await rejects(s.plan(), code); });
});

test('the IRA value is neither a cash source nor a contribution-room input', () => {
  const s = fixture(), destination = s.accounts.get(ACTORS.roth);
  assert.equal(validateRothDestination(destination, ACTORS.roth), destination);
  assert.throws(() => validateAccount(destination, ACTORS.roth, 'destination'), { code: 'ACCOUNT_IS_NOT_CASH' });
});

test('retirement routing requires the exact investment destination and recipient capability', async t => {
  for (const [label, change, code] of [
    ['identity', { id: ID(99) }, 'ROTH_DESTINATION_IDENTITY_INVALID'],
    ['deleted', { deletedAt: '2030-01-01T00:00:00.000Z' }, 'ROTH_DESTINATION_IDENTITY_INVALID'],
    ['deposit account', { externalAccountType: 'DEPOSITORY' }, 'ROTH_DESTINATION_NOT_INVESTMENT'],
    ['cannot receive', { canBeDestination: false }, 'ROTH_DESTINATION_CANNOT_RECEIVE'],
    ['custodian', { institutionName: 'Different custodian' }, 'ROTH_CUSTODIAN_MISMATCH'],
  ]) await t.test(label, async () => { const s = fixture(); Object.assign(s.accounts.get(ACTORS.roth), change); await rejects(s.plan(), code); });
});

test('native percentage commitments must be present before the Roth contribution', async () => {
  const s = fixture(); s.executions.clear();
  await rejects(s.plan(), 'ROTH_NATIVE_SCHEDULED_RUN_NOT_OBSERVED');
});

test('manual and API funding runs do not stand in for the scheduled cycle', async t => {
  for (const type of ['MANUAL', 'SEQUENCE_API', 'REMOTE_API']) await t.test(type, async () => {
    const s = fixture(); s.run.triggerDetails.type = type;
    await rejects(s.plan(), 'ROTH_NATIVE_SCHEDULED_RUN_NOT_OBSERVED');
  });
});

test('an early invocation on the 1st or 15th cannot spend against the previous savings cycle', async t => {
  for (const now of ['2030-01-01T13:59:59.000Z', '2030-01-15T13:59:59.000Z']) await t.test(now, async () => {
    const s = fixture(); s.now = Date.parse(now);
    await rejects(s.plan(), 'ROTH_NATIVE_CYCLE_NOT_STARTED');
  });
});

test('a retry on the 15th waits for that new native run instead of reusing the 1st', async () => {
  const s = fixture(); s.now = Date.parse('2030-01-15T15:00:00.000Z');
  await rejects(s.plan(), 'ROTH_NATIVE_SCHEDULED_RUN_NOT_OBSERVED');
});

test('the latest 15th run is inspected alongside older pending native commitments', async () => {
  const s = fixture(); s.now = Date.parse('2030-01-15T15:00:00.000Z');
  const later = clone(s.run);
  Object.assign(later, { id: ID(22), createdAt: '2030-01-15T14:00:00.000Z', transferIds: [ID(32), ID(33)] });
  s.executions.set(later.id, later);
  for (let n = 0; n < 2; n++) {
    const transfer = clone(s.transfers.get(ID(30 + n)));
    Object.assign(transfer, { id: ID(32 + n), ruleExecutionId: later.id, createdAt: `2030-01-15T14:00:0${n + 1}.000Z` });
    s.transfers.set(transfer.id, transfer);
  }
  for (const id of [ACTORS.income, ACTORS.bills]) s.accounts.get(id).balance.balanceLastUpdatedAt = '2030-01-15T14:59:00.000Z';
  const plan = await s.plan();
  assert.equal(plan.amountInCents, 62500); assert.equal(plan.pendingNativeCents, 25000);
  assert.equal(plan.nativeCycleAt, '2030-01-15T14:00:00.000Z');
});

test('a disabled native rule is a staging block', async () => {
  const s = fixture(); s.rule.status = 'DISABLED'; await rejects(s.plan(), 'ROTH_NATIVE_RULE_DISABLED');
});

test('changing the native percentage, condition, destination or schedule invalidates approved evidence', async t => {
  const changes = [
    ['percentage', s => { s.rule.steps[0].actions[0].percentageValue = 8; }, 'ROTH_NATIVE_RULE_CHANGED'],
    ['condition', s => { s.rule.steps[0].conditions.all[0].condition.value = 100; }, 'ROTH_NATIVE_RULE_CHANGED'],
    ['destination', s => { s.rule.steps[0].actions[0].destination.id = ID(99); }, 'ROTH_NATIVE_RULE_CHANGED'],
    ['schedule', s => { s.rule.trigger.startDate = '2029-01-01T13:00:00.000Z'; }, 'ROTH_NATIVE_SCHEDULE_UNSUPPORTED'],
  ];
  for (const [label, change, code] of changes) await t.test(label, async () => { const s = fixture(); change(s); await rejects(s.plan(), code); });
});

test('cosmetic rule and account names and enablement are excluded from the financial fingerprint', () => {
  const s = fixture(), hash = nativeRuleFingerprint(s.rule);
  s.rule.name = 'Renamed'; s.rule.status = 'DISABLED';
  s.rule.steps[0].actions[0].source.name = 'Renamed source'; s.rule.steps[1].actions[0].destination.name = 'Renamed destination';
  assert.equal(nativeRuleFingerprint(s.rule), hash);
});

test('an observed native run with only one of two actions represented is unsafe', async () => {
  const s = fixture(); s.run.transferIds.pop(); s.run.transfersAttempted = 1; s.run.transfersPending = 1;
  await rejects(s.plan(), 'ROTH_NATIVE_ACTIONS_INCOMPLETE');
});

test('a matched fallback step permits its one fully known Project action', async () => {
  const s = fixture(); Object.assign(s.run, { stepIndexMatched: 1, transferIds: [ID(31)], transfersAttempted: 1, transfersPending: 1 });
  s.transfers.delete(ID(30)); const plan = await s.plan();
  assert.equal(plan.amountInCents, 62500); assert.equal(plan.pendingNativeCents, 5000);
});

test('an explicitly completed no-match run has no unrepresented savings commitments', async () => {
  const s = fixture(); Object.assign(s.run, { status: 'EXECUTED', stepIndexMatched: null, conditionsNotMet: true,
    transfersAttempted: 0, transfersCompleted: 0, transfersPending: 0, transferIds: [] });
  s.transfers.clear(); const plan = await s.plan();
  assert.equal(plan.amountInCents, 62500); assert.equal(plan.pendingNativeCents, 0);
});

test('no-match claims with an attempted or matched action cannot hide an unresolved debit', async () => {
  const s = fixture(); s.run.conditionsNotMet = true;
  await rejects(s.plan(), 'ROTH_NATIVE_COUNTS_INVALID');
});

test('a pending native retry blocks even when the existing transfer set is known', async () => {
  const s = fixture(); s.run.nextAttemptAt = '2030-01-01T16:00:00.000Z';
  await rejects(s.plan(), 'ROTH_NATIVE_RETRY_UNRESOLVED');
});

test('failed, partial and unknown native executions block financial execution', async t => {
  for (const status of ['FAILED', 'PARTIAL', 'APPROVAL_DENIED', 'UNRECOGNIZED']) await t.test(status, async () => {
    const s = fixture(); s.run.status = status;
    await rejects(s.plan(), status === 'UNRECOGNIZED' ? 'ROTH_NATIVE_EXECUTION_STATUS_UNKNOWN' : 'ROTH_NATIVE_EXECUTION_FAILED');
  });
});

test('native transfer errors and unknown action linkages block', async t => {
  for (const [label, change, code] of [
    ['error', row => { row.status = 'ERROR'; row.errorCode = 'failure'; }, 'ROTH_NATIVE_TRANSFER_INVALID'],
    ['wrong destination', row => { row.destination.id = ID(99); }, 'ROTH_NATIVE_TRANSFER_INVALID'],
    ['wrong execution', row => { row.ruleExecutionId = ID(99); }, 'ROTH_NATIVE_TRANSFER_INVALID'],
    ['unexpected completed timestamp', row => { row.completedAt = '2030-01-01T14:30:00.000Z'; }, 'ROTH_NATIVE_TRANSFER_FAILED'],
  ]) await t.test(label, async () => { const s = fixture(); change(s.transfers.get(ID(30))); await rejects(s.plan(), code); });
});

test('incomplete native or transfer histories block safe cash planning', async t => {
  for (const [field, code] of [['completeNative', 'ROTH_NATIVE_HISTORY_INCOMPLETE'], ['completeTransfers', 'ROTH_TRANSFER_HISTORY_INCOMPLETE']]) {
    await t.test(field, async () => { const s = fixture(); s[field] = false; await rejects(s.plan(), code); });
  }
});

test('every represented native commitment must appear in exhaustive Income history', async () => {
  const s = fixture(); s.historyOverride = [s.transfers.get(ID(30))];
  await rejects(s.plan(), 'ROTH_NATIVE_TRANSFER_MISSING');
});

test('an immutable native transfer change across reads blocks', async () => {
  const s = fixture(); s.historyOverride = clone([...s.transfers.values()]); s.historyOverride[0].amountInCents += 1;
  await rejects(s.plan(), 'ROTH_NATIVE_TRANSFER_CHANGED');
});

test('a native transfer that settles between reads requires fresh cash without a duplicate pending reserve', async () => {
  const s = fixture(); s.historyOverride = clone([...s.transfers.values()]);
  Object.assign(s.historyOverride[0], { status: 'COMPLETE', completedAt: '2030-01-01T14:58:00.000Z' });
  const plan = await s.plan(); assert.equal(plan.amountInCents, 62500); assert.equal(plan.pendingNativeCents, 5000);
});

test('duplicate transfer history rows cannot silently double count or mask inconsistent pagination', async () => {
  const s = fixture(); s.historyOverride = [...s.transfers.values(), s.transfers.get(ID(30))];
  await rejects(s.plan(), 'ROTH_TRANSFER_HISTORY_CHANGED');
});

test('evidence parsing is strict and canonicalizes private UUIDs and UTC timestamps', () => {
  const s = fixture(); s.evidence.updatedAt = '2029-12-31T12:00:00Z';
  assert.equal(parseRothEvidence(JSON.stringify(s.evidence)).updatedAt, '2029-12-31T12:00:00.000Z');
  assert.deepEqual(parseRothEvidence({ schemaVersion: 1, updatedAt: '2029-12-31T12:00:00Z',
    route: { status: 'unverified' }, upstream: { status: 'unverified' } }).route, { status: 'unverified' });
  s.evidence.route.taxYear = 2030;
  assert.throws(() => parseRothEvidence(s.evidence), { code: 'ROTH_EVIDENCE_INVALID' });
});

test('unverified route or upstream proofs block Roth only', async t => {
  for (const [field, code] of [['route', 'ROTH_ROUTE_UNVERIFIED'], ['upstream', 'ROTH_NATIVE_PROOF_UNVERIFIED']]) {
    await t.test(field, async () => { const s = fixture(); s.evidence[field] = { status: 'unverified' }; await rejects(s.plan(), code); });
  }
});

test('evidence cannot redirect the configured source, destination or native rule', async t => {
  for (const [field, key, code] of [['route', 'sourceAccountId', 'ROTH_ROUTE_MISMATCH'], ['route', 'destinationAccountId', 'ROTH_ROUTE_MISMATCH'],
    ['upstream', 'ruleId', 'ROTH_NATIVE_PROOF_MISMATCH']]) await t.test(key, async () => {
      const s = fixture(); s.evidence[field][key] = ID(99); await rejects(s.plan(), code);
    });
});

test('future and invalid-calendar evidence timestamps fail closed', async t => {
  await t.test('future attestation', async () => { const s = fixture(); s.evidence.updatedAt = '2030-01-02T00:00:00.000Z'; await rejects(s.plan(), 'ROTH_EVIDENCE_TIME_INVALID'); });
  await t.test('invalid date', () => { const s = fixture(); s.evidence.updatedAt = '2030-02-31T00:00:00.000Z'; assert.throws(() => parseRothEvidence(s.evidence), { code: 'ROTH_EVIDENCE_TIME_INVALID' }); });
  await t.test('proof after envelope', () => { const s = fixture(); s.evidence.route.verifiedAt = '2030-01-01T00:00:00.000Z'; assert.throws(() => parseRothEvidence(s.evidence), { code: 'ROTH_EVIDENCE_TIME_INVALID' }); });
});

test('an unavailable Bills target blocks rather than silently removing its reserve', async () => {
  const s = fixture(); s.config.billsBufferCents = 0; await rejects(s.plan(), 'BILLS_TARGET_UNAVAILABLE');
});

test('unknown completed Roth credits after the attested outside baseline invalidate contribution room', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ID(99)), destination: actor(ACTORS.roth), status: 'COMPLETE',
    origin: 'USER', ruleId: null, ruleExecutionId: null, completedAt: '2030-01-01T14:30:00.000Z' });
  await rejects(s.plan(), 'ROTH_OUTSIDE_CONTRIBUTIONS_CHANGED');
});

test('an older outside Roth credit is covered by a later attested baseline', async () => {
  const s = fixture(); s.addTransfer({ source: actor(ID(99)), destination: actor(ACTORS.roth), status: 'COMPLETE',
    origin: 'USER', ruleId: null, ruleExecutionId: null,
    createdAt: '2029-12-31T12:00:00.000Z', completedAt: '2029-12-31T13:00:00.000Z' });
  assert.equal((await s.plan()).amountInCents, 62500);
});

function settledOwnContribution(s) {
  const transfer = s.addTransfer({ source: actor(ACTORS.income), destination: actor(ACTORS.roth), amountInCents: 62500,
    status: 'COMPLETE', origin: 'USER', ruleId: null, ruleExecutionId: null, completedAt: '2030-01-01T14:30:00.000Z' });
  return { transferId: transfer.id, sourceAccountId: ACTORS.income, destinationAccountId: ACTORS.roth,
    amountInCents: transfer.amountInCents, status: 'COMPLETE', firstAttemptAt: '2030-01-01T14:19:59.000Z', completedAt: transfer.completedAt };
}

test('known completed contributions match the immutable coordinator request before being accepted', async () => {
  const s = fixture(), own = settledOwnContribution(s);
  assert.equal((await s.plan(62500, { ownTransfers: [own] })).amountInCents, 62500);
});

test('a provider completed credit must agree with its owned amount, origin and timing', async t => {
  for (const [label, change, code] of [
    ['amount', transfer => { transfer.amountInCents += 1; }, 'ROTH_OWN_CONTRIBUTION_CHANGED'],
    ['source', transfer => { transfer.source.id = ID(99); }, 'ROTH_OWN_CONTRIBUTION_CHANGED'],
    ['origin', transfer => { transfer.origin = 'RULE'; transfer.ruleId = ID(99); }, 'ROTH_OWN_CONTRIBUTION_CHANGED'],
    ['before attempt', transfer => { transfer.createdAt = '2030-01-01T14:19:58.000Z'; }, 'ROTH_OWN_CONTRIBUTION_CHANGED'],
    ['completion', transfer => { transfer.completedAt = '2030-01-01T14:31:00.000Z'; }, 'ROTH_OWN_CONTRIBUTION_UNRECONCILED'],
  ]) await t.test(label, async () => {
    const s = fixture(), own = settledOwnContribution(s); change(s.transfers.get(own.transferId));
    await rejects(s.plan(62500, { ownTransfers: [own] }), code);
  });
});

test('a known pending contribution that just settled needs ledger reconciliation before another installment', async () => {
  const s = fixture(), own = settledOwnContribution(s); own.status = 'PENDING'; own.completedAt = null;
  await rejects(s.plan(62500, { ownTransfers: [own] }), 'ROTH_OWN_CONTRIBUTION_UNRECONCILED');
});

test('a missing, future or malformed outside-contribution timestamp does not authorize fresh contributions', async t => {
  for (const stamp of [null, '2030-01-02T00:00:00.000Z', '2030-02-31T00:00:00.000Z']) await t.test(String(stamp), async () => {
    await rejects(fixture().plan(62500, { outsideContributionsVerifiedAt: stamp }), 'ROTH_CONTRIBUTION_BASELINE_UNVERIFIED');
  });
});
