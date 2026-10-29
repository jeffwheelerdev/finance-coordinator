import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, preview, initialState, validateState, LEASE_MS } from '../lib/engine.mjs';
import { validTime } from '../lib/evidence.mjs';
import { SequenceError } from '../lib/sequence.mjs';
import { withCalculatedBillsTarget } from '../lib/config.mjs';
import { forecastBills } from '../lib/bills.mjs';
import { ID, TEST_NOW, asISO, makeConfig, cashAccount, transferRecord, scenario, FakeStore, StoreConflict } from './fixtures.mjs';

const event = (s) => Object.values(s.store.value.events)[0];
const child = (s) => event(s).children['general-spending'];
const topupId = (s) => [...s.client.accepted.values()][0];
const noWrites = (s) => assert.equal(s.client.creates.length, 0, 'No provider mutation should be attempted');
const codeIs = (code) => (error) => error.code === code;

async function finishFirst(s) {
  s.clock.advance(1000);
  s.client.settle(topupId(s));
  const result = await s.run();
  assert.equal(result.code, 'TOPUP_SETTLED');
  return result;
}

function withBudget(s, monthlyBudgetCents, reserveMonths = 3) {
  s.config = makeConfig({ ...s.config, allocations: s.config.allocations.map((allocation) => allocation.id === 'general-spending'
    ? { ...allocation, monthlyBudgetCents, reserveMonths, targetCents: monthlyBudgetCents * reserveMonths }
    : allocation) });
}

function withBillsTarget(s, targetCents, changes = {}) {
  s.config = withCalculatedBillsTarget(s.config, { targetCents, catalogHash: 'b'.repeat(64), year: 2030,
    catalogUpdatedAt: asISO(s.clock.value), effectiveDate: asISO(s.clock.value).slice(0, 10), ...changes });
}

test('preview is read-only, computes the target gap and does not claim or complete an event', async () => {
  const s = scenario();
  const result = await preview({ config: s.config, client: s.client, store: s.store, now: () => s.clock.value });
  assert.equal(result.code, 'READ_ONLY_PLAN');
  assert.equal(result.plan.targetCents, 300000);
  assert.equal(result.plan.amountInCents, 200000);
  assert.equal(s.store.writes.length, 0);
  assert.equal(s.store.value, null);
  noWrites(s);
});

test('observe mode and forceObserve never submit, bind activation or consume a refund', async (t) => {
  for (const options of [{ config: { mode: 'observe', liveEnabled: false } }, { run: { forceObserve: true } }]) {
    await t.test('inactive planning', async () => {
      const s = scenario(options.config ?? {});
      const result = await s.run(options.run ?? {});
      assert.equal(result.code, 'READ_ONLY_PLAN');
      assert.equal(s.store.value.activationAt, null);
      assert.deepEqual(s.store.value.events, {});
      noWrites(s);
    });
  }
});

test('full refund-to-top-up flow persists an immutable intent before POST and settles exactly once', async () => {
  const s = scenario();
  s.client.onCreate = (intent) => {
    const persisted = child(s);
    assert.equal(persisted.status, 'SUBMITTING');
    assert.equal(persisted.idempotencyKey, intent.idempotencyKey);
    assert.deepEqual(persisted.request, intent.request);
    assert.deepEqual(s.store.value.active, { eventKey: event(s).key, allocationId: 'general-spending' });
    assert.ok(Date.parse(s.store.value.lease.expiresAt) > s.clock.value);
    return s.client.acceptIntent(intent);
  };
  const first = await s.run();
  assert.equal(first.code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.creates[0].request.amountInCents, 200000);
  assert.equal(child(s).status, 'PENDING');
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  await finishFirst(s);
  assert.equal(event(s).status, 'COMPLETE');
  assert.equal(s.store.value.active, null);
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.client.creates.length, 1);
});

test('multiple refund transfers from one payout execution create only one funding intent', async () => {
  const s = scenario();
  const extra = transferRecord({ id: ID(102), amountInCents: 2500 });
  s.client.transfers.set(extra.id, extra);
  const execution = s.client.executions.get(ID(201));
  execution.transferIds.push(extra.id);
  execution.transfersAttempted = execution.transfersCompleted = 2;
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.deepEqual(event(s).refundIds, [ID(101), ID(102)]);
  assert.equal(s.client.creates.length, 1);
  await finishFirst(s);
  await s.run();
  assert.equal(s.client.creates.length, 1);
});

test('identical repeated history records are deduplicated, conflicting records block', async () => {
  const s = scenario();
  const refund = s.client.transfers.get(ID(101));
  s.client.historyOverride = [refund, structuredClone(refund)];
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  const bad = scenario();
  bad.client.historyOverride = [refund, { ...refund, amountInCents: 1 }];
  assert.equal((await bad.run()).code, 'TRANSFER_HISTORY_CHANGED');
  noWrites(bad);
});

test('only real settled refunds from the configured payout qualify', async (t) => {
  for (const [name, change] of [
    ['simulation', { executionMode: 'SIMULATION' }],
    ['pending', { status: 'PENDING', completedAt: null }],
    ['different source', { source: { id: ID(99), type: 'POD', isDeleted: false } }],
    ['different destination', { destination: { id: ID(99), type: 'EXTERNAL_ACCOUNT', isDeleted: false } }],
    ['different rule', { ruleId: ID(99) }],
    ['manual transfer', { origin: 'USER', ruleId: null }],
  ]) {
    await t.test(name, async () => {
      const s = scenario();
      Object.assign(s.client.transfers.get(ID(101)), change);
      assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
      noWrites(s);
    });
  }
});

test('no-refund cycles do not invent an event or top up from an empty Pod alone', async () => {
  const s = scenario();
  s.client.transfers.clear();
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  noWrites(s);
});

test('partial, failed or inconsistent payout executions block downstream funding', async (t) => {
  for (const [name, change, expected] of [
    ['partial', { status: 'PARTIAL' }, 'PAYOUT_REQUIRES_REVIEW'],
    ['failed', { status: 'FAILED' }, 'PAYOUT_REQUIRES_REVIEW'],
    ['approval denied', { status: 'APPROVAL_DENIED' }, 'PAYOUT_REQUIRES_REVIEW'],
    ['pending', { transfersPending: 1 }, 'PAYOUT_NOT_SETTLED'],
    ['missing completed transfer', { transfersCompleted: 0 }, 'PAYOUT_COUNTS_INCONSISTENT'],
    ['duplicate transfer ID', { transferIds: [ID(101), ID(101)] }, 'PAYOUT_COUNTS_INCONSISTENT'],
    ['simulation execution', { executionMode: 'SIMULATION' }, 'PAYOUT_EXECUTION_IDENTITY_INVALID'],
    ['wrong parent rule', { ruleId: ID(99) }, 'PAYOUT_EXECUTION_IDENTITY_INVALID'],
  ]) {
    await t.test(name, async () => {
      const s = scenario();
      Object.assign(s.client.executions.get(ID(201)), change);
      assert.equal((await s.run()).code, expected);
      noWrites(s);
    });
  }
});

