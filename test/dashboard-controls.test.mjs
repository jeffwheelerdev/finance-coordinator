import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/engine.mjs';
import { dashboardControlView, parseDashboardChanges, prepareDashboardControlUpdate, resolveDashboardConfig,
  validateDashboardControls, nextMonthlySlot } from '../lib/dashboard-controls.mjs';
import { validateMonthlyState } from '../lib/monthly-engine.mjs';
import { monthlyFixture } from './monthly-fixture.mjs';

const at = value => Date.parse(value);
const staging = s => ({ ...s.config, mode: 'observe', liveEnabled: false });
function save(s, changes, now = s.clock.value) {
  const state = s.store.value ?? initialState();
  const result = prepareDashboardControlUpdate({ config: s.config, state,
    expectedRevision: state.dashboardControls?.revision ?? 0, changes, now });
  s.store.replaceForTest(result.state); return result;
}

test('editable controls are exact cents and basis points; financial facts and operational gates cannot be edited', () => {
  assert.deepEqual(parseDashboardChanges({ generalMonthlyBudgetCents: 85000, projectRateBasisPoints: 725, executionDay: 28 }),
    { generalMonthlyBudgetCents: 85000, projectRateBasisPoints: 725, executionDay: 28 });
  for (const changes of [{}, null, [], { annualRothLimitCents: 800000 }, { liveEnabled: true }, { accountId: 'other' },
    { billsTargetCents: 0 }, { generalMonthlyBudgetCents: 850.25 }, { generalMonthlyBudgetCents: '85000' },
    { emergencyRateBasisPoints: 10001 }, { projectRateBasisPoints: -1 }, { executionDay: 29 }, { decemberDay: 16 },
    { generalReserveMonths: 0 }, { constructor: 1 }]) {
    assert.throws(() => parseDashboardChanges(changes), { code: 'DASHBOARD_SETTINGS_INVALID' });
  }
  const s = monthlyFixture({ mode: 'observe' });
  assert.throws(() => prepareDashboardControlUpdate({ config: s.config, state: initialState(), expectedRevision: 0,
    changes: { generalMonthlyBudgetCents: Number.MAX_SAFE_INTEGER, generalReserveMonths: 2 }, now: s.clock.value }),
  { code: 'DASHBOARD_SETTINGS_INVALID' });
});

test('a settings save preserves every financial field and includes an immutable revision audit', () => {
  const s = monthlyFixture({ mode: 'observe' }), state = initialState(), before = structuredClone(state);
  const now = at('2030-01-01T14:30:00.000Z');
  const result = prepareDashboardControlUpdate({ config: s.config, state, expectedRevision: 0,
    changes: { generalMonthlyBudgetCents: 85000 }, now, actor: 'owner' });
  assert.deepEqual(state, before);
  const { dashboardControls, ...financial } = result.state;
  assert.deepEqual(financial, before);
  assert.equal(dashboardControls.revision, 1);
  assert.equal(result.settings.current.settings.generalMonthlyBudgetCents, 85000);
  assert.equal(result.settings.history[0].actor, 'owner');
  assert.equal(result.settings.history[0].before.generalMonthlyBudgetCents, 100000);
  assert.equal(result.settings.history[0].after.generalMonthlyBudgetCents, 85000);
  assert.equal(resolveDashboardConfig(s.config, result.state, { now }).allocations.find(row => row.id === 'general-spending').targetCents, 255000);
  assert.equal(s.config.allocations.find(row => row.id === 'general-spending').targetCents, 300000);
  const tampered = structuredClone(dashboardControls); tampered.versions[0].after.generalMonthlyBudgetCents = 1;
  assert.throws(() => validateDashboardControls(tampered), { code: 'DASHBOARD_SETTINGS_HISTORY_INVALID' });
});

