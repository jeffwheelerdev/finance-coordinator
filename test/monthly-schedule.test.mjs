import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../lib/app.mjs';
import { monthlyFixture } from './monthly-fixture.mjs';
import { asISO } from './fixtures.mjs';
import { initialState } from '../lib/engine.mjs';
import { prepareDashboardControlUpdate } from '../lib/dashboard-controls.mjs';
import { monthlySlot, monthlyClock, monthlyWindow, firstEligibleMonth } from '../lib/monthly-schedule.mjs';

const deployment = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const HOUR = 3600000;
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Deliberately limited to the literal/range/wildcard syntax in this deployment.
// An unsupported schedule edit must receive a new review, not silently match.
function matchesField(expression, number) {
  if (expression === '*') return true;
  assert.match(expression, /^\d+(?:-\d+)?$/);
  const [first, last = first] = expression.split('-').map(Number);
  return number >= first && number <= last;
}
function schedulesAt(millis) {
  const date = new Date(millis);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  return deployment.crons.filter(row => {
    const fields = row.schedule.split(' ');
    assert.equal(fields.length, 5);
    return fields.every((field, index) => matchesField(field, values[index]));
  });
}

function routeFixture(month = '2030-01', settings = null) {
  const opening = `${month}-01T14:00:00.000Z`;
  const s = monthlyFixture({ activationAt: opening });
  s.advance(`${month}-01T15:00:00.000Z`);
  s.monthlyPolicy.updatedAt = opening;
  s.monthlyPolicy.opening.asOf = opening;
  const config = s.config, general = config.allocations.find(row => row.id === 'general-spending');
  if (settings) {
    const prepared = prepareDashboardControlUpdate({ config: { ...config, mode: 'observe', liveEnabled: false },
      state: initialState(), expectedRevision: 0, changes: settings, now: Date.parse(opening) });
    s.store.replaceForTest(prepared.state);
  }
  const secret = 'synthetic-schedule-route-secret';
  const env = {
    APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: opening,
    MONTHLY_PRIORITY_ENABLED: 'true', ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: config.roth.accountId,
    FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(Object.fromEntries(['income', 'pod', 'general', 'bills'].map(key => [key, config.accounts[key]]))),
    FINANCE_RULE_IDS_JSON: JSON.stringify(Object.fromEntries(['payout', 'funding', 'legacyGeneral'].map(key => [key, config.rules[key]]))),
    GENERAL_SPENDING_MONTHLY_BUDGET: (general.monthlyBudgetCents / 100).toFixed(2),
    GENERAL_SPENDING_RESERVE_MONTHS: String(general.reserveMonths), INCOME_RESERVE: (config.incomeReserveCents / 100).toFixed(2),
    EMERGENCY_ACCOUNT_ID: config.accounts.emergency, EMERGENCY_EXCESS_RULE_ID: config.rules.excess,
    PROJECT_ACCOUNT_ID: config.monthly.projectAccountId, PERSONAL_INVESTMENT_ACCOUNT_ID: config.monthly.personalAccountId,
    CRON_SECRET: secret, RESEND_API_KEY: 'synthetic-email-key', ALERTS_EMAIL_TO: 'recipient@example.test',
    ALERTS_EMAIL_FROM: 'sender@example.test',
  };
  const catalog = { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: opening, bills: [{
    id: 'synthetic-monthly-bill', name: 'Synthetic bill', kind: 'expense', status: 'active', amountCents: 45000,
    frequency: 'monthly', evidence: { type: 'user_confirmation', reference: 'Synthetic schedule fixture', observedAt: opening },
  }] };
  const app = createApp({ env, now: () => s.clock.value, storeFactory: () => s.store,
    clientFactory: () => s.client, alertSenderFactory: () => s.sendAlert,
    billsReader: async () => ({ bills_catalog: catalog, bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances',
      status: 'ok', checkedAt: asISO(s.clock.value), catalogUpdatedAt: catalog.updatedAt, reviewCodes: [] } }),
    rothReader: async () => ({ roth_policy: { schemaVersion: 1, policy: s.rothPolicy, evidence: s.rothEvidence } }),
    monthlyReader: async () => ({ monthly_policy: s.monthlyPolicy }), log: { error() {} } });
  // Synthetic authenticated wake samples exercise the financial endpoint's
  // calendar/idempotency guards. The scheduler adapter has its own publication
  // and delivery tests; these samples are not asserted to come from cron.
  s.reconcileWake = async (at, { authenticated = true } = {}) => {
    const time = typeof at === 'number' ? at : Date.parse(at);
    assert.ok(Number.isFinite(time));
    s.advance(asISO(time));
    const request = new Request('https://synthetic.example.test/api/reconcile', {
      headers: authenticated ? { authorization: `Bearer ${secret}` } : {},
    });
    const response = await app.fetch(request);
    return { status: response.status, body: await response.json() };
  };
  return s;
}