test('execution resources must match the listed refund and approved account identities', async (t) => {
  for (const [name, change, expected] of [
    ['deleted source', { source: { id: ID(2), type: 'POD', isDeleted: true } }, 'PAYOUT_TRANSFER_IDENTITY_INVALID'],
    ['missing counterparty deletion state', { destination: { id: ID(1), type: 'EXTERNAL_ACCOUNT' } }, 'PAYOUT_TRANSFER_IDENTITY_INVALID'],
    ['provider failure', { status: 'ERROR', errorCode: 'PAYMENT_FAILED' }, 'PAYOUT_REQUIRES_REVIEW'],
    ['completed transfer with an error', { errorCode: 'PAYMENT_FAILED' }, 'PAYOUT_TRANSFER_INCONSISTENT'],
    ['transfer created before execution', { createdAt: asISO(TEST_NOW - 3 * 3600000) }, 'PAYOUT_TRANSFER_INCONSISTENT'],
  ]) {
    await t.test(name, async () => {
      const s = scenario();
      const original = structuredClone(s.client.transfers.get(ID(101)));
      s.client.historyOverride = [original];
      Object.assign(s.client.transfers.get(ID(101)), change);
      assert.equal((await s.run()).code, expected);
      noWrites(s);
    });
  }
});

test('incomplete provider history, pending related transfers and failed funding legs stop a new intent', async (t) => {
  await t.test('incomplete pagination', async () => {
    const s = scenario(); s.client.completeHistory = false;
    assert.equal((await s.run()).code, 'INCOMPLETE_TRANSFER_HISTORY'); noWrites(s);
  });
  for (const status of ['APPROVAL_PENDING', 'PROCESSING', 'PENDING']) {
    await t.test(status, async () => {
      const s = scenario();
      s.client.transfers.set(ID(150), transferRecord({ id: ID(150), source: { id: ID(1), isDeleted: false },
        destination: { id: ID(4), isDeleted: false }, origin: 'USER', ruleId: null, ruleExecutionId: null,
        status, completedAt: null, createdAt: asISO(TEST_NOW - 10 * 86400000) }));
      assert.equal((await s.run()).code, 'RELATED_TRANSFER_PENDING'); noWrites(s);
    });
  }
  await t.test('failed current funding transfer', async () => {
    const s = scenario();
    s.client.transfers.set(ID(150), transferRecord({ id: ID(150), ruleId: s.config.rules.funding,
      source: { id: ID(1), isDeleted: false }, destination: { id: ID(2), isDeleted: false },
      status: 'ERROR', completedAt: null, errorCode: 'INSUFFICIENT_FUNDS' }));
    assert.equal((await s.run()).code, 'UPSTREAM_FUNDING_FAILURE_REQUIRES_REVIEW'); noWrites(s);
  });
});

test('balances must be newer than the refund and every later relevant settlement', async () => {
  const s = scenario();
  s.client.transfers.set(ID(151), transferRecord({ id: ID(151), source: { id: ID(1), isDeleted: false },
    destination: { id: ID(4), isDeleted: false }, origin: 'USER', ruleId: null, ruleExecutionId: null,
    createdAt: asISO(TEST_NOW - 20 * 60000), completedAt: asISO(TEST_NOW - 10 * 60000) }));
  assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  noWrites(s);
  s.client.refreshCash({ at: asISO(TEST_NOW - 5 * 60000) });
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
});

test('missing, stale, future and errored external balances cannot authorize money movement', async (t) => {
  for (const [name, change, expected] of [
    ['missing timestamp', { balanceLastUpdatedAt: null }, 'BALANCE_TIMESTAMP_UNAVAILABLE'],
    ['old snapshot', { balanceLastUpdatedAt: asISO(TEST_NOW - 27 * 3600000) }, 'BALANCE_TOO_OLD'],
    ['future snapshot', { balanceLastUpdatedAt: asISO(TEST_NOW + 1) }, 'BALANCE_TIMESTAMP_UNAVAILABLE'],
    ['not refreshed since refund', { balanceLastUpdatedAt: asISO(TEST_NOW - 60 * 60000) }, 'WAITING_FOR_POST_SETTLEMENT_BALANCE'],
    ['provider error', { error: 'DISCONNECTED_ACCOUNT' }, 'BALANCE_UNAVAILABLE'],
    ['missing available balance', { availableBalanceInCents: null }, 'BALANCE_UNAVAILABLE'],
    ['negative cash', { balanceInCents: -1 }, 'BALANCE_UNAVAILABLE'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); Object.assign(s.client.accounts.get(ID(1)).balance, change);
      assert.equal((await s.run()).code, expected); noWrites(s);
    });
  }
});

test('cash account types, capability flags and Pod holds are enforced', async (t) => {
  for (const [name, change, expected] of [
    ['deleted destination', { deletedAt: asISO(TEST_NOW - 1) }, 'ACCOUNT_IDENTITY_INVALID'],
    ['destination cannot receive', { canBeDestination: false }, 'ACCOUNT_CANNOT_RECEIVE'],
    ['investment destination', { externalAccountType: 'INVESTMENT' }, 'ACCOUNT_IS_NOT_CASH'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); Object.assign(s.client.accounts.get(ID(3)), change);
      assert.equal((await s.run()).code, expected); noWrites(s);
    });
  }
  const s = scenario();
  Object.assign(s.client.accounts.get(ID(2)).balance, { balanceInCents: 1, holdInCents: 1 });
  assert.equal((await s.run()).code, 'POD_NOT_EMPTY'); noWrites(s);
});

test('Bills fills its dynamic shortfall first without reserving the same deficit twice', async () => {
  const s = scenario();
  s.client.refreshCash({ income: 100000, general: 0, bills: 15000 });
  const result = await s.run();
  assert.equal(result.code, 'TOPUP_PENDING');
  assert.equal(s.client.creates[0].request.destinationAccountId, ID(4));
  assert.equal(s.client.creates[0].request.amountInCents, 35000);
  const plan = event(s).children.bills.plan;
  assert.equal(plan.billsShortfallCents, 35000);
  assert.equal(plan.protectedIncomeCents, 10000);
  assert.equal(plan.gapCents, 35000);
  assert.equal(child(s).status, 'WAITING');
});

