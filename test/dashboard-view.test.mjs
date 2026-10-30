import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardView, dashboardActivity, dashboardDebug, simulateDashboardPlan } from '../lib/dashboard-view.mjs';
import { readMonthlyEvidence } from '../lib/monthly-evidence.mjs';
import { reconcileIncome } from '../lib/income-ledger.mjs';
import { resolveDashboardConfig, dashboardControlView, prepareDashboardControlUpdate } from '../lib/dashboard-controls.mjs';
import { monthlyFixture as fixture, START } from './monthly-fixture.mjs';

const error = expected => value => value.code === expected;
const synthetic = overrides => ({ monthKey: '2030-01', regularIncomeCents: 1000000, windfallCents: 0,
  billsBalanceCents: 10000, generalBalanceCents: 100000, emergencyBalanceCents: 900000, ...overrides });
const simulate = (s, input = synthetic(), extra = {}) => simulateDashboardPlan({ config: s.config,
  billsTargetCents: 50000, rothMonthlyCents: 62500, input, now: START, ...extra });
const view = (s, extra = {}) => buildDashboardView({ config: s.config, state: s.store.value, now: s.clock.value, ...extra });
async function evidence(s) { return readMonthlyEvidence(s.client, s.config, { now: s.clock.value,
  externalFrom: s.monthlyPolicy.opening.asOf }); }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.freeze(value); for (const entry of Object.values(value)) deepFreeze(entry); } return value; }

test('seven real account roles are projected without exposing provider identifiers or inventing investment balances', async () => {
  const s = fixture(), actual = await evidence(s);
  const result = view(s, { evidence: actual });
  assert.deepEqual(result.accounts.map(row => row.role), ['income', 'bills', 'general', 'emergency', 'roth', 'project', 'personalInvestment']);
  assert.equal(result.accounts.length, 7);
  for (const role of ['roth', 'personalInvestment']) {
    const card = result.accounts.find(row => row.role === role);
    assert.equal(card.balanceStatus, 'unavailable'); assert.equal(card.balanceCents, null);
    assert.equal(card.availableBalanceCents, null); assert.equal(card.balanceAsOf, null);
  }
  assert.ok(!JSON.stringify(result).includes(s.config.accounts.income));
  assert.ok(!JSON.stringify(result).includes(s.config.accounts.pod));
  assert.ok(!JSON.stringify(result).includes('Fidelity'));
  assert.equal(result.flows.length, 6);
  assert.ok(result.flows.every(row => row.sourceRole === 'income'));
});

test('posted, available and reserved cash are distinct and the Emergency cap includes incoming commitments', async () => {
  const s = fixture(), actual = await evidence(s);
  Object.assign(actual.accountSnapshots.income, { balanceCents: 1000000, availableBalanceCents: 0, spendableCents: 0 });
  Object.assign(actual.accountSnapshots.emergency, { balanceCents: 990000, availableBalanceCents: 970000, pendingIncomingCents: 10000,
    fundingBalanceCents: 980000 });
  const result = view(s, { evidence: actual });
  const income = result.accounts.find(row => row.role === 'income');
  assert.equal(income.balanceCents, 1000000); assert.equal(income.availableBalanceCents, 0); assert.equal(income.spendableCents, 0);
  const emergency = result.accounts.find(row => row.role === 'emergency');
  assert.equal(emergency.balanceCents, 990000); assert.equal(emergency.targetCommittedBalanceCents, 1000000);
  assert.equal(result.income.pendingReservationsMayOverlap, true);
});

test('missing or failed classification stays unknown instead of becoming zero regular or windfall funds', async () => {
  const s = fixture(), actual = await evidence(s);
  const missing = view(s, { evidence: actual, sectionErrors: { income: 'INCOME_OPENING_UNVERIFIED' } });
  assert.equal(missing.income.status, 'unavailable');
  for (const key of ['availableRegularCents', 'windfallHeldCents', 'priorYearWindfallHeldCents', 'unknownHeldCents']) assert.equal(missing.income[key], null);
  const pools = reconcileIncome({ policy: s.monthlyPolicy, evidence: actual });
  const reconciled = view(s, { evidence: actual, incomePools: pools });
  assert.equal(reconciled.income.status, 'reconciled'); assert.equal(reconciled.income.availableRegularCents, 1000000);
  assert.equal(reconciled.income.windfallHeldCents, 0);
  const blocked = view(s, { evidence: actual, incomePools: pools, sectionErrors: { income: 'INCOME_PROTECTED_CASH_MISSING' } });
  assert.equal(blocked.income.availableRegularCents, null);
});