test('stale revisions and active financial leases reject settings without changing any state', () => {
  const s = monthlyFixture({ mode: 'observe' }), state = initialState(), now = s.clock.value;
  assert.throws(() => prepareDashboardControlUpdate({ config: s.config, state, expectedRevision: 1,
    changes: { executionDay: 5 }, now }), { code: 'DASHBOARD_SETTINGS_CONFLICT' });
  state.lease = { owner: 'worker', expiresAt: new Date(now + 1000).toISOString() };
  const original = structuredClone(state);
  assert.throws(() => prepareDashboardControlUpdate({ config: s.config, state, expectedRevision: 0,
    changes: { executionDay: 5 }, now }), { code: 'DASHBOARD_WORKER_ACTIVE' });
  assert.deepEqual(state, original);
});

test('inactive edits choose a future opportunity and subsequent partial edits retain previously scheduled values', () => {
  const s = monthlyFixture({ mode: 'observe' });
  const first = prepareDashboardControlUpdate({ config: s.config, state: initialState(), expectedRevision: 0,
    changes: { generalMonthlyBudgetCents: 85000 }, now: at('2030-01-01T16:00:00.000Z') });
  assert.equal(first.settings.pending[0].effectiveMonth, '2030-02');
  const next = prepareDashboardControlUpdate({ config: s.config, state: first.state, expectedRevision: 1,
    changes: { executionDay: 15 }, now: at('2030-01-02T16:00:00.000Z') });
  assert.equal(next.settings.pending.length, 1);
  assert.equal(next.settings.pending[0].effectiveMonth, '2030-02');
  assert.equal(next.settings.pending[0].settings.generalMonthlyBudgetCents, 85000);
  assert.equal(next.settings.pending[0].settings.executionDay, 15);
  assert.equal(next.settings.current.settings.executionDay, 1);
  assert.equal(nextMonthlySlot({ config: s.config, state: next.state, now: at('2030-01-02T16:00:00.000Z') }).dueAt,
    '2030-02-15T15:00:00.000Z');
  const stagedEarlier = prepareDashboardControlUpdate({ config: s.config, state: initialState(), expectedRevision: 0,
    changes: { executionDay: 5 }, now: at('2030-01-02T16:00:00.000Z') });
  assert.equal(stagedEarlier.settings.current.effectiveMonth, '2030-01');
  assert.equal(nextMonthlySlot({ config: s.config, state: stagedEarlier.state, now: at('2030-01-02T16:00:00.000Z') }).dueAt,
    '2030-01-05T15:00:00.000Z');
});

test('a live initial cutoff evaluates its executable current month, while observe preparation stays prospective', () => {
  const s = monthlyFixture({ activationAt: '2030-12-01T14:00:00.000Z' }), now = at('2030-12-01T15:05:00.000Z');
  assert.equal(nextMonthlySlot({ config: s.config, state: initialState(), now }).monthKey, '2030-12');
  assert.equal(nextMonthlySlot({ config: staging(s), state: initialState(), now }).monthKey, '2031-01');
});