test('Bills-first preview and observe plans never submit or consume a refund', async () => {
  const s = scenario({ mode: 'observe', liveEnabled: false });
  s.client.refreshCash({ bills: 15000 });
  const planned = await preview({ config: s.config, client: s.client, store: s.store, now: () => s.clock.value });
  assert.equal(planned.plan.allocationId, 'bills');
  assert.equal(planned.plan.amountInCents, 35000);
  assert.equal(s.store.writes.length, 0);
  assert.equal((await s.run()).plan.allocationId, 'bills');
  assert.deepEqual(s.store.value.events, {});
  assert.equal(s.store.value.billsCatalog, null);
  noWrites(s);
});

test('observe and forceObserve leave existing OPEN children unchanged while walking satisfied priorities', async (t) => {
  for (const forceObserve of [false, true]) {
    for (const generalBalance of [100000, 300000]) {
      await t.test(`${forceObserve ? 'forced observe' : 'paused'}; General ${generalBalance}`, async () => {
        const s = scenario();
        s.client.accounts.get(ID(1)).balance.balanceLastUpdatedAt = asISO(TEST_NOW - 2 * 3600000);
        assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
        assert.equal(event(s).children.bills.status, 'WAITING');
        assert.equal(child(s).status, 'WAITING');
        const saved = structuredClone(s.store.value);
        s.client.refreshCash({ bills: 50000, general: generalBalance });
        if (!forceObserve) s.config = makeConfig({ ...s.config, mode: 'observe', liveEnabled: false });
        assert.equal((await s.run({ forceObserve })).code, 'READ_ONLY_PLAN');
        assert.deepEqual(s.store.value.events, saved.events);
        assert.deepEqual(s.store.value.allocations, saved.allocations);
        assert.deepEqual(s.store.value.active, saved.active);
        assert.deepEqual(s.store.value.billsCatalog, saved.billsCatalog);
        noWrites(s);
      });
    }
  }
});

test('General Spending waits for Bills settlement and refreshed post-settlement cash evidence', async () => {
  const s = scenario(); s.client.refreshCash({ bills: 15000 });
  assert.equal((await s.run()).allocationId, 'bills');
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  await finishFirst(s);
  assert.equal(event(s).children.bills.status, 'COMPLETE');
  assert.equal(child(s).status, 'WAITING');
  assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  s.clock.advance(1000);
  Object.assign(s.client.accounts.get(ID(4)).balance, { balanceInCents: 50000,
    availableBalanceInCents: 50000, balanceLastUpdatedAt: asISO(s.clock.value) });
  assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  s.client.refreshCash({ income: 465000, bills: 50000 });
  assert.equal((await s.run()).allocationId, 'general-spending');
  assert.equal(s.client.creates.length, 2);
  assert.equal(s.client.creates[1].request.destinationAccountId, ID(3));
  assert.equal(s.client.creates[1].request.amountInCents, 200000);
});

test('a partial Bills fill permanently consumes lower priorities for that refund cycle', async () => {
  const s = scenario(); s.client.refreshCash({ income: 40000, bills: 0 });
  assert.equal((await s.run()).allocationId, 'bills');
  assert.equal(s.client.creates[0].request.amountInCents, 30000);
  assert.equal(event(s).children.bills.plan.gapCents, 50000);
  assert.equal(child(s).status, 'SKIPPED');
  assert.equal(child(s).reason, 'BILLS_PRIORITY_UNMET');
  await finishFirst(s);
  assert.equal(event(s).status, 'COMPLETE');
  s.clock.advance(1000);
  s.client.refreshCash({ income: 500000, bills: 30000 });
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.client.creates.length, 1);
});

test('unfunded or sub-dollar Bills deficits prevent every lower-priority transfer in that cycle', async (t) => {
  for (const [name, income, bills] of [['protected Income', 10000, 0], ['provider minimum', 500000, 49950]]) {
    await t.test(name, async () => {
      const s = scenario(); s.client.refreshCash({ income, bills });
      assert.equal((await s.run()).code, 'BILLS_PRIORITY_UNMET');
      assert.equal(event(s).children.bills.status, 'NOOP');
      assert.equal(child(s).status, 'SKIPPED');
      assert.equal(event(s).status, 'COMPLETE');
      s.client.refreshCash({ income: 900000, bills: 50000 });
      assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
      noWrites(s);
    });
  }
});

test('a Bills target increase after settlement stops General without replaying the Bills intent', async () => {
  const s = scenario(); s.client.refreshCash({ bills: 0 });
  await s.run(); await finishFirst(s);
  s.clock.advance(1000);
  withBillsTarget(s, 100000);
  s.client.refreshCash({ income: 450000, bills: 50000 });
  assert.equal((await s.run()).code, 'BILLS_PRIORITY_UNMET');
  assert.equal(child(s).status, 'SKIPPED');
  assert.equal(event(s).status, 'COMPLETE');
  assert.equal(s.client.creates.length, 1);
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
});

test('an increased Bills target also stops a waiting General plan after Bills needed no initial transfer', async () => {
  const s = scenario();
  s.client.accounts.get(ID(3)).balance.balanceLastUpdatedAt = asISO(TEST_NOW - 2 * 3600000);
  assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  assert.equal(event(s).children.bills.status, 'NOOP');
  withBillsTarget(s, 100000);
  s.clock.advance(1000); s.client.refreshCash();
  assert.equal((await s.run()).code, 'BILLS_PRIORITY_UNMET');
  assert.equal(child(s).status, 'SKIPPED');
  noWrites(s);
});

test('a decreased target never reopens lower priorities after a partial Bills attempt', async () => {
  const s = scenario(); withBillsTarget(s, 100000);
  s.client.refreshCash({ income: 60000, bills: 0 });
  await s.run();
  assert.equal(child(s).status, 'SKIPPED');
  s.clock.advance(1000); withBillsTarget(s, 50000, { catalogHash: 'c'.repeat(64) });
  await finishFirst(s);
  s.client.refreshCash({ income: 500000, bills: 50000 });
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.client.creates.length, 1);
});

test('uncertain Bills retries preserve the original request when the dynamic target grows', async () => {
  const s = scenario(); s.client.refreshCash({ bills: 0 });
  s.client.onCreate = (intent) => {
    if (s.client.creates.length === 1) throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true });
    return s.client.acceptIntent(intent);
  };
  assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
  const original = structuredClone(s.client.creates[0]);
  s.clock.advance(61000); withBillsTarget(s, 100000);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.deepEqual(s.client.creates[1], original);
  assert.equal(original.request.amountInCents, 50000);
  assert.equal(s.client.accepted.size, 1);
});