test('balance freshness uses the bank timestamp and rejects future or missing timestamps', async () => {
  const s = fixture(), actual = await evidence(s);
  actual.accountSnapshots.bills.observedAt = new Date(START - s.config.maxBalanceAgeMs - 1).toISOString();
  actual.accountSnapshots.general.observedAt = new Date(START + 1).toISOString();
  actual.accountSnapshots.emergency.observedAt = null;
  const result = view(s, { evidence: actual });
  assert.equal(result.accounts.find(row => row.role === 'bills').balanceStatus, 'stale');
  assert.equal(result.accounts.find(row => row.role === 'general').balanceCents, null);
  assert.equal(result.accounts.find(row => row.role === 'emergency').balanceCents, null);
});

test('a frozen pending plan stays visible during policy and provider outages', async () => {
  const s = fixture(); await s.run();
  const result = view(s, { sectionErrors: { bills: 'BILLS_MONITOR_STALE', accounts: 'SEQUENCE_UNAVAILABLE', income: 'INCOME_HISTORY_GAP' } });
  assert.equal(result.cycle.kind, 'frozen'); assert.equal(result.cycle.totalPlannedCents, 990000);
  assert.equal(result.system.pendingCount, 6);
  assert.equal(result.flows.find(row => row.allocationId === 'roth-ira').executionStatus, 'pending');
  assert.equal(result.flows.find(row => row.allocationId === 'roth-ira').settledCents, 0);
  assert.equal(result.accounts.find(row => row.role === 'income').balanceCents, null);
  assert.equal(result.sections.bills.code, 'BILLS_MONITOR_STALE');
  assert.ok(result.activity.items.some(row => row.kind === 'allocation'));
});

test('unavailable ledger is not presented as no transfers, no contributions, or an empty completed plan', () => {
  const s = fixture();
  const result = view(s, { sectionErrors: { ledger: 'STORE_UNAVAILABLE' } });
  assert.equal(result.cycle.kind, 'unavailable'); assert.equal(result.system.pendingCount, null);
  assert.equal(result.annual.roth.settledCents, null); assert.equal(result.activity.totalCount, null);
  assert.equal(result.flows[0].settledCents, null); assert.equal(result.alerts.totalCount, null);
});

test('plan arithmetic is not confused with provider submission or settlement', async () => {
  const s = fixture(); await s.run();
  const cycle = s.store.value.monthly.cycles['2030-01'], child = cycle.children.bills;
  child.status = 'PLANNED'; delete child.request; delete child.transferId;
  const result = view(s).flows.find(row => row.allocationId === 'bills');
  assert.equal(result.planReason, 'FUNDED'); assert.equal(result.executionStatus, 'planned');
  assert.equal(result.plannedCents, 40000); assert.equal(result.submittedCents, 0); assert.equal(result.settledCents, 0);
  assert.equal(result.code, null);
});

test('unknown, approval-required, rejected and review states are distinguishable', async t => {
  const s = fixture(); await s.run();
  for (const [status, providerStatus, reason, expected] of [
    ['SUBMITTING', undefined, undefined, 'submission_unknown'], ['PENDING', 'APPROVAL_PENDING', undefined, 'approval_required'],
    ['REVIEW', 'ERROR', 'MONTHLY_TRANSFER_FAILED', 'failed'], ['REVIEW', undefined, 'MONTHLY_TRANSFER_IDENTITY_INVALID', 'review_required'],
    ['REVIEW', undefined, 'MONTHLY_PROVIDER_REJECTED', 'failed'], ['NOOP', undefined, 'BELOW_PROVIDER_MINIMUM', 'not_needed'],
    ['SKIPPED', undefined, 'MONTHLY_FIRST_DAY_MISSED', 'skipped'],
  ]) await t.test(expected + ':' + (reason ?? providerStatus ?? status), () => {
    const state = structuredClone(s.store.value), child = state.monthly.cycles['2030-01'].children.bills;
    Object.assign(child, { status, providerStatus, reason });
    if (status === 'SUBMITTING') delete child.transferId;
    const line = view(s, { state }).flows.find(row => row.allocationId === 'bills');
    assert.equal(line.executionStatus, expected);
    assert.equal(line.settledCents, 0);
    if (status === 'SUBMITTING') assert.equal(line.submittedCents, 0);
  });
});