test('one daily producer cron has exactly one New York daily opportunity across DST and leap years', () => {
  assert.deepEqual(deployment.crons, [{ path: '/api/scheduler', schedule: '0 15 * * *' }]);
  const localDays = new Map();
  for (let year = 2026; year <= 2033; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      const monthStart = Date.UTC(year, month, 1);
      const nextMonth = Date.UTC(year, month + 1, 1);
      for (let at = monthStart; at < nextMonth; at += HOUR) {
        const expected = new Date(at).getUTCHours() === 15 ? 1 : 0;
        assert.equal(schedulesAt(at).length, expected, `missing or extra daily trigger at ${asISO(at)}`);
        if (expected) {
          const key = localDate.format(at);
          localDays.set(key, (localDays.get(key) ?? 0) + 1);
        }
      }
      for (const day of [1, 5, 15, 28]) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}`;
        const schedule = { executionDay: day, decemberDay: Math.min(day, 15) };
        const slot = monthlySlot(key, schedule), due = Date.parse(slot.dueAt), close = Date.parse(slot.closesAt);
        assert.equal(schedulesAt(due).length, 1, 'each configurable day has one daily producer kickoff');
        assert.equal(monthlyWindow(key, due - 1, schedule), false);
        for (let at = due; at < close; at += HOUR) {
          // Delayed queue wake samples have valid engine windows without an
          // additional cron trigger. Queue publication is checked separately.
          if (at > due) assert.equal(schedulesAt(at).length, 0);
          assert.equal(monthlyWindow(key, at, schedule), true);
          assert.equal(monthlyClock(at).day, slot.dayOfMonth);
        }
        assert.equal(monthlyWindow(key, close, schedule), false);
      }
    }
  }
  assert.ok([...localDays.values()].every(count => count === 1));
  assert.equal(localDays.size, (Date.UTC(2034, 0, 1) - Date.UTC(2026, 0, 1)) / (24 * HOUR));
});

test('calendar boundaries use actual New York midnight and an early December override', () => {
  assert.equal(monthlySlot('2030-01', { executionDay: 28 }).closesAt, '2030-01-29T05:00:00.000Z');
  assert.equal(monthlySlot('2030-07', { executionDay: 28 }).closesAt, '2030-07-29T04:00:00.000Z');
  assert.equal(monthlySlot('2028-02', { executionDay: 28 }).closesAt, '2028-02-29T05:00:00.000Z');
  assert.equal(monthlySlot('2030-12', { executionDay: 28 }).dueAt, '2030-12-01T15:00:00.000Z');
  assert.equal(monthlySlot('2030-12', { executionDay: 28, decemberDay: 15 }).dueAt, '2030-12-15T15:00:00.000Z');
  assert.equal(firstEligibleMonth('2030-01-03T12:00:00.000Z', { executionDay: 5 }), '2030-01');
  assert.equal(firstEligibleMonth('2030-01-05T15:00:00.001Z', { executionDay: 5 }), '2030-02');
  for (const bad of [{ executionDay: 0 }, { executionDay: 29 }, { decemberDay: 16 }, { dueHourUTC: 14 }, { timeZone: 'UTC' }]) {
    assert.throws(() => monthlySlot('2030-01', bad), { code: 'MONTHLY_SCHEDULE_INVALID' });
  }
});

test('the authenticated route reads a saved execution day and permits only that frozen New York opportunity', async () => {
  const s = routeFixture('2030-07', { executionDay: 5, projectRateBasisPoints: 750 });
  assert.equal((await s.reconcileWake('2030-07-01T15:00:00.000Z')).body.code, 'MONTHLY_NOT_DUE');
  assert.equal(s.client.creates.length, 0);
  assert.equal((await s.reconcileWake('2030-07-05T15:00:00.000Z')).body.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const cycle = s.store.value.monthly.cycles['2030-07'];
  assert.equal(cycle.settingsSnapshot.revision, 1);
  assert.equal(cycle.slot.dueAt, '2030-07-05T15:00:00.000Z');
  assert.equal(cycle.plan.percentageTargets.projectCents, 75000);
  const count = s.client.creates.length;
  await s.reconcileWake('2030-07-06T04:00:00.000Z');
  assert.equal(s.client.creates.length, count);
  assert.deepEqual(Object.keys(s.store.value.monthly.cycles), ['2030-07']);
});

test('later authenticated wake samples recover the exact request and duplicate deliveries cannot fund the month twice', async () => {
  const s = routeFixture();
  assert.equal((await s.reconcileWake('2030-01-01T15:00:00.000Z', { authenticated: false })).status, 401);
  assert.equal(s.client.creates.length, 0);
  s.client.onCreate = () => { throw new Error('Synthetic first attempt did not reach provider'); };
  const first = await s.reconcileWake('2030-01-01T15:00:00.000Z');
  assert.equal(first.body.code, 'MONTHLY_SUBMISSION_UNKNOWN');
  const request = structuredClone(s.client.creates[0]);
  const originalPlan = structuredClone(s.store.value.monthly.cycles['2030-01'].plan);
  s.client.onCreate = null;
  assert.equal((await s.reconcileWake('2030-01-01T16:00:00.000Z')).body.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(s.client.creates[1], request);
  assert.equal(s.client.accepted.size, 6);
  assert.deepEqual(s.client.creates.slice(1).map(row => row.request.destinationAccountId), [s.config.accounts.bills,
    s.config.accounts.general, s.config.accounts.emergency, s.config.roth.accountId,
    s.config.monthly.projectAccountId, s.config.monthly.personalAccountId]);
  const responses = await Promise.all([s.reconcileWake('2030-01-01T17:00:00.000Z'), s.reconcileWake('2030-01-01T17:00:00.000Z')]);
  assert.ok(responses.some(row => row.body.code === 'MONTHLY_TRANSFERS_PENDING'));
  for (let at = Date.parse('2030-01-01T18:00:00.000Z'); at <= Date.parse('2030-01-02T04:00:00.000Z'); at += HOUR) await s.reconcileWake(at);
  assert.equal(s.client.creates.length, 7); // Six unique requests plus the exact same-key recovery.
  assert.equal(s.client.accepted.size, 6);
  assert.deepEqual(Object.keys(s.store.value.monthly.cycles), ['2030-01']);
  assert.deepEqual(s.store.value.monthly.cycles['2030-01'].plan, originalPlan);
});

test('the final UTC retry uses the real New York calendar guard in standard and daylight time', async t => {
  await t.test('04 UTC on January 2 can still fund January 1 at 11 p.m. New York time', async () => {
    const s = routeFixture('2030-01');
    const result = await s.reconcileWake('2030-01-02T04:00:00.000Z');
    assert.equal(result.body.code, 'MONTHLY_TRANSFERS_SUBMITTED');
    assert.equal(s.client.accepted.size, 6);
  });
  await t.test('03 UTC on July 2 can fund July 1 at 11 p.m., but 04 UTC cannot start a missed cycle', async () => {
    const inWindow = routeFixture('2030-07');
    assert.equal((await inWindow.reconcileWake('2030-07-02T03:00:00.000Z')).body.code, 'MONTHLY_TRANSFERS_SUBMITTED');
    assert.equal(inWindow.client.accepted.size, 6);
    const tooLate = routeFixture('2030-07');
    assert.equal((await tooLate.reconcileWake('2030-07-02T04:00:00.000Z')).body.code, 'MONTHLY_EXECUTION_DAY_ONLY');
    assert.equal(tooLate.client.creates.length, 0);
    assert.deepEqual(tooLate.store.value.monthly.cycles, {});
  });
  await t.test('an uncertain request cannot be replayed after local midnight', async () => {
    const s = routeFixture('2030-07');
    s.client.onCreate = () => { throw new Error('Synthetic unresolved request'); };
    assert.equal((await s.reconcileWake('2030-07-02T03:00:00.000Z')).body.code, 'MONTHLY_SUBMISSION_UNKNOWN');
    const frozen = structuredClone(s.client.creates[0]);
    s.client.onCreate = null;
    assert.equal((await s.reconcileWake('2030-07-02T04:00:00.000Z')).body.code, 'MONTHLY_RECOVERY_WINDOW_CLOSED');
    assert.equal(s.client.creates.length, 1);
    assert.deepEqual(s.client.creates[0], frozen);
  });
});