test('an uncertain Bills request that exceeds a decreased target requires review', async () => {
  const s = scenario(); withBillsTarget(s, 100000); s.client.refreshCash({ bills: 0 });
  s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true }); };
  await s.run();
  const original = structuredClone(s.client.creates[0]);
  s.clock.advance(61000); withBillsTarget(s, 50000, { catalogHash: 'c'.repeat(64) });
  assert.equal((await s.run()).code, 'RETRY_NO_LONGER_FITS_CURRENT_BALANCES');
  assert.equal(event(s).children.bills.status, 'REVIEW');
  assert.equal(event(s).children.bills.idempotencyKey, original.idempotencyKey);
  assert.equal(s.client.creates.length, 1);
});

test('uncertain General retry protects the cycle Bills floor even after the catalog target decreases', async () => {
  const s = scenario(); withBillsTarget(s, 100000);
  s.client.refreshCash({ bills: 100000 });
  s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true }); };
  assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(s.client.creates[0].request.destinationAccountId, ID(3));
  assert.equal(event(s).children.bills.plan.targetCents, 100000);
  const original = structuredClone(s.client.creates[0]);
  s.clock.advance(61000); withBillsTarget(s, 50000, { catalogHash: 'c'.repeat(64) });
  s.client.refreshCash({ bills: 75000 });
  assert.equal((await s.run()).code, 'RETRY_NO_LONGER_FITS_CURRENT_BALANCES');
  assert.equal(child(s).status, 'REVIEW');
  assert.equal(s.client.creates.length, 1);
  assert.equal(child(s).idempotencyKey, original.idempotencyKey);
  assert.deepEqual(child(s).request, original.request);
});

test('pending approval and failure of a Bills transfer both block General Spending', async () => {
  const s = scenario(); s.client.refreshCash({ bills: 0 });
  s.client.onCreate = (intent) => s.client.acceptIntent(intent, { status: 'APPROVAL_PENDING' });
  assert.equal((await s.run()).code, 'PROVIDER_APPROVAL_REQUIRED');
  assert.equal((await s.run()).code, 'PROVIDER_APPROVAL_REQUIRED');
  assert.equal(child(s).status, 'WAITING');
  Object.assign(s.client.transfers.get(topupId(s)), { status: 'ERROR', errorCode: 'PAYMENT_FAILED' });
  assert.equal((await s.run()).code, 'TOPUP_DID_NOT_SETTLE');
  assert.equal((await s.run()).code, 'UNRESOLVED_EVENT_REQUIRES_REVIEW');
  assert.equal(s.client.creates.length, 1);
});

test('live Bills policy rejects stale or conflicting catalog versions without moving money', async (t) => {
  for (const [name, changes, expected] of [
    ['older catalog', { catalogUpdatedAt: asISO(TEST_NOW - 3 * 86400000) }, 'BILLS_CATALOG_ROLLBACK_BLOCKED'],
    ['same timestamp, changed catalog', { catalogUpdatedAt: asISO(TEST_NOW - 2 * 86400000) }, 'BILLS_CATALOG_VERSION_CONFLICT'],
    ['same version, changed target', { catalogHash: 'a'.repeat(64), catalogUpdatedAt: asISO(TEST_NOW - 2 * 86400000) }, 'BILLS_FORECAST_CHANGED_WITHOUT_CATALOG'],
    ['older forecast year', { year: 2029 }, 'BILLS_CATALOG_ROLLBACK_BLOCKED'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); s.client.transfers.clear();
      await s.run();
      withBillsTarget(s, 100000, changes);
      assert.equal((await s.run()).code, expected);
      noWrites(s);
    });
  }
});

test('a newer catalog may lower its target and the same catalog may roll to a new forecast year', async () => {
  const s = scenario(); withBillsTarget(s, 100000); s.client.transfers.clear();
  await s.run();
  s.clock.advance(1000); withBillsTarget(s, 50000, { catalogHash: 'c'.repeat(64) });
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  const catalogUpdatedAt = s.config.calculatedBillsTarget.catalogUpdatedAt;
  s.clock.advance(366 * 86400000);
  withBillsTarget(s, 100000, { catalogHash: 'c'.repeat(64), catalogUpdatedAt, year: 2031 });
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.store.value.billsCatalog.year, 2031);
  noWrites(s);
});

test('a confirmed future cancellation may lower the cap on its local effective date without a catalog revision', async () => {
  const proof = { type: 'user_confirmation', reference: 'synthetic-policy', observedAt: '2029-12-29T12:00:00Z' };
  const catalog = { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: '2029-12-30T12:00:00Z', bills: [
    { id: 'ongoing-expense', name: 'Synthetic ongoing expense', kind: 'expense', status: 'active',
      amountCents: 20000, frequency: 'monthly', evidence: proof },
    { id: 'ending-expense', name: 'Synthetic ending expense', kind: 'expense', status: 'canceled',
      amountCents: 40000, frequency: 'monthly', evidence: proof,
      cancellation: { confirmed: true, effectiveOn: '2030-01-03', reference: 'synthetic-cancellation' } },
  ] };
  const s = scenario(); s.client.transfers.clear();
  const before = forecastBills(catalog, { now: s.clock.value });
  s.config = withCalculatedBillsTarget(s.config, before);
  assert.equal(before.targetCents, 100000);
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  s.clock.value = Date.parse('2030-01-03T05:00:00.000Z');
  const after = forecastBills(catalog, { now: s.clock.value });
  assert.equal(after.catalogHash, before.catalogHash);
  assert.equal(after.catalogUpdatedAt, before.catalogUpdatedAt);
  assert.equal(after.year, before.year);
  assert.equal(after.effectiveDate, '2030-01-03');
  assert.equal(after.targetCents, 50000);
  s.config = withCalculatedBillsTarget(s.config, after);
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.store.value.billsCatalog.targetCents, 50000);
  s.config = withCalculatedBillsTarget(s.config, before);
  assert.equal((await s.run()).code, 'BILLS_CATALOG_ROLLBACK_BLOCKED');
  noWrites(s);
});