test('a closed cycle with skipped legs does not claim all money settled', async () => {
  const s = fixture(); await s.run();
  const cycle = s.store.value.monthly.cycles['2030-01']; cycle.status = 'COMPLETE';
  for (const child of Object.values(cycle.children)) { child.status = 'SKIPPED'; delete child.request; delete child.transferId; }
  const result = view(s);
  assert.equal(result.cycle.status, 'COMPLETE'); assert.equal(result.cycle.skippedCount, 6); assert.equal(result.cycle.settledCents, 0);
});

test('annual contribution progress separates committed, pending and completed amounts', async () => {
  const s = fixture(); await s.run();
  const pending = view(s, { rothSummary: { monthlyAmountCents: 62500, annualLimitCents: 750000, remainingAnnualCents: 687500 } });
  assert.equal(pending.annual.roth.committedCents, 62500); assert.equal(pending.annual.roth.pendingCents, 62500);
  assert.equal(pending.annual.roth.settledCents, 0); assert.equal(pending.annual.roth.remainingAnnualCents, 687500);
  s.settleAll(); await s.run();
  const complete = view(s);
  assert.equal(complete.annual.roth.settledCents, 62500); assert.equal(complete.annual.roth.pendingCents, 0);
  assert.equal(complete.annual.roth.remainingAnnualCents, null);
});

test('Emergency excess return is a reverse flow and does not inflate outbound plan completion', async () => {
  const s = fixture({ emergency: 1002500 }); await s.run(); s.settleAll(); await s.run();
  const result = view(s), returned = result.flows.find(row => row.allocationId === 'emergency-excess');
  assert.equal(returned.sourceRole, 'emergency'); assert.equal(returned.destinationRole, 'income');
  assert.equal(returned.settledCents, 2500); assert.equal(result.cycle.emergencyReturnSettledCents, 2500);
  assert.equal(result.cycle.settledCents, result.cycle.totalPlannedCents);
});

test('future settings and frozen cycle dates are reported separately without actor identity', async () => {
  const s = fixture(); await s.run();
  const prepared = prepareDashboardControlUpdate({ config: s.config, state: s.store.value, expectedRevision: 0,
    changes: { generalMonthlyBudgetCents: 85000, executionDay: 15 }, now: START + 1000, actor: 'private-owner@example.com' });
  const state = prepared.state ?? prepared.nextState;
  assert.ok(state, 'settings helper exposes the next private state');
  const settings = dashboardControlView({ config: s.config, state, now: START + 1000 });
  const result = view(s, { state, settings, now: START + 1000 });
  assert.equal(result.settings.pending[0].effectiveMonth, '2030-02');
  assert.equal(result.settings.pending[0].settings.generalMonthlyBudgetCents, 85000);
  assert.ok(!JSON.stringify(result).includes('private-owner@example.com'));
  assert.equal(result.cycle.monthKey, '2030-01');
});

test('activity paginates recorded cycles and all historical allocations without provider IDs', async () => {
  const s = fixture(); await s.run();
  const state = structuredClone(s.store.value), original = state.monthly.cycles['2030-01'];
  state.monthly.cycles['2029-12'] = { ...structuredClone(original), monthKey: '2029-12', createdAt: '2029-12-01T15:00:00.000Z' };
  const keys = []; let cursor = null, pages = 0;
  do { const page = dashboardActivity({ state, cursor, limit: 3 });
    keys.push(...page.items.map(row => row.key)); cursor = page.nextCursor; pages += 1;
    assert.equal(page.completeRunLog, false); assert.ok(!JSON.stringify(page).includes(s.config.accounts.income));
  } while (cursor);
  assert.equal(keys.length, 14); assert.equal(new Set(keys).size, 14); assert.equal(pages, 5);
});