test('active budget, percentage and date edits apply next month without changing frozen requests or binding', async () => {
  const s = monthlyFixture({ emergency: 0 }); await s.run();
  const jan = structuredClone(s.store.value.monthly.cycles['2030-01']);
  const binding = s.store.value.monthly.bindingHash, requests = structuredClone(s.client.creates);
  s.advance('2030-01-01T16:00:00.000Z');
  const changed = save(s, { generalMonthlyBudgetCents: 120000, emergencyRateBasisPoints: 1000,
    projectRateBasisPoints: 750, executionDay: 5 });
  assert.equal(changed.settings.current.revision, 0);
  assert.equal(changed.settings.pending[0].effectiveMonth, '2030-02');
  await s.run();
  assert.deepEqual(s.store.value.monthly.cycles['2030-01'].plan, jan.plan);
  assert.deepEqual(s.store.value.monthly.cycles['2030-01'].settingsSnapshot, jan.settingsSnapshot);
  assert.deepEqual(s.client.creates, requests);
  s.settleAll(); await s.run();
  s.advance('2030-02-01T15:00:00.000Z'); s.deposit(500000);
  assert.equal((await s.run()).code, 'MONTHLY_NOT_DUE');
  assert.equal(s.store.value.monthly.cycles['2030-02'], undefined);
  s.advance('2030-02-05T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const feb = s.store.value.monthly.cycles['2030-02'];
  assert.equal(feb.settingsSnapshot.revision, 1);
  assert.equal(feb.slot.dueAt, '2030-02-05T15:00:00.000Z');
  assert.equal(feb.plan.generalTargetCents, 360000);
  assert.equal(feb.children['general-spending'].amountInCents, 60000);
  assert.deepEqual(feb.plan.percentageTargets, { emergencyCents: 51000, projectCents: 38250 });
  assert.equal(feb.children['roth-ira'].amountInCents, 62500);
  assert.equal(s.store.value.monthly.bindingHash, binding);
  assert.deepEqual(s.store.value.monthly.cycles['2030-01'].plan, jan.plan);
});

test('a later execution date cannot invent a preactivation month or reset the annual contribution history', async () => {
  const s = monthlyFixture({ activationAt: '2030-01-02T14:00:00.000Z' });
  s.advance('2030-01-02T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_NOT_DUE');
  assert.equal(s.store.value.monthly.firstEligibleMonth, '2030-02');
  save(s, { executionDay: 5 });
  s.advance('2030-01-05T15:00:00.000Z');
  assert.equal((await s.run()).code, 'MONTHLY_NOT_DUE');
  assert.deepEqual(s.store.value.monthly.obligations, {});
  s.advance('2030-02-05T15:00:00.000Z'); await s.run();
  assert.deepEqual(Object.keys(s.store.value.monthly.obligations), ['2030-02']);
  assert.equal(s.store.value.monthly.cycles['2030-02'].children['roth-ira'].amountInCents, 62500);
  assert.equal(s.store.value.monthly.firstEligibleMonth, '2030-02');
});

test('a future edit cannot alter the original same-key recovery window or its payload', async () => {
  const s = monthlyFixture({ mode: 'observe' });
  s.advance('2030-01-01T14:30:00.000Z'); save(s, { executionDay: 5 });
  s.config = { ...s.config, mode: 'live', liveEnabled: true };
  s.advance('2030-01-05T15:00:00.000Z');
  s.client.onCreate = () => { throw new Error('Synthetic unknown provider result'); };
  assert.equal((await s.run()).code, 'MONTHLY_SUBMISSION_UNKNOWN');
  const request = structuredClone(s.client.creates[0]);
  s.clock.advance(61000); save(s, { executionDay: 1, generalMonthlyBudgetCents: 85000 });
  s.client.onCreate = null;
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(s.client.creates[1], request);
  const cycle = s.store.value.monthly.cycles['2030-01'];
  assert.equal(cycle.slot.dayOfMonth, 5);
  assert.equal(cycle.settingsSnapshot.revision, 1);
  const corrupt = structuredClone(s.store.value); corrupt.monthly.cycles['2030-01'].slot.dayOfMonth = 6;
  assert.throws(() => validateMonthlyState(corrupt), { code: 'MONTHLY_CYCLE_SETTINGS_INVALID' });
});

test('an already completed monthly opportunity cannot be reopened by staging another date', async () => {
  const s = monthlyFixture(); await s.run(); s.settleAll(); await s.run();
  const before = structuredClone(s.store.value.monthly.cycles['2030-01']);
  s.config = staging(s); s.advance('2030-01-02T15:00:00.000Z');
  const result = save(s, { executionDay: 15 });
  assert.equal(result.settings.pending[0].effectiveMonth, '2030-02');
  assert.deepEqual(s.store.value.monthly.cycles['2030-01'], before);
  assert.equal(nextMonthlySlot({ config: s.config, state: s.store.value, now: s.clock.value }).monthKey, '2030-02');
  assert.equal(dashboardControlView({ config: s.config, state: s.store.value, now: s.clock.value }).revision, 1);
});