test('an old open ledger event without Bills requires migration and is not retroactively funded', async () => {
  const s = scenario();
  s.client.accounts.get(ID(3)).balance.balanceLastUpdatedAt = asISO(TEST_NOW - 2 * 3600000);
  await s.run();
  const oldState = structuredClone(s.store.value);
  delete Object.values(oldState.events)[0].children.bills;
  delete oldState.allocations.bills;
  delete oldState.billsCatalog;
  s.store.replaceForTest(oldState);
  s.client.refreshCash();
  assert.equal((await s.run()).code, 'BILLS_POLICY_MIGRATION_REQUIRED');
  assert.equal(s.store.value.schemaVersion, 1);
  noWrites(s);
});

test('an unresolved runtime Bills target cannot use an obsolete fixed buffer to submit', async () => {
  const s = scenario({ calculatedBillsTarget: null });
  assert.equal((await s.run()).code, 'BILLS_TARGET_UNAVAILABLE');
  noWrites(s);
});

test('overdraft availability is not treated as owned cash', async () => {
  const s = scenario();
  Object.assign(s.client.accounts.get(ID(1)).balance, { balanceInCents: 20000, availableBalanceInCents: 200000 });
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates[0].request.amountInCents, 10000);
});

test('no uncommitted cash, met targets and sub-dollar gaps complete without transfers', async (t) => {
  for (const [name, setup, expected] of [
    ['all cash protected', (s) => s.client.refreshCash({ income: 10000, general: 0, bills: 50000 }), 'NO_UNCOMMITTED_INCOME'],
    ['at target', (s) => s.client.refreshCash({ general: 300000 }), 'TARGET_ALREADY_MET'],
    ['above target', (s) => s.client.refreshCash({ general: 350000 }), 'TARGET_ALREADY_MET'],
    ['sub-dollar gap', (s) => s.client.refreshCash({ general: 299950 }), 'BELOW_PROVIDER_MINIMUM'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); setup(s);
      assert.equal((await s.run()).code, expected);
      assert.equal(child(s).status, 'NOOP');
      assert.equal(event(s).status, 'COMPLETE');
      noWrites(s);
    });
  }
});

test('arbitrary decimal monthly budgets are not constrained by a hardcoded personal target', async () => {
  const s = scenario(); withBudget(s, 98765);
  s.client.refreshCash({ general: 0 });
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates[0].request.amountInCents, 296295);
  assert.equal(child(s).plan.monthlyBudgetCents, 98765);
  assert.equal(child(s).plan.reserveMonths, 3);
});

test('budget changes affect a new unsubmitted plan but never replay a completed refund', async () => {
  const s = scenario(); withBudget(s, 104321);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates[0].request.amountInCents, 212963);
  await finishFirst(s);
  withBudget(s, 120000);
  s.client.refreshCash({ general: 50000 });
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.client.creates.length, 1);
});

test('concurrent workers cannot both reserve or submit the same refund', async () => {
  const s = scenario();
  const results = await Promise.all([s.run(), s.run()]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['busy', 'pending']);
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.accepted.size, 1);
});

test('an existing unexpired lease returns busy without provider calls', async () => {
  const s = scenario();
  s.store = new FakeStore({ ...initialState(), lease: { owner: ID(990), expiresAt: asISO(TEST_NOW + 60000) } });
  assert.equal((await s.run()).code, 'ANOTHER_RUN_OWNS_LEASE');
  assert.equal(s.client.calls.length, 0);
});

test('failure to durably persist the immutable intent prevents a POST', async () => {
  const s = scenario();
  s.store.beforeCAS = (_etag, value) => {
    if (value.active) throw new StoreConflict();
  };
  assert.equal((await s.run()).code, 'STORE_CONFLICT');
  noWrites(s);
});

test('expired runtime cannot submit or release a lease over a newer worker', async () => {
  const s = scenario();
  s.client.onGetAccount = async (id) => {
    s.clock.value = TEST_NOW + 240001;
    return structuredClone(s.client.accounts.get(id));
  };
  assert.equal((await s.run()).code, 'LEASE_OR_RUN_EXPIRED');
  noWrites(s);
  assert.ok(s.store.value.lease);
  assert.equal(Date.parse(s.store.value.lease.expiresAt), TEST_NOW + LEASE_MS);
});

test('a lost response cannot identify its pending transfer by matching amount or accounts', async () => {
  const s = scenario();
  s.client.onCreate = (intent) => {
    const transfer = s.client.acceptIntent(intent);
    if (s.client.creates.length === 1) throw new SequenceError('REQUEST_TIMEOUT', 'Synthetic lost response', { uncertain: true });
    return transfer;
  };
  assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
  const saved = structuredClone(child(s));
  assert.equal((await s.run()).code, 'RETRY_NOT_DUE');
  assert.equal(s.client.creates.length, 1);
  withBudget(s, 150000);
  s.clock.advance(61000);
  assert.equal((await s.run()).code, 'RELATED_TRANSFER_PENDING');
  assert.equal(child(s).status, 'SUBMITTING');
  assert.equal(child(s).transferId, undefined);
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.accepted.size, 1);
  assert.equal(child(s).idempotencyKey, saved.idempotencyKey);
  assert.deepEqual(child(s).request, saved.request);
  s.clock.value = TEST_NOW + 23 * 3600000;
  assert.equal((await s.run()).code, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED');
  assert.equal(child(s).status, 'REVIEW');
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.accepted.size, 1);
});

test('crash after acceptance preserves the unresolved reservation and never creates a replacement operation', async () => {
  const s = scenario();
  let injected = false;
  s.store.beforeCAS = (_etag, value) => {
    const hasPending = Object.values(value.events).some((entry) => Object.values(entry.children).some((entryChild) => entryChild.status === 'PENDING'));
    if (!injected && hasPending) { injected = true; throw new StoreConflict(); }
  };
  assert.equal((await s.run()).code, 'STORE_CONFLICT');
  assert.equal(s.client.accepted.size, 1);
  assert.equal(child(s).status, 'SUBMITTING');
  assert.equal(child(s).transferId, undefined);
  const original = structuredClone(s.client.creates[0]);
  assert.equal((await s.run()).status, 'busy');
  s.clock.advance(LEASE_MS + 1);
  assert.equal((await s.run()).code, 'RELATED_TRANSFER_PENDING');
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.accepted.size, 1);
  assert.equal(child(s).idempotencyKey, original.idempotencyKey);
  assert.deepEqual(child(s).request, original.request);
  s.clock.value = TEST_NOW + 23 * 3600000;
  assert.equal((await s.run()).code, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED');
  assert.equal(child(s).status, 'REVIEW');
  assert.equal((await s.run()).code, 'UNRESOLVED_EVENT_REQUIRES_REVIEW');
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.accepted.size, 1);
});