test('activity cursors fail closed on changed snapshots, invalid encoding and unbounded requests', async () => {
  const s = fixture(); await s.run();
  const first = dashboardActivity({ state: s.store.value, limit: 1 });
  s.store.value.monthly.cycles['2030-01'].children.bills.status = 'REVIEW';
  assert.throws(() => dashboardActivity({ state: s.store.value, cursor: first.nextCursor }), error('DASHBOARD_ACTIVITY_CHANGED'));
  for (const cursor of ['', '!', 'x'.repeat(161), Buffer.from('{}').toString('base64url')]) {
    assert.throws(() => dashboardActivity({ state: s.store.value, cursor }), error('DASHBOARD_ACTIVITY_CURSOR_INVALID'));
  }
  for (const limit of [0, 101, 1.5, '25']) assert.throws(() => dashboardActivity({ state: s.store.value, limit }), error('DASHBOARD_ACTIVITY_LIMIT_INVALID'));
});

test('email lifecycle says provider accepted without asserting inbox receipt', async () => {
  const s = fixture(); await s.run();
  s.store.value.monthly.alerts.synthetic = { id: 'private-identifier', monthKey: '2030-01', code: 'ROTH_CASH_SHORTFALL',
    status: 'DELIVERED', createdAt: new Date(START).toISOString(), deliveredAt: new Date(START + 1).toISOString(),
    attempts: 1, recipient: 'private@example.com', deliveryId: s.config.accounts.income, shortfallCents: 1000 };
  const row = view(s).alerts.items[0];
  assert.equal(row.deliveryStatus, 'provider_accepted'); assert.equal(row.inboxReceipt, 'not_verified');
  assert.ok(!JSON.stringify(row).includes('private'));
});

test('debug export is bounded and excludes CSRF, credentials, private evidence and provider records', async () => {
  const s = fixture(); await s.run();
  const snapshot = view(s, { readiness: { status: 'blocked', checks: [{ id: 'email_delivery', status: 'blocked', codes: ['EMAIL_DELIVERY_UNVERIFIED'],
    recipient: 'private@example.com', reference: 'PRIVATE_PROOF' }], blockers: ['EMAIL_DELIVERY_UNVERIFIED'], secret: 'PRIVATE_KEY' } });
  Object.assign(snapshot, { csrfToken: 'PRIVATE_CSRF', rawState: s.store.value, secrets: 'PRIVATE_KEY', accountId: s.config.accounts.income });
  const result = dashboardDebug({ snapshot, state: s.store.value, now: START });
  const serialized = JSON.stringify(result);
  for (const denied of ['PRIVATE_CSRF', 'PRIVATE_KEY', 'PRIVATE_PROOF', 'private@example.com', s.config.accounts.income]) assert.ok(!serialized.includes(denied));
  assert.ok(Buffer.byteLength(serialized) <= 256 * 1024);
  assert.equal(result.activity.completeRunLog, false);
});

