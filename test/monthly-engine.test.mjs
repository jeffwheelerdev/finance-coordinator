import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMonthly, previewMonthly, summarizeMonthlyState, summarizeMonthlyRoth, monthlyOwnedTransfers, validateMonthlyState } from '../lib/monthly-engine.mjs';
import { initialState } from '../lib/engine.mjs';
import { monthlyFixture as fixture, START } from './monthly-fixture.mjs';
import { ID, asISO, makeConfig, transferRecord, StoreConflict } from './fixtures.mjs';

const cycle = (s, key = '2030-01') => s.store.value.monthly.cycles[key];
const noMoney = s => assert.equal(s.client.creates.length, 0);

test('one frozen monthly plan reserves strict priorities before multiple independently pending transfers', async () => {
  const s = fixture();
  const seen = [];
  s.client.onCreate = intent => {
    const own = monthlyOwnedTransfers(s.store.value).find(row => row.amountInCents === intent.request.amountInCents && row.destinationAccountId === intent.request.destinationAccountId);
    assert.ok(own); assert.equal(own.status, 'SUBMITTING');
    const previous = seen.at(-1);
    if (previous) assert.equal(previous.status, 'PENDING');
    seen.push(s.client.acceptIntent(intent));
    return seen.at(-1);
  };
  const result = await s.run();
  assert.equal(result.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.equal(result.submitted, 6);
  assert.deepEqual(s.client.creates.map(row => row.request.destinationAccountId), [s.config.accounts.bills, s.config.accounts.general,
    s.config.accounts.emergency, s.config.roth.accountId, s.config.monthly.projectAccountId, s.config.monthly.personalAccountId]);
  assert.deepEqual(s.client.creates.map(row => row.request.amountInCents), [40000, 200000, 75000, 62500, 50000, 562500]);
  assert.equal(cycle(s).plan.openingRegularCents, 1000000);
  assert.equal(cycle(s).plan.percentageTargets.projectCents, 50000);
  assert.equal(s.store.value.active, null);
  assert.equal(summarizeMonthlyState({ config: s.config, state: s.store.value, now: s.clock.value }).pendingTransfers, 6);
  assert.deepEqual(s.store.value.events, {});
});

test('repeated first-day runs and settlement never duplicate a cycle or spend later-arriving money', async () => {
  const s = fixture(); await s.run();
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_PENDING');
  s.settleAll(); assert.equal((await s.run()).code, 'MONTHLY_CYCLE_COMPLETE');
  const plan = structuredClone(cycle(s).plan);
  s.deposit(300000); await s.run();
  assert.equal(s.client.creates.length, 6);
  assert.deepEqual(cycle(s).plan, plan);
  assert.equal(s.store.value.monthly.income.lastBalanceCents, 310000);
});

test('preview and forced observation cannot claim a plan, reserve money, or send alerts', async t => {
  for (const method of ['preview', 'observe', 'force']) await t.test(method, async () => {
    const s = fixture({ mode: method === 'observe' ? 'observe' : 'live' });
    const result = method === 'preview' ? await previewMonthly(s.args()) : await s.run({ forceObserve: method === 'force' });
    assert.equal(result.code, 'READ_ONLY_MONTHLY_PLAN');
    assert.equal(result.plan.allocations.find(row => row.allocationId === 'roth-ira').amountInCents, 62500);
    assert.deepEqual(s.store.value?.monthly?.cycles ?? {}, {});
    assert.deepEqual(s.store.value?.monthly?.obligations ?? {}, {});
    assert.equal(s.store.value?.monthly?.activationAt ?? null, null);
    assert.equal(s.sent.length, 0); noMoney(s);
    if (method === 'preview') assert.equal(s.store.writes.length, 0);
  });
});

test('partial Roth uses available normal cash, records the deficit once, and immediately queues a deduplicated alert', async () => {
  const s = fixture({ regular: 100000, bills: 50000, general: 300000, emergency: 1000000 });
  s.config = makeConfig({ ...s.config, incomeReserveCents: 50000 });
  const result = await s.run();
  assert.equal(result.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.equal(s.client.creates.length, 1); assert.equal(s.client.creates[0].request.amountInCents, 50000);
  const shortfall = s.sent.find(row => row.code === 'ROTH_CASH_SHORTFALL');
  assert.equal(shortfall.shortfallCents, 12500);
  const counts = [s.sent.length, s.client.creates.length];
  await s.run(); assert.deepEqual([s.sent.length, s.client.creates.length], counts);
  assert.equal(cycle(s).children['project-savings'].amountInCents, 0);
  assert.equal(cycle(s).children['personal-investment'].amountInCents, 0);
});

test('same-year Roth catch-up attributes old and current obligations without double counting Project targets', async () => {
  const s = fixture({ regular: 100000, bills: 50000, general: 300000, emergency: 1000000 });
  s.config = makeConfig({ ...s.config, incomeReserveCents: 50000 });
  await s.run(); s.settleAll(); await s.run();
  s.advance('2030-02-01T15:00:00.000Z'); s.deposit(100000);
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const feb = cycle(s, '2030-02');
  assert.equal(feb.children['roth-ira'].amountInCents, 75000);
  assert.deepEqual(feb.children['roth-ira'].obligations, [
    { monthKey: '2030-01', amountInCents: 12500, bucket: 'regular' },
    { monthKey: '2030-02', amountInCents: 62500, bucket: 'regular' },
  ]);
  assert.equal(feb.children['project-savings'].amountInCents, 7500);
  assert.equal(feb.plan.project.knownOutstandingCents, 12500);
  assert.equal(summarizeMonthlyRoth({ config: s.config, state: s.store.value, rothPolicy: s.rothPolicy,
    rothEvidence: s.rothEvidence, now: s.clock.value }).ownReservedCents, 125000);
});

test('unknown Roth eligibility allows essentials and Emergency, holds all lower cash, and alerts', async () => {
  const s = fixture({ rothVerified: false });
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(s.client.creates.map(row => row.request.destinationAccountId), [s.config.accounts.bills, s.config.accounts.general, s.config.accounts.emergency]);
  assert.equal(cycle(s).children['project-savings'].amountInCents, 0);
  assert.equal(cycle(s).children['personal-investment'].amountInCents, 0);
  assert.ok(s.sent.some(row => row.code === 'ROTH_ELIGIBILITY_UNVERIFIED'));
});

test('the separate Roth execution flag remains an effective gate inside the monthly coordinator', async () => {
  const s = fixture(); s.config.roth.enabled = false;
  await s.run();
  assert.deepEqual(s.client.creates.map(row => row.request.destinationAccountId), [s.config.accounts.bills, s.config.accounts.general, s.config.accounts.emergency]);
  assert.ok(cycle(s).plan.rothBlockers.includes('ROTH_DISABLED'));
});

test('windfalls are excluded from both percentages and remain reserved outside annual close', async () => {
  const s = fixture({ regular: 1000000, windfall: 200000 });
  await s.run();
  assert.equal(cycle(s).plan.openingRegularCents, 1000000);
  assert.equal(cycle(s).plan.percentageTargets.emergencyCents, 75000);
  assert.equal(cycle(s).plan.percentageTargets.projectCents, 50000);
  assert.equal(cycle(s).plan.heldWindfallCents, 200000);
  assert.ok(monthlyOwnedTransfers(s.store.value).every(row => row.windfallCents === 0));
});

test('December close routes windfalls to Roth then Project then Personal and records exact pool ownership', async () => {
  const s = fixture({ regular: 100000, windfall: 500000, bills: 50000, general: 300000, emergency: 1000000,
    activationAt: '2030-11-01T14:00:00.000Z' });
  s.advance('2030-12-01T15:00:00.000Z');
  s.monthlyPolicy.opening.asOf = '2030-12-01T14:00:00.000Z'; s.monthlyPolicy.updatedAt = s.monthlyPolicy.opening.asOf;
  // The prior cycle's Project opening basis was reviewed and preserved; its
  // unfunded target is not guessed from the new month's balance.
  const state = initialState();
  state.monthly = { schemaVersion: 1, activationAt: s.config.activationAt, bindingHash: null, cycles: {},
    obligations: { '2030-11': { rothTargetCents: 62500, projectTargetCents: 5000 } }, income: null,
    rothPolicy: null, outsideContributionFloors: {}, taxYearReview: {}, alerts: {}, lastSettledAt: null, lastRun: null };
  s.store.replaceForTest(state);
  const result = await s.run();
  assert.equal(result.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const dec = cycle(s, '2030-12');
  assert.equal(dec.children['roth-ira'].amountInCents, 125000);
  assert.equal(dec.children['roth-ira'].regularCents, 90000);
  assert.equal(dec.children['roth-ira'].windfallCents, 35000);
  assert.equal(dec.children['project-savings'].amountInCents, 10000);
  assert.equal(dec.children['project-savings'].windfallCents, 10000);
  assert.equal(dec.children['personal-investment'].windfallCents, 455000);
  assert.equal(monthlyOwnedTransfers(s.store.value).filter(row => row.monthKey === '2030-12').reduce((sum, row) => sum + row.windfallCents, 0), 500000);
});

test('a missed first records Roth arrears and unknown Project history but never sends on a later day', async () => {
  const s = fixture(); s.advance('2030-01-02T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_FIRST_DAY_ONLY');
  noMoney(s);
  assert.deepEqual(s.store.value.monthly.obligations['2030-01'], { rothTargetCents: 62500, projectTargetCents: null });
  assert.ok(s.sent.some(row => row.code === 'MONTHLY_CYCLE_MISSED'));
  s.advance('2030-02-01T15:00:00.000Z');
  await s.run();
  assert.equal(cycle(s, '2030-02').children['roth-ira'].amountInCents, 125000);
  assert.equal(cycle(s, '2030-02').plan.project.unknownMonths[0], '2030-01');
});

test('prospective activation does not invent an earlier Roth or Project target', async () => {
  const s = fixture({ activationAt: '2030-01-01T15:00:01.000Z' });
  s.advance('2030-01-02T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_NOT_DUE');
  assert.deepEqual(s.store.value.monthly.obligations, {}); noMoney(s);
  s.advance('2030-02-01T15:00:00.000Z'); await s.run();
  assert.equal(cycle(s, '2030-02').children['roth-ira'].amountInCents, 62500);
  assert.deepEqual(Object.keys(s.store.value.monthly.obligations), ['2030-02']);
});

test('Emergency excess returns independently and never funds the same frozen cycle as pending Income', async () => {
  const s = fixture({ emergency: 1050000 });
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const excess = cycle(s).children['emergency-excess'];
  assert.equal(excess.amountInCents, 50000); assert.equal(excess.regularCents, 0); assert.equal(excess.windfallCents, 0);
  assert.equal(excess.request.sourceAccountId, s.config.accounts.emergency);
  assert.equal(excess.request.destinationAccountId, s.config.accounts.income);
  assert.equal(cycle(s).plan.openingRegularCents, 1000000);
  assert.equal(cycle(s).children['emergency-fund'].amountInCents, 0);
});

test('an unknown response stops every later request and preserves the exact recovery body and key', async () => {
  const s = fixture();
  s.client.onCreate = () => { throw new Error('Synthetic request never reached provider'); };
  assert.equal((await s.run()).code, 'MONTHLY_SUBMISSION_UNKNOWN');
  assert.equal(s.client.creates.length, 1);
  const frozen = structuredClone(s.client.creates[0]);
  assert.equal(cycle(s).children['general-spending'].status, 'PLANNED');
  s.clock.advance(61000); s.client.onCreate = null;
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(s.client.creates[1], frozen);
  assert.equal(s.client.accepted.size, 6);
});

test('an unknown accepted transfer is never identified by a guessed matching amount', async () => {
  const s = fixture();
  s.client.onCreate = intent => { s.client.acceptIntent(intent); throw new Error('Lost response'); };
  await s.run(); s.clock.advance(61000);
  assert.equal((await s.run()).code, 'MONTHLY_UNKNOWN_OUTGOING');
  assert.equal(s.client.creates.length, 1);
  assert.equal(cycle(s).children.bills.transferId, undefined);
});

test('unknown requests cannot replay on the second, while known requests remain observable', async () => {
  const s = fixture(); s.client.onCreate = () => { throw new Error('Unknown'); }; await s.run();
  s.advance('2030-01-02T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_RECOVERY_WINDOW_CLOSED');
  assert.equal(cycle(s).children.bills.status, 'REVIEW'); assert.equal(s.client.creates.length, 1);
  const known = fixture(); await known.run(); known.advance('2030-01-02T15:00:00.000Z'); known.settleAll();
  assert.equal((await known.run()).code, 'MONTHLY_FIRST_DAY_ONLY');
  assert.ok(Object.values(cycle(known).children).every(child => ['COMPLETE', 'NOOP'].includes(child.status)));
  assert.equal(known.client.creates.length, 6);
});

test('a definitive higher-priority failure blocks every lower allocation and preserves annual reservations', async () => {
  const s = fixture();
  s.client.onCreate = () => { throw Object.assign(new Error('Definitive rejection'), { uncertain: false }); };
  assert.equal((await s.run()).code, 'MONTHLY_PROVIDER_REJECTED');
  assert.equal(s.client.creates.length, 1); assert.equal(cycle(s).status, 'REVIEW');
  assert.equal((await s.run()).code, 'MONTHLY_REVIEW_REQUIRED');
  assert.equal(s.client.creates.length, 1);
});

test('concurrent workers and failed immutable writes never issue duplicate or unrecorded requests', async t => {
  await t.test('shared lease', async () => {
    const s = fixture(); const results = await Promise.all([s.run(), s.run()]);
    assert.equal(results.filter(row => row.code === 'MONTHLY_TRANSFERS_SUBMITTED').length, 1);
    assert.equal(s.client.creates.length, 6);
  });
  await t.test('durable write failure', async () => {
    const s = fixture(); s.store.beforeCAS = (_etag, value) => {
      if (monthlyOwnedTransfers(value).some(row => row.status === 'SUBMITTING')) throw new StoreConflict();
    };
    assert.equal((await s.run()).code, 'STORE_CONFLICT'); noMoney(s);
  });
});

test('all old native rules must remain disabled and a verified opening is mandatory', async t => {
  await t.test('native rule still enabled', async () => {
    const s = fixture(); s.client.rules.get(s.config.rules.funding).status = 'ENABLED';
    assert.equal((await s.run()).code, 'MONTHLY_LEGACY_RULE_ENABLED'); noMoney(s);
  });
  await t.test('opening unverified', async () => {
    const s = fixture(); s.monthlyPolicy.opening = { status: 'unverified' };
    assert.equal((await s.run()).code, 'INCOME_OPENING_UNVERIFIED'); noMoney(s);
  });
});

test('legacy financial events require explicit migration and immutable plan tampering is rejected', async () => {
  const s = fixture(); const state = initialState();
  state.events.legacy = { key: 'legacy', status: 'COMPLETE', children: { bills: { allocationId: 'bills', status: 'NOOP' } } };
  s.store.replaceForTest(state);
  assert.equal((await s.run()).code, 'MONTHLY_LEGACY_HISTORY_REQUIRES_REVIEW'); noMoney(s);
  const fresh = fixture(); await fresh.run();
  const changed = structuredClone(fresh.store.value); changed.monthly.cycles['2030-01'].plan.openingRegularCents += 1;
  assert.throws(() => validateMonthlyState(changed), error => error.code === 'MONTHLY_CYCLE_INVALID');
});

test('an email outage does not withhold an authorized partial Roth payment and later retries use the same alert identity', async () => {
  const s = fixture({ regular: 60000, bills: 50000, general: 300000, emergency: 1000000 });
  const ids = [];
  s.sendAlert = async entry => { ids.push(entry.id); throw Object.assign(new Error('Unknown delivery'), { uncertain: true }); };
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.equal(s.client.creates[0].request.amountInCents, 50000);
  const original = Object.values(s.store.value.monthly.alerts).find(row => row.code === 'ROTH_CASH_SHORTFALL');
  s.clock.advance(60000);
  s.sendAlert = async entry => { ids.push(entry.id); return { deliveryId: ID(70000) }; };
  await s.run();
  assert.equal(s.store.value.monthly.alerts[original.id].status, 'DELIVERED');
  assert.ok(ids.filter(id => id === original.id).length > 1);
  assert.equal(s.client.creates.length, 1);
});

test('an uncertain alert is not resent beyond the provider idempotency window', async () => {
  const s = fixture({ regular: 60000, bills: 50000, general: 300000, emergency: 1000000 });
  let sends = 0;
  s.sendAlert = async () => { sends += 1; throw Object.assign(new Error('Unknown delivery'), { uncertain: true }); };
  await s.run(); const before = sends;
  s.advance('2030-01-02T15:00:00.000Z'); await s.run();
  assert.equal(sends, before);
  assert.ok(Object.values(s.store.value.monthly.alerts).some(row => row.status === 'REVIEW' && row.lastError === 'ALERT_IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED'));
});

test('a refreshed essential deficit before a lower request blocks that request even if the original plan had surplus', async () => {
  const s = fixture({ bills: 50000, general: 300000, emergency: 1000000 });
  s.client.onCreate = intent => {
    const accepted = s.client.acceptIntent(intent);
    if (intent.request.destinationAccountId === s.config.roth.accountId) {
      const balance = s.client.accounts.get(s.config.accounts.bills).balance;
      balance.balanceInCents = balance.availableBalanceInCents = 0;
    }
    return accepted;
  };
  assert.equal((await s.run()).code, 'MONTHLY_ESSENTIAL_PRIORITY_UNMET');
  assert.equal(s.client.creates.length, 1);
  assert.equal(cycle(s).children['project-savings'].status, 'PLANNED');
});

test('annual IRA room caps a monthly request and remains reserved before the provider is called', async () => {
  const s = fixture({ bills: 50000, general: 300000, emergency: 1000000 });
  s.rothPolicy.years[0].outsideContributions.traditionalCents = 749000;
  s.client.onCreate = intent => {
    if (intent.request.destinationAccountId === s.config.roth.accountId) {
      assert.equal(intent.request.amountInCents, 1000);
      const status = summarizeMonthlyRoth({ config: s.config, state: s.store.value, rothPolicy: s.rothPolicy,
        rothEvidence: s.rothEvidence, now: s.clock.value });
      assert.equal(status.ownReservedCents, 1000);
      assert.equal(status.remainingAnnualCents, 0);
    }
    return s.client.acceptIntent(intent);
  };
  await s.run();
  assert.equal(cycle(s).children['roth-ira'].amountInCents, 1000);
  assert.equal(cycle(s).plan.roth.annualLimitExcludedCents, 61500);
  assert.ok(s.sent.some(row => row.code === 'ROTH_ANNUAL_LIMIT_CONSTRAINED'));
});

test('a lower outside-contribution revision cannot release IRA room in a subsequent cycle', async () => {
  const s = fixture({ regular: 60000, bills: 50000, general: 300000, emergency: 1000000 });
  s.rothPolicy.years[0].outsideContributions.traditionalCents = 100000;
  await s.run(); s.settleAll(); await s.run();
  s.advance('2030-02-01T15:00:00.000Z'); s.deposit(100000);
  s.rothPolicy.updatedAt = asISO(s.clock.value);
  s.rothPolicy.years[0].outsideContributions.traditionalCents = 0;
  await s.run();
  assert.equal(s.client.creates.length, 1);
  assert.ok(cycle(s, '2030-02').plan.rothBlockers.includes('ROTH_OUTSIDE_CONTRIBUTIONS_ROLLBACK_BLOCKED'));
  assert.equal(s.store.value.monthly.outsideContributionFloors[2030].traditionalCents, 100000);
});

test('the final durable save cannot carry a financial POST past the local first-day window', async () => {
  const s = fixture(); s.advance('2030-01-02T04:59:59.000Z');
  s.store.beforeCAS = (_etag, value) => {
    if (monthlyOwnedTransfers(value).some(row => row.status === 'SUBMITTING')) s.clock.value = Date.parse('2030-01-02T05:00:00.000Z');
  };
  assert.equal((await s.run()).code, 'MONTHLY_RECOVERY_WINDOW_CLOSED');
  noMoney(s);
  assert.equal(cycle(s).children.bills.status, 'REVIEW');
});

test('source debits or unknown deposits cannot enlarge the frozen plan or spend the protected classification pool', async () => {
  const s = fixture({ regular: 100000, bills: 50000, general: 300000, emergency: 1000000 });
  s.deposit(200000, 'UNCLASSIFIED CREDIT');
  await s.run();
  assert.equal(cycle(s).plan.openingRegularCents, 100000);
  assert.equal(cycle(s).plan.unknownHeldCents, 200000);
  assert.equal(s.client.creates.reduce((sum, row) => sum + row.request.amountInCents, 0), 90000);
  assert.ok(s.sent.some(row => row.code === 'INCOME_CLASSIFICATION_REQUIRED'));
});

test('a pending prior cycle prevents a new percentage basis or new month financial requests', async () => {
  const s = fixture(); await s.run();
  s.advance('2030-02-01T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_PRIOR_CYCLE_PENDING');
  assert.equal(s.client.creates.length, 6);
  assert.equal(cycle(s, '2030-02'), undefined);
  assert.equal(s.store.value.monthly.obligations['2030-02'].rothTargetCents, 62500);
});

test('sub-dollar amounts stay in Income rather than being rounded up or sent below the provider minimum', async () => {
  const s = fixture({ regular: 10050, bills: 50000, general: 300000, emergency: 1000000 });
  await s.run(); noMoney(s);
  assert.equal(cycle(s).children['roth-ira'].amountInCents, 50);
  assert.equal(cycle(s).children['roth-ira'].status, 'NOOP');
  assert.equal(monthlyOwnedTransfers(s.store.value).length, 0);
  assert.ok(s.sent.some(row => row.code === 'MONTHLY_BELOW_PROVIDER_MINIMUM'));
});

test('Emergency already at its current-balance cap receives no contribution when a hold reduces available cash', async () => {
  const s = fixture({ emergency: 1000000 });
  s.client.accounts.get(s.config.accounts.emergency).balance.availableBalanceInCents = 900000;
  await s.run();
  assert.equal(cycle(s).children['emergency-fund'].amountInCents, 0);
  assert.equal(cycle(s).children['emergency-excess'], undefined);
  assert.equal(s.client.creates.some(row => row.request.destinationAccountId === s.config.accounts.emergency), false);
});

test('Emergency above its current-balance cap can return spendable excess without also receiving a contribution', async () => {
  const s = fixture({ emergency: 1002500 });
  s.client.accounts.get(s.config.accounts.emergency).balance.availableBalanceInCents = 900000;
  await s.run();
  assert.equal(cycle(s).children['emergency-fund'].amountInCents, 0);
  assert.equal(cycle(s).children['emergency-excess'].amountInCents, 2500);
  assert.equal(cycle(s).children['emergency-excess'].request.sourceAccountId, s.config.accounts.emergency);
  assert.equal(s.client.creates.some(row => row.request.destinationAccountId === s.config.accounts.emergency), false);
});

test('pending Emergency incoming credits consume cap room above current balance, independently of available cash', async () => {
  const s = fixture({ emergency: 990000 });
  s.client.accounts.get(s.config.accounts.emergency).balance.availableBalanceInCents = 900000;
  s.client.transfers.set(ID(80000), transferRecord({ id: ID(80000), amountInCents: 5000, status: 'PENDING', completedAt: null,
    createdAt: asISO(START - 1000), origin: 'USER', ruleId: null, ruleExecutionId: null,
    source: { id: ID(80), type: 'EXTERNAL_ACCOUNT', isDeleted: false },
    destination: { id: s.config.accounts.emergency, type: 'EXTERNAL_ACCOUNT', isDeleted: false } }));
  await s.run();
  assert.equal(cycle(s).children['emergency-fund'].amountInCents, 5000);
  assert.equal(cycle(s).children['emergency-fund'].request.amountInCents, 5000);
  assert.equal(cycle(s).children['emergency-excess'], undefined);
});

test('the pre-submit Emergency cap check uses updated current balance rather than lower available cash', async () => {
  const s = fixture();
  s.client.onCreate = intent => {
    const response = s.client.acceptIntent(intent);
    if (intent.request.destinationAccountId === s.config.accounts.general) {
      const balance = s.client.accounts.get(s.config.accounts.emergency).balance;
      balance.balanceInCents = 1000000; balance.availableBalanceInCents = 900000;
    }
    return response;
  };
  assert.equal((await s.run()).code, 'MONTHLY_TARGET_CHANGED');
  assert.equal(s.client.creates.length, 2);
  assert.equal(cycle(s).children['emergency-fund'].request, undefined);
});

test('monthly Bills catalog revisions retain inherited anti-rollback and same-version integrity gates', async t => {
  for (const kind of ['older revision', 'different hash', 'older effective date', 'changed forecast']) await t.test(kind, async () => {
    const s = fixture({ bills: 50000, general: 300000, emergency: 1000000, rothVerified: false });
    await s.run();
    const prior = structuredClone(s.store.value.monthly.billsCatalog);
    let expected;
    if (kind === 'older revision') { s.config.calculatedBillsTarget.catalogUpdatedAt = '2029-12-29T00:00:00.000Z'; expected = 'BILLS_CATALOG_ROLLBACK_BLOCKED'; }
    if (kind === 'different hash') { s.config.calculatedBillsTarget.catalogHash = 'b'.repeat(64); expected = 'BILLS_CATALOG_VERSION_CONFLICT'; }
    if (kind === 'older effective date') { s.config.calculatedBillsTarget.effectiveDate = '2029-12-31'; expected = 'BILLS_CATALOG_ROLLBACK_BLOCKED'; }
    if (kind === 'changed forecast') {
      s.config.calculatedBillsTarget.targetCents = 100000; s.config.billsBufferCents = 100000;
      s.config.allocations.find(row => row.id === 'bills').targetCents = 100000;
      expected = 'BILLS_FORECAST_CHANGED_WITHOUT_CATALOG';
    }
    assert.equal((await s.run()).code, expected);
    assert.deepEqual(s.store.value.monthly.billsCatalog, prior); noMoney(s);
  });
});

test('serialized child property order cannot move Personal or Project ahead of Roth during recovery', async () => {
  const s = fixture(); s.client.onCreate = () => { throw new Error('Uncertain first request'); };
  await s.run();
  const state = structuredClone(s.store.value);
  state.monthly.cycles['2030-01'].children = Object.fromEntries(Object.entries(state.monthly.cycles['2030-01'].children).reverse());
  s.store.replaceForTest(state); s.clock.advance(61000); s.client.onCreate = null;
  await s.run();
  assert.deepEqual(s.client.creates.slice(1).map(row => row.request.destinationAccountId), [s.config.accounts.bills, s.config.accounts.general,
    s.config.accounts.emergency, s.config.roth.accountId, s.config.monthly.projectAccountId, s.config.monthly.personalAccountId]);
});

test('a missing frozen child invalidates the ledger rather than releasing its reserved priority', async () => {
  const s = fixture(); await s.run();
  const state = structuredClone(s.store.value); delete state.monthly.cycles['2030-01'].children['roth-ira'];
  assert.throws(() => validateMonthlyState(state), error => error.code === 'MONTHLY_CHILD_SET_INVALID');
});

test('an unsendable positive Roth remainder blocks Project and Personal rather than counting a no-op as funding', async () => {
  const s = fixture({ bills: 50000, general: 300000, emergency: 1000000 });
  s.rothPolicy.years[0].outsideContributions.traditionalCents = 749950;
  assert.equal((await s.run()).code, 'ROTH_PRIORITY_UNMET');
  noMoney(s);
  assert.equal(cycle(s).children['roth-ira'].amountInCents, 50);
  assert.equal(cycle(s).children['roth-ira'].request, undefined);
  assert.equal(cycle(s).children['project-savings'].status, 'PLANNED');
  assert.equal(cycle(s).children['personal-investment'].status, 'PLANNED');
});