test('a request that never reached the provider retries the frozen amount and key when evidence still supports it', async () => {
  const s = scenario();
  s.client.onCreate = (intent) => {
    if (s.client.creates.length === 1) throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true });
    return s.client.acceptIntent(intent);
  };
  assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal(s.client.accepted.size, 0);
  const original = structuredClone(s.client.creates[0]);
  withBudget(s, 150000);
  s.clock.advance(61000);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 2);
  assert.equal(s.client.accepted.size, 1);
  assert.deepEqual(s.client.creates[1], original);
  assert.equal(s.client.creates[1].request.amountInCents, 200000);
});

test('accepted but not yet listed transfers recover by same-key replay with one provider effect', async () => {
  const s = scenario();
  const originalHistory = structuredClone([...s.client.transfers.values()]);
  s.client.onCreate = (intent) => {
    const transfer = s.client.acceptIntent(intent);
    if (s.client.creates.length === 1) throw new SequenceError('REQUEST_TIMEOUT', 'Synthetic lost accepted response', { uncertain: true });
    return transfer;
  };
  assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
  const original = structuredClone(s.client.creates[0]);
  const acceptedId = topupId(s);
  s.client.historyOverride = originalHistory;
  s.clock.advance(61000);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.deepEqual(s.client.creates[1], original);
  assert.equal(child(s).transferId, acceptedId);
  assert.equal(s.client.accepted.size, 1);
  await finishFirst(s);
  assert.equal(s.client.accepted.size, 1);
});

test('expired unknown outcomes require review instead of generating a new key', async () => {
  const s = scenario();
  s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic uncertainty', { uncertain: true }); };
  await s.run();
  s.clock.advance(23 * 3600000);
  assert.equal((await s.run()).code, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED');
  assert.equal(child(s).status, 'REVIEW');
  assert.equal(s.client.creates.length, 1);
  assert.equal((await s.run()).code, 'UNRESOLVED_EVENT_REQUIRES_REVIEW');
  assert.equal(s.client.creates.length, 1);
});

test('rate limiting preserves the intent and honors Retry-After without permanent review', async () => {
  const s = scenario();
  s.client.onCreate = (intent) => {
    if (s.client.creates.length === 1) throw new SequenceError('RATE_LIMIT_EXCEEDED', 'Synthetic rate limit',
      { status: 429, uncertain: false, retryAfter: 120 });
    return s.client.acceptIntent(intent);
  };
  await s.run();
  const saved = structuredClone(child(s));
  assert.equal(saved.status, 'SUBMITTING');
  assert.ok(Date.parse(saved.nextAttemptAt) >= TEST_NOW + 120000);
  s.clock.advance(60000);
  assert.equal((await s.run()).code, 'RETRY_NOT_DUE');
  assert.equal(s.client.creates.length, 1);
  s.clock.advance(61000);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates[1].idempotencyKey, saved.idempotencyKey);
  assert.deepEqual(s.client.creates[1].request, saved.request);
});

test('a retry cannot increase its amount or exceed changed budgets and currently uncommitted cash', async (t) => {
  for (const [name, change] of [
    ['lowered budget', (s) => withBudget(s, 80000)],
    ['reduced source cash', (s) => s.client.refreshCash({ income: 150000 })],
    ['destination funded independently', (s) => s.client.refreshCash({ general: 200000 })],
    ['new bill reserve shortfall', (s) => withBillsTarget(s, 400000)],
  ]) {
    await t.test(name, async () => {
      const s = scenario();
      s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true }); };
      await s.run();
      const original = structuredClone(s.client.creates[0]);
      change(s);
      s.clock.advance(61000);
      assert.equal((await s.run()).code, 'RETRY_NO_LONGER_FITS_CURRENT_BALANCES');
      assert.equal(child(s).status, 'REVIEW');
      assert.equal(child(s).idempotencyKey, original.idempotencyKey);
      assert.deepEqual(child(s).request, original.request);
      assert.equal(s.client.creates.length, 1);
    });
  }
});

test('upstream funding history guards both new intents and retries independently of refund identity', async (t) => {
  for (const retry of [false, true]) {
    for (const [status, expected] of [
      ['PARTIAL', 'UPSTREAM_FUNDING_REQUIRES_REVIEW'],
      ['FAILED', 'UPSTREAM_FUNDING_REQUIRES_REVIEW'],
      ['IN_PROGRESS', 'UPSTREAM_FUNDING_PENDING'],
      ['APPROVAL_PENDING', 'UPSTREAM_FUNDING_PENDING'],
    ]) {
      await t.test(`${retry ? 'retry' : 'new intent'}: ${status}`, async () => {
        const s = scenario();
        if (retry) {
          s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic request never arrived', { uncertain: true }); };
          assert.equal((await s.run()).code, 'SUBMISSION_OUTCOME_UNKNOWN');
          s.clock.advance(61000);
        }
        s.client.executions.set(ID(301), { id: ID(301), ruleId: s.config.rules.funding,
          executionMode: 'LIVE', createdAt: asISO(TEST_NOW - 4 * 3600000), status });
        assert.equal((await s.run()).code, expected);
        assert.equal(s.client.creates.length, retry ? 1 : 0);
        const guardReads = s.client.calls.filter((call) => call.method === 'listRuleExecutions');
        assert.ok(guardReads.length > 0);
        assert.equal(guardReads.at(-1).options.ruleId, s.config.rules.funding);
        assert.equal(guardReads.at(-1).options.executionMode, 'LIVE');
      });
    }
  }
});

test('definitive provider rejection blocks later events until reconciliation', async () => {
  const s = scenario();
  s.client.onCreate = () => { throw new SequenceError('ACCESS_DENIED', 'Synthetic denied scope', { status: 403, uncertain: false }); };
  assert.equal((await s.run()).code, 'PROVIDER_REJECTED_TOPUP');
  assert.equal(child(s).status, 'REVIEW');
  assert.equal(event(s).status, 'REVIEW');
  assert.equal((await s.run()).code, 'UNRESOLVED_EVENT_REQUIRES_REVIEW');
  assert.equal(s.client.creates.length, 1);
});