test('debug truncation is explicit at 100 activity and 50 alert records', async () => {
  const s = fixture(); await s.run();
  const state = structuredClone(s.store.value), original = state.monthly.cycles['2030-01'];
  for (let index = 1; index <= 30; index += 1) {
    const key = `${2020 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
    state.monthly.cycles[key] = { ...structuredClone(original), monthKey: key };
  }
  state.monthly.alerts = Object.fromEntries(Array.from({ length: 75 }, (_, index) => [String(index), {
    monthKey: '2030-01', code: 'ROTH_CASH_SHORTFALL', status: 'PENDING', createdAt: new Date(START).toISOString(), attempts: 0,
  }]));
  const result = dashboardDebug({ snapshot: view(s, { state }), state, now: START });
  assert.equal(result.activity.items.length, 100); assert.equal(result.alerts.items.length, 50);
  assert.equal(result.limits.activityTruncated, true); assert.equal(result.limits.alertsTruncated, true);
});

test('test receipts distinguish offline rehearsal from provider simulation and default to not run', () => {
  const s = fixture(), empty = view(s);
  assert.equal(empty.tests.offline.status, 'not_run'); assert.equal(empty.tests.provider.status, 'not_run');
  const result = view(s, { tests: { offline: { status: 'passed', syntheticDataOnly: true, scenarioCount: 5,
    softwareVersion: '0.6.2', networkAttempts: 0, realTransfers: 0, realEmails: 0, raw: 'PRIVATE' },
    provider: { status: 'passed', syntheticProbes: true, realTransferRequested: false, requestCount: 7,
      results: [{ label: 'income_to_roth', amountInCents: 62500, status: 'passed', executionMode: 'SIMULATION', providerId: 'PRIVATE' }], unattendedApprovalProven: true } } });
  assert.equal(result.tests.provider.unattendedApprovalProven, false); assert.equal(result.tests.provider.settlementProven, false);
  assert.equal(result.tests.offline.syntheticDataOnly, true); assert.ok(!JSON.stringify(result.tests).includes('PRIVATE'));
});

test('scheduler receipt distinguishes enqueue acknowledgement, delivery proof and outdated proof without private identifiers', () => {
  const s = fixture(); assert.equal(view(s).tests.scheduler.status, 'not_run');
  for (const status of ['pending', 'queued', 'unknown', 'completed', 'expired', 'unverified']) {
    const snapshot = view(s, { tests: { scheduler: { status, queuedAt: new Date(START).toISOString(),
      expiresAt: new Date(START + 300_000).toISOString(), completedAt: status === 'completed' ? new Date(START + 60_000).toISOString() : null,
      checkedAt: new Date(START).toISOString(), softwareVersion: '0.7.0', code: 'SCHEDULER_PROBE_STATUS',
      transport: 'vercel-queue', authentication: 'vercel-oidc', target: 'health_only', realTransfers: 0, realEmails: 0,
      id: 'PRIVATE', deploymentId: 'PRIVATE', token: 'PRIVATE' } } });
    assert.equal(snapshot.tests.scheduler.status, status); assert.equal(snapshot.tests.scheduler.target, 'health_only');
    assert.equal(snapshot.tests.scheduler.realTransfers, 0); assert.ok(!JSON.stringify(snapshot.tests.scheduler).includes('PRIVATE'));
    const exported = dashboardDebug({ snapshot, now: START });
    assert.equal(exported.tests.scheduler.status, status); assert.ok(!JSON.stringify(exported.tests.scheduler).includes('PRIVATE'));
  }
});

test('run journal keeps confirmed acceptance and settlement separate from attempts and transfer milestones', () => {
  const s = fixture(), state = { monthly: {} };
  state.monthly.runHistory = [
    { at: new Date(START).toISOString(), mode: 'live', status: 'uncertain', code: 'MONTHLY_SUBMISSION_UNCERTAIN',
      monthKey: '2030-01', submittedCount: 0, settledCount: 0, rawError: 'PRIVATE', transferId: 'PRIVATE' },
    { at: new Date(START + 1000).toISOString(), mode: 'live', status: 'pending', code: 'MONTHLY_TRANSFERS_PENDING',
      monthKey: '2030-01', submittedCount: 1, settledCount: 0 },
    { at: new Date(START + 2000).toISOString(), mode: 'live', status: 'complete', code: 'MONTHLY_COMPLETE',
      monthKey: '2030-01', submittedCount: 0, settledCount: 1 },
  ];
  const result = view(s, { state });
  assert.equal(result.runs.status, 'available'); assert.equal(result.runs.storedCount, 3);
  assert.equal(result.runs.coverage, 'bounded_coordinator_runs'); assert.equal(result.runs.retentionReached, false);
  assert.deepEqual(result.runs.items.map(row => [row.submittedCount, row.settledCount]), [[0, 1], [1, 0], [0, 0]]);
  assert.equal(result.activity.totalCount, 0); assert.ok(!JSON.stringify(result.runs).includes('PRIVATE'));
  state.monthly.runHistory[2].settledCount = 8400;
  assert.equal(view(s, { state }).runs.items[0].settledCount, 8400);
});

test('run journal reports only retained records and bounds the debug export without inventing a discarded total', () => {
  const s = fixture(), state = { monthly: {} };
  state.monthly.runHistory = Array.from({ length: 100 }, (_, index) => ({
    at: new Date(START + index * 1000).toISOString(), mode: 'observe', status: 'observe', code: 'MONTHLY_OBSERVE',
    monthKey: '2030-01', submittedCount: 0, settledCount: 0,
  }));
  const snapshot = view(s, { state }), exported = dashboardDebug({ snapshot, state, now: START });
  assert.equal(snapshot.runs.items.length, 100); assert.equal(snapshot.runs.retentionReached, true);
  assert.equal(exported.runs.items.length, 50); assert.equal(exported.runs.storedCount, 100);
  assert.equal(exported.limits.maximumRunItems, 50); assert.equal(exported.limits.runsTruncated, true);
  assert.equal(exported.limits.runRetentionReached, true);
  assert.equal(exported.runs.items[0].at, new Date(START + 99000).toISOString());
  assert.equal(Object.hasOwn(exported.runs, 'discardedCount'), false);
});

test('legacy empty journal and unreadable ledger are different states', () => {
  const s = fixture(), legacy = view(s), unavailable = view(s, { sectionErrors: { ledger: 'STORE_UNAVAILABLE' } });
  assert.equal(legacy.runs.status, 'available'); assert.equal(legacy.runs.storedCount, 0);
  assert.equal(unavailable.runs.status, 'unavailable'); assert.equal(unavailable.runs.storedCount, null);
  const exported = dashboardDebug({ snapshot: unavailable, state: {}, now: START });
  assert.equal(exported.runs.status, 'unavailable'); assert.equal(exported.runs.storedCount, null);
});

test('invalid run journals cannot manufacture successful counts or unbounded output', () => {
  const s = fixture(), row = { at: new Date(START).toISOString(), mode: 'observe', status: 'observe',
    code: 'MONTHLY_OBSERVE', monthKey: '2030-01', submittedCount: 0, settledCount: 0 };
  const state = { monthly: {} };
  for (const invalid of [null, Array(101).fill(row), [{ ...row, status: 'success' }],
    [{ ...row, submittedCount: -1 }], [{ ...row, settledCount: 8401 }],
    [{ ...row, code: 'private account name' }], [{ ...row, monthKey: '2030-13' }]]) {
    state.monthly.runHistory = invalid;
    const result = view(s, { state }).runs;
    assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'DASHBOARD_RUN_HISTORY_INVALID');
    assert.equal(result.storedCount, null); assert.deepEqual(result.items, []);
  }
});

test('synthetic calculator follows the actual priority planner and does not claim bank execution', () => {
  const s = fixture(), result = simulate(s);
  assert.deepEqual(result.plan.allocations.map(row => row.amountInCents), [40000, 200000, 75000, 62500, 50000, 562500]);
  assert.equal(result.kind, 'synthetic_estimate'); assert.equal(result.realTransfers, 0); assert.equal(result.providerCalls, 0);
  assert.ok(result.flows.every(row => row.executionStatus === 'estimate' && row.settledCents === 0));
  assert.equal(result.assumptions.rothEligibility, 'hypothetical_only');
  assert.equal(result.assumptions.futureRothLimitsPredicted, false);
});

test('a 9000-dollar scenario keeps 4000 of windfall out of the 5000 regular percentage base', () => {
  const result = simulate(fixture(), synthetic({ regularIncomeCents: 500000, windfallCents: 400000,
    billsBalanceCents: 0, generalBalanceCents: 0 }));
  assert.equal(result.plan.openingRegularCents, 500000);
  assert.equal(result.plan.percentageTargets.emergencyCents, 37500); assert.equal(result.plan.percentageTargets.projectCents, 25000);
  assert.equal(result.plan.heldWindfallCents, 400000);
  assert.equal(result.plan.totalPlannedCents + result.plan.heldRegularCents + result.plan.heldWindfallCents, 900000);
});

test('December scenario uses only entered same-year shortfalls before Personal Investment', () => {
  const s = fixture(), result = simulate(s, synthetic({ monthKey: '2030-12', regularIncomeCents: 0, windfallCents: 400000,
    billsBalanceCents: 50000, generalBalanceCents: 300000, emergencyBalanceCents: 1000000,
    rothCarryCents: 100000, projectCarryCents: 50000 }), { config: { ...s.config, incomeReserveCents: 0 } });
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'roth-ira').windfallCents, 162500);
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'project-savings').windfallCents, 50000);
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'personal-investment').windfallCents, 187500);
  assert.equal(result.schedule.dayOfMonth, 1);
  assert.throws(() => simulate(fixture(), synthetic({ rothCarryCents: 100 })), error('DASHBOARD_SIMULATION_PRIOR_YEAR_CARRY_FORBIDDEN'));
});

test('unknown future Roth target remains unknown and blocks hypothetical lower priorities', () => {
  const result = simulate(fixture(), synthetic({ monthKey: '2035-04' }), { rothMonthlyCents: null });
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'roth-ira').monthlyTargetCents, null);
  assert.ok(result.plan.blockers.includes('ROTH_TARGET_UNVERIFIED'));
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'personal-investment').amountInCents, 0);
});

test('simulation uses effective editable amounts, rates and a separate early December date', () => {
  const s = fixture(), settings = { generalMonthlyBudgetCents: 85000, generalReserveMonths: 3, incomeReserveCents: 10000,
    emergencyTargetCents: 1200000, emergencyRateBasisPoints: 500, projectRateBasisPoints: 1000, executionDay: 20, decemberDay: 5 };
  const result = simulate(s, synthetic({ monthKey: '2030-06' }), { settings });
  assert.equal(result.plan.allocations.find(row => row.allocationId === 'general-spending').targetCents, 155000);
  assert.equal(result.plan.percentageTargets.emergencyCents, 50000); assert.equal(result.plan.percentageTargets.projectCents, 100000);
  assert.equal(result.schedule.dayOfMonth, 20); assert.equal(result.plan.incomeReserveCents, 10000);
  assert.equal(simulate(s, synthetic({ monthKey: '2030-12' }), { settings }).schedule.dayOfMonth, 5);
});

test('provider minimum is visible for mathematical allocations below one dollar', () => {
  const s = fixture(), result = simulate(s, synthetic({ regularIncomeCents: 50 }), { config: { ...s.config, incomeReserveCents: 0 } });
  assert.equal(result.flows[0].plannedCents, 50); assert.equal(result.flows[0].belowProviderMinimum, true);
  assert.equal(result.realTransfers, 0);
});

test('synthetic input rejects non-cent amounts, route overrides and missing fields', async t => {
  const s = fixture();
  for (const value of [-1, 0.01, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await t.test(String(value), () => {
    assert.throws(() => simulate(s, synthetic({ regularIncomeCents: value })), error('DASHBOARD_SIMULATION_INPUT_INVALID'));
  });
  for (const input of [{ ...synthetic(), accountId: s.config.accounts.income }, { ...synthetic(), simulation: false },
    { ...synthetic(), liveEnabled: true }, { ...synthetic(), monthKey: '2030-13' }, { regularIncomeCents: 100 }]) {
    assert.throws(() => simulate(s, input), error('DASHBOARD_SIMULATION_INPUT_INVALID'));
  }
});

test('all view functions are pure, have no network path, and do not mutate frozen financial state', async () => {
  const s = fixture(); await s.run();
  const config = deepFreeze(structuredClone(s.config)), state = deepFreeze(structuredClone(s.store.value));
  const before = JSON.stringify({ config, state });
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('Network forbidden'); };
  try {
    const snapshot = buildDashboardView({ config, state, now: START });
    dashboardActivity({ state }); dashboardDebug({ snapshot, state, now: START });
    simulateDashboardPlan({ config, billsTargetCents: 50000, rothMonthlyCents: 62500, input: deepFreeze(synthetic()), now: START });
    assert.equal(calls, 0); assert.equal(JSON.stringify({ config, state }), before);
  } finally { globalThis.fetch = original; }
});

test('activity refuses an oversized ledger instead of returning an unbounded export', () => {
  const cycles = {};
  for (let year = 2000; year < 2101; year += 1) for (let month = 1; month <= 12; month += 1) cycles[`${year}-${String(month).padStart(2, '0')}`] = {};
  assert.throws(() => dashboardActivity({ state: { monthly: { cycles } } }), error('DASHBOARD_LEDGER_LIMIT'));
});