test('approval-pending and accepted-resource 404 never cause duplicate POSTs', async () => {
  const s = scenario();
  s.client.onCreate = (intent) => s.client.acceptIntent(intent, { status: 'APPROVAL_PENDING' });
  assert.equal((await s.run()).code, 'PROVIDER_APPROVAL_REQUIRED');
  s.client.onGetTransfer = (id) => {
    if (id === topupId(s)) throw new SequenceError('TRANSFER_NOT_FOUND', 'Synthetic eventual consistency', { status: 404, uncertain: false });
    return structuredClone(s.client.transfers.get(id));
  };
  assert.equal((await s.run()).code, 'ACCEPTED_TRANSFER_NOT_VISIBLE_YET');
  assert.equal(s.client.creates.length, 1);
  assert.equal(child(s).status, 'PENDING');
  s.client.onGetTransfer = null;
  s.config = makeConfig({ ...s.config, mode: 'observe', liveEnabled: false });
  s.clock.advance(24 * 3600000);
  s.client.settle(topupId(s));
  assert.equal((await s.run()).code, 'TOPUP_SETTLED');
  assert.equal(s.client.creates.length, 1);
});

test('paused uncertain intents stay observable but are never resubmitted', async () => {
  const s = scenario();
  s.client.onCreate = () => { throw new SequenceError('NETWORK_ERROR', 'Synthetic uncertainty', { uncertain: true }); };
  await s.run();
  s.config = makeConfig({ ...s.config, mode: 'observe', liveEnabled: false });
  s.clock.advance(61000);
  assert.equal((await s.run()).code, 'UNCERTAIN_INTENT_PAUSED');
  assert.equal(s.client.creates.length, 1);
});

test('mismatched or failed accepted transfers require review and block additional targets', async (t) => {
  for (const [name, overrides, expected] of [
    ['wrong amount', { amountInCents: 1 }, 'TOPUP_TRANSFER_IDENTITY_INVALID'],
    ['wrong destination', { destination: { id: ID(99), isDeleted: false } }, 'TOPUP_TRANSFER_IDENTITY_INVALID'],
    ['simulation outcome', { executionMode: 'SIMULATION' }, 'TOPUP_TRANSFER_IDENTITY_INVALID'],
    ['failed transfer', { status: 'ERROR', errorCode: 'PAYMENT_FAILED' }, 'TOPUP_DID_NOT_SETTLE'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); s.client.onCreate = (intent) => s.client.acceptIntent(intent, overrides);
      assert.equal((await s.run()).code, expected);
      assert.equal(event(s).status, 'REVIEW');
      assert.equal((await s.run()).code, 'UNRESOLVED_EVENT_REQUIRES_REVIEW');
      assert.equal(s.client.creates.length, 1);
    });
  }
});

test('additional destination accounts serialize behind the first accepted intent', async () => {
  const secondary = { id: 'equipment', destinationAccountId: ID(6), monthlyBudgetCents: 21000,
    reserveMonths: 2, targetCents: 42000, priority: 2, enabled: true, startsAt: null };
  const s = scenario({ allocations: [...makeConfig().allocations, secondary] });
  s.client.accounts.set(ID(6), cashAccount(ID(6), 10000));
  await s.run();
  assert.equal(s.client.creates[0].request.destinationAccountId, ID(3));
  await s.run();
  assert.equal(s.client.creates.length, 1);
  await finishFirst(s);
  assert.equal(event(s).status, 'OPEN');
  assert.equal((await s.run()).code, 'WAITING_FOR_POST_SETTLEMENT_BALANCE');
  assert.equal(s.client.creates.length, 1);
  s.clock.advance(1000);
  s.client.refreshCash({ income: 300000, general: 300000 });
  s.client.accounts.get(ID(6)).balance.balanceLastUpdatedAt = asISO(s.clock.value);
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 2);
  assert.equal(s.client.creates[1].request.destinationAccountId, ID(6));
  assert.equal(s.client.creates[1].request.amountInCents, 32000);
  assert.notEqual(s.client.creates[1].idempotencyKey, s.client.creates[0].idempotencyKey);
});

test('a target added later does not replay old refunds and starts on a new eligible payout', async () => {
  const s = scenario();
  await s.run(); await finishFirst(s);
  const oldKey = event(s).key;
  const secondary = { id: 'equipment', destinationAccountId: ID(6), monthlyBudgetCents: 21000,
    reserveMonths: 2, targetCents: 42000, priority: 2, enabled: true, startsAt: null };
  s.config = makeConfig({ ...s.config, allocations: [...s.config.allocations, secondary] });
  s.client.accounts.set(ID(6), cashAccount(ID(6), 10000));
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.store.value.events[oldKey].children.equipment, undefined);
  s.clock.advance(3600000);
  s.client.addRefund({ executionId: ID(202), refundId: ID(102),
    startedAt: asISO(s.clock.value - 10 * 60000), createdAt: asISO(s.clock.value - 9 * 60000),
    completedAt: asISO(s.clock.value - 5 * 60000) });
  s.client.refreshCash({ general: 300000, income: 300000, at: asISO(s.clock.value - 60000) });
  s.client.accounts.get(ID(6)).balance.balanceLastUpdatedAt = asISO(s.clock.value - 60000);
  assert.equal((await s.run()).code, 'TARGET_ALREADY_MET');
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 2);
  assert.equal(s.client.creates[1].request.destinationAccountId, ID(6));
});

test('re-enabling an additional allocation excludes unhandled older refunds and permits later payouts', async () => {
  const secondary = { id: 'equipment', destinationAccountId: ID(6), monthlyBudgetCents: 21000,
    reserveMonths: 2, targetCents: 42000, priority: 2, enabled: false, startsAt: null };
  const s = scenario({ allocations: [...makeConfig().allocations, secondary] });
  s.client.accounts.set(ID(6), cashAccount(ID(6), 10000));
  s.client.transfers.clear();
  s.client.executions.clear();
  assert.equal((await s.run()).code, 'NO_NEW_SETTLED_REFUND');
  assert.equal(s.store.value.allocations.equipment.enabled, false);

  s.clock.advance(3600000);
  s.client.addRefund({ startedAt: asISO(s.clock.value - 50 * 60000),
    createdAt: asISO(s.clock.value - 40 * 60000), completedAt: asISO(s.clock.value - 30 * 60000) });
  s.client.refreshCash({ general: 300000, at: asISO(s.clock.value - 60000) });
  s.config = makeConfig({ ...s.config, allocations: s.config.allocations.map((allocation) =>
    allocation.id === 'equipment' ? { ...allocation, enabled: true } : allocation) });
  const enabledAt = asISO(s.clock.value);
  assert.equal((await s.run()).code, 'TARGET_ALREADY_MET');
  assert.equal(s.store.value.allocations.equipment.enabled, true);
  assert.equal(s.store.value.allocations.equipment.firstEligibleAt, enabledAt);
  assert.equal(event(s).children.equipment, undefined);
  assert.equal(event(s).status, 'COMPLETE');
  noWrites(s);

  s.clock.advance(3600000);
  s.client.addRefund({ executionId: ID(202), refundId: ID(102),
    startedAt: asISO(s.clock.value - 20 * 60000), createdAt: asISO(s.clock.value - 15 * 60000),
    completedAt: asISO(s.clock.value - 10 * 60000) });
  s.client.refreshCash({ at: asISO(s.clock.value - 60000) });
  s.client.accounts.get(ID(6)).balance.balanceLastUpdatedAt = asISO(s.clock.value - 60000);
  assert.equal((await s.run()).code, 'TARGET_ALREADY_MET');
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  assert.equal(s.client.creates[0].request.destinationAccountId, ID(6));
  assert.equal(s.client.creates[0].request.amountInCents, 32000);
});

test('re-enabling cannot revive an older durable waiting child after an upstream-blocked disabled run', async () => {
  const secondary = { id: 'equipment', destinationAccountId: ID(6), monthlyBudgetCents: 21000,
    reserveMonths: 2, targetCents: 42000, priority: 2, enabled: true, startsAt: null };
  const s = scenario({ allocations: [...makeConfig().allocations, secondary] });
  s.client.accounts.set(ID(6), cashAccount(ID(6), 10000));
  s.client.refreshCash({ general: 300000 });
  assert.equal((await s.run()).code, 'TARGET_ALREADY_MET');
  assert.equal(event(s).children.equipment.status, 'WAITING');
  const enable = (enabled) => {
    s.config = makeConfig({ ...s.config, allocations: s.config.allocations.map((allocation) =>
      allocation.id === 'equipment' ? { ...allocation, enabled } : allocation) });
  };
  enable(false);
  s.client.executions.set(ID(301), { id: ID(301), ruleId: s.config.rules.funding,
    executionMode: 'LIVE', status: 'IN_PROGRESS', createdAt: asISO(s.clock.value - 60000) });
  assert.equal((await s.run()).code, 'UPSTREAM_FUNDING_PENDING');
  assert.equal(s.store.value.allocations.equipment.enabled, false);
  s.clock.advance(3600000);
  enable(true);
  Object.assign(s.client.executions.get(ID(301)), { status: 'EXECUTED', transferIds: [],
    transfersAttempted: 0, transfersCompleted: 0, transfersPending: 0, transfersFailed: 0,
    conditionsNotMet: true, stepIndexMatched: null, nextAttemptAt: null, errorMessage: null });
  s.client.refreshCash();
  s.client.accounts.get(ID(6)).balance.balanceLastUpdatedAt = asISO(s.clock.value);
  await s.run();
  noWrites(s);
  assert.equal(event(s).children.equipment.status, 'SKIPPED');
  assert.equal(event(s).status, 'COMPLETE');
});

test('pre-activation payout completed later cannot starve a valid newer payout', async () => {
  const s = scenario({ activationAt: asISO(TEST_NOW - 3 * 3600000) });
  s.client.executions.get(ID(201)).createdAt = asISO(TEST_NOW - 4 * 3600000);
  s.client.addRefund({ executionId: ID(202), refundId: ID(102), startedAt: asISO(TEST_NOW - 80 * 60000),
    createdAt: asISO(TEST_NOW - 70 * 60000), completedAt: asISO(TEST_NOW - 50 * 60000) });
  assert.equal((await s.run()).code, 'TOPUP_PENDING');
  assert.equal(s.client.creates.length, 1);
  assert.ok(s.client.creates[0].request.reasonForApproval.includes(ID(202)));
});

test('rule activation and legacy-rule separation are real execution gates', async (t) => {
  for (const [name, ruleName, status, expected] of [
    ['payout paused', 'payout', 'DISABLED', 'UPSTREAM_RULE_DISABLED'],
    ['funding paused', 'funding', 'DISABLED', 'UPSTREAM_RULE_DISABLED'],
    ['legacy top-up active', 'legacyGeneral', 'ENABLED', 'LEGACY_TOPUP_RULE_MUST_BE_DISABLED'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); s.client.rules.get(s.config.rules[ruleName]).status = status;
      assert.equal((await s.run()).code, expected); noWrites(s);
    });
  }
});

test('activation, source/rule bindings and existing destination identity cannot silently change', async (t) => {
  for (const [name, change, expected] of [
    ['activation moved', (s) => ({ activationAt: asISO(TEST_NOW - 12 * 3600000) }), 'ACTIVATION_TIME_CHANGED'],
    ['source changed', (s) => ({ accounts: { ...s.config.accounts, income: ID(99) } }), 'ACCOUNT_OR_RULE_BINDING_CHANGED'],
    ['destination changed', (s) => ({ allocations: s.config.allocations.map((allocation) => allocation.id === 'general-spending'
      ? { ...allocation, destinationAccountId: ID(99) } : allocation) }), 'ALLOCATION_DESTINATION_CHANGED'],
  ]) {
    await t.test(name, async () => {
      const s = scenario(); s.client.refreshCash({ general: 300000 });
      await s.run(); noWrites(s);
      s.config = makeConfig({ ...s.config, ...change(s) });
      assert.equal((await s.run()).code, expected); noWrites(s);
    });
  }
});

test('ledger validation rejects changed immutable requests and inconsistent identity pointers', async () => {
  const s = scenario(); await s.run();
  const altered = structuredClone(s.store.value);
  Object.values(altered.events)[0].children['general-spending'].request.amountInCents += 1;
  assert.throws(() => validateState(altered), codeIs('LEDGER_REQUEST_CHANGED'));
  const wrongKey = structuredClone(s.store.value);
  Object.values(wrongKey.events)[0].key = 'different-key';
  assert.throws(() => validateState(wrongKey), codeIs('LEDGER_EVENT_INVALID'));
  await finishFirst(s);
  const finalPointer = structuredClone(s.store.value);
  finalPointer.active = { eventKey: Object.keys(finalPointer.events)[0], allocationId: 'general-spending' };
  assert.throws(() => validateState(finalPointer), codeIs('LEDGER_RESERVATION_INVALID'));
  const wrongChild = structuredClone(s.store.value);
  Object.values(wrongChild.events)[0].children['general-spending'].allocationId = 'different-child';
  assert.throws(() => validateState(wrongChild), codeIs('LEDGER_CHILD_INVALID'));
});

test('financial-evidence timestamps require valid calendar dates and explicit timezones', () => {
  for (const timestamp of ['2029-02-30T12:00:00Z', '2030-01-02T11:30:00', '2029-04-31T12:00:00Z']) {
    assert.throws(() => validTime(timestamp, TEST_NOW), 'Malformed provider timestamp must not qualify');
  }
});
