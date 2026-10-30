import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.mjs';
import { initialState } from '../lib/engine.mjs';
import { DASHBOARD_COOKIE, DASHBOARD_SESSION_MS } from '../lib/dashboard-access.mjs';
import { VERSION } from '../lib/config.mjs';
import { consumeSchedulerMessage, SCHEDULER_TOPIC } from '../lib/scheduler.mjs';
import { completeSchedulerProbe } from '../lib/scheduler-probe.mjs';
import { monthlyFixture, START } from './monthly-fixture.mjs';
import { ID, asISO } from './fixtures.mjs';

// All credentials, policies and provider responses are synthetic. The injected
// dependencies cannot reach a financial provider, inbox or production ledger.
const SECRET = 'synthetic-private-dashboard-machine-secret';
const ORIGIN = 'https://finance.example.test';
const UPDATED = '2030-01-01T14:00:00.000Z';
function setup(overrides = {}, { rehearsalReceipt } = {}) {
  const s = monthlyFixture({ mode: 'observe', regular: 500000, windfall: 400000, bills: 250000, general: 125000 });
  s.clock.value = START + 5 * 60000;
  const config = s.config;
  const environment = { APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', AUTOMATION_START_AT: '2030-01-01T14:00:00.000Z',
    FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ income: config.accounts.income, pod: config.accounts.pod, bills: config.accounts.bills, general: config.accounts.general }),
    FINANCE_RULE_IDS_JSON: JSON.stringify({ payout: config.rules.payout, funding: config.rules.funding, legacyGeneral: config.rules.legacyGeneral }),
    FINANCE_ALLOCATIONS_JSON: '[]', GENERAL_SPENDING_MONTHLY_BUDGET: '750', GENERAL_SPENDING_RESERVE_MONTHS: '3',
    INCOME_RESERVE: '0', MAX_BALANCE_AGE_HOURS: '26', MONTHLY_PRIORITY_ENABLED: 'true', ROTH_ENABLED: 'true',
    ROTH_ACCOUNT_ID: config.roth.accountId, EMERGENCY_ACCOUNT_ID: config.accounts.emergency,
    PROJECT_ACCOUNT_ID: config.monthly.projectAccountId, PERSONAL_INVESTMENT_ACCOUNT_ID: config.monthly.personalAccountId,
    EMERGENCY_EXCESS_RULE_ID: config.rules.excess, CRON_SECRET: SECRET,
    SEQUENCE_API_KEY: 'synthetic-private-sequence-key', BLOB_READ_WRITE_TOKEN: 'synthetic-private-blob-key',
    GLOBAL_CONFIG: 'synthetic-private-config-source', RESEND_API_KEY: 'synthetic-private-email-key',
    ALERTS_EMAIL_TO: 'private-recipient@example.test', ALERTS_EMAIL_FROM: 'Finance <private-sender@example.test>',
    VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: 'dpl_private_dashboard_test', FINANCE_CANONICAL_HOST: 'finance.example.test', DASHBOARD_ENABLED: 'true',
    DASHBOARD_ACCESS_POLICY: 'vercel-all-deployments', ...overrides };
  const bills = { bills_catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: UPDATED,
    bills: [{ id: 'private-bill', name: 'PRIVATE BILL NAME', kind: 'expense', status: 'active', amountCents: 340000,
      frequency: 'monthly', evidence: { type: 'user_confirmation', observedAt: UPDATED, reference: 'PRIVATE BILL PROOF' } }] },
    bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: asISO(s.clock.value), catalogUpdatedAt: UPDATED, reviewCodes: [] } };
  const monthly = { monthly_policy: s.monthlyPolicy };
  const roth = { roth_policy: { schemaVersion: 1, policy: s.rothPolicy, evidence: s.rothEvidence } };
  const readiness = { activation_policy: { schemaVersion: 1, updatedAt: UPDATED,
    sequenceAuthority: { status: 'unverified' }, emailDelivery: { status: 'unverified' } } };
  const calls = { bills: 0, roth: 0, monthly: 0, readiness: 0, factories: [], alertFactories: 0, emails: 0, emailTests: 0, probes: [] };
  const failures = {}, logs = [];
  const source = (name, value) => async () => { calls[name]++; if (failures[name]) throw failures[name]; return structuredClone(value); };
  const app = createApp({ env: environment, now: () => s.clock.value, storeFactory: () => s.store, rehearsalReceipt,
    clientFactory: (resolved, readOnly) => { calls.factories.push({ readOnly }); return s.client; },
    billsReader: source('bills', bills), rothReader: source('roth', roth), monthlyReader: source('monthly', monthly),
    readinessReader: source('readiness', readiness),
    alertSenderFactory: () => { calls.alertFactories++; return async () => { calls.emails++; throw new Error('UNEXPECTED EMAIL'); }; },
    emailTestFetch: async () => { calls.emailTests++; throw new Error('UNEXPECTED SETUP EMAIL'); },
    schedulerProbePublisher: async ({ probe }) => {
      calls.probes.push(structuredClone(probe));
      assert.equal(s.store.value.schedulerProbe.id, probe.id); assert.equal(s.store.value.schedulerProbe.status, 'pending');
      if (failures.scheduler) throw failures.scheduler;
      return { status: 'queued', deliveryConfirmed: false, expiresAt: probe.expiresAt };
    },
    log: { error: row => logs.push(row) } });
  const req = (path = '/api/dashboard', options = {}) => new Request(`${ORIGIN}${path}`, options);
  const open = async () => {
    const response = await app.fetch(req());
    const snapshot = await response.json();
    return { response, snapshot, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
  };
  const post = (path, body, session, options = {}) => req(path, { method: 'POST', body: JSON.stringify(body), ...options,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: session.cookie,
      'x-csrf-token': session.snapshot.csrfToken, ...options.headers } });
  return { ...s, env: environment, app, bills, monthly, roth, readiness, calls, failures, logs, req, open, post };
}
const cashInput = monthKey => ({ monthKey, regularIncomeCents: 500000, windfallCents: 400000,
  billsBalanceCents: 250000, generalBalanceCents: 125000, emergencyBalanceCents: 900000 });
function noFinancialWrites(s) {
  assert.equal(s.client.creates.length, 0); assert.equal(s.calls.alertFactories, 0);
  assert.equal(s.calls.emails, 0); assert.equal(s.calls.emailTests, 0);
}
function noPrivateValues(s, value) {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, s.env.SEQUENCE_API_KEY, s.env.BLOB_READ_WRITE_TOKEN, s.env.GLOBAL_CONFIG,
    s.env.RESEND_API_KEY, s.env.ALERTS_EMAIL_TO, s.env.ALERTS_EMAIL_FROM, s.env.VERCEL_DEPLOYMENT_ID,
    ...Object.values(s.config.accounts), ...Object.values(s.config.rules), ID(30), ID(41), ID(42),
    'PRIVATE BILL NAME', 'PRIVATE BILL PROOF', 'Synthetic classified opening', 'Synthetic payslip', 'Synthetic route']) {
    assert.equal(text.includes(secret), false, `Unexpected private value in dashboard response: ${secret}`);
  }
}

test('private overview composes actual policies and stored state without provider calls, writes or message construction', async () => {
  const s = setup(), before = structuredClone(s.store.value), session = await s.open();
  assert.equal(session.response.status, 200); assert.equal(session.snapshot.schemaVersion, 1);
  assert.equal(session.snapshot.bills.targetCents, 350000); assert.equal(session.snapshot.annual.roth.monthlyAmountCents, 62500);
  assert.equal(session.snapshot.settings.current.settings.generalMonthlyBudgetCents, 75000);
  assert.equal(session.snapshot.settings.current.settings.generalReserveMonths, 3);
  assert.equal(session.snapshot.accounts.length, 7);
  assert.ok(session.snapshot.accounts.every(row => row.balanceCents === null));
  assert.ok(session.snapshot.csrfToken); assert.ok(session.cookie.startsWith(`${DASHBOARD_COOKIE}=`));
  assert.equal(s.calls.factories.length, 0); assert.equal(s.store.writes.length, 0);
  assert.deepEqual(s.store.value, before); noPrivateValues(s, session.snapshot); noFinancialWrites(s);
});

test('the internal rewrite preserves dashboard access and emits the same safe overview shape', async () => {
  const s = setup(), response = await s.app.fetch(s.req('/api/index?route=dashboard'));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.bills.targetCents, 350000); assert.ok(result.csrfToken);
  assert.equal(s.calls.factories.length, 0); noFinancialWrites(s);
});

test('only a valid current-build rehearsal receipt becomes an offline passing result', async () => {
  const receipt = { schemaVersion: 1, suite: 'monthly-activation-rehearsal-v1', softwareVersion: VERSION, status: 'passed',
    deterministic: true, syntheticDataOnly: true, networkAttempts: 0, realTransfers: 0, realEmails: 0,
    scenarioCount: 5, checkedAt: UPDATED, resultHash: 'a'.repeat(64), scenarios: [
      'full_year_carry_and_december_close', 'priority_shortage_and_partial_roth', 'provider_uncertain_and_failed_outcomes',
      'first_day_schedule_and_prospective_activation', 'year_transition_and_new_annual_limit'].map(id => ({ id, status: 'passed' })) };
  for (const [input, expected] of [[receipt, 'passed'], [null, 'not_run'], [{ ...receipt, softwareVersion: '0.0.0' }, 'not_run']]) {
    const s = setup({}, { rehearsalReceipt: input }), session = await s.open();
    assert.equal(session.snapshot.tests.offline.status, expected);
    assert.equal(session.snapshot.tests.provider.status, 'not_run');
    assert.equal(s.calls.factories.length, 0); assert.equal(s.store.writes.length, 0); noFinancialWrites(s);
  }
});

test('an unverified access perimeter, preview, wrong host or missing signer blocks before all private dependencies', async () => {
  for (const change of [{ DASHBOARD_ENABLED: 'false' }, { DASHBOARD_ACCESS_POLICY: undefined }, { VERCEL_ENV: 'preview' },
    { VERCEL_ENV: undefined }, { FINANCE_CANONICAL_HOST: 'old.example.test' }, { CRON_SECRET: undefined }]) {
    const s = setup(change), response = await s.app.fetch(s.req());
    assert.equal(response.status, 503); assert.equal(s.store.reads, 0);
    assert.equal(s.calls.bills + s.calls.roth + s.calls.monthly + s.calls.readiness, 0); assert.equal(s.calls.factories.length, 0);
    noFinancialWrites(s);
  }
});

test('session and CSRF never authorize the existing machine, webhook or setup-email routes', async () => {
  const s = setup(), session = await s.open(), before = s.store.reads;
  for (const path of ['/api/status', '/api/reconcile', '/api/index?route=reconcile', '/api/monthly']) {
    const response = await s.app.fetch(s.req(path, { headers: { cookie: session.cookie, 'x-csrf-token': session.snapshot.csrfToken } }));
    assert.equal(response.status, 401);
  }
  assert.equal((await s.app.fetch(s.post('/api/alerts/test', {}, session))).status, 401);
  const webhook = await s.app.fetch(s.post('/api/webhook', {}, session));
  assert.ok([400, 401, 503].includes(webhook.status));
  assert.equal(s.store.reads, before); noFinancialWrites(s);
});

test('method, query, route-proxy and cross-origin attempts cannot reach a financial dependency', async () => {
  const s = setup(), session = await s.open(), before = s.store.reads;
  for (const [path, method] of [['/api/dashboard', 'POST'], ['/api/dashboard/settings', 'GET'], ['/api/dashboard/simulate', 'GET'],
    ['/api/dashboard/settings/preview', 'GET'], ['/api/dashboard/scheduler-test', 'GET'], ['/api/dashboard/diagnostics', 'DELETE'], ['/api/dashboard/debug', 'POST']]) {
    assert.equal((await s.app.fetch(s.req(path, { method }))).status, 405);
  }
  for (const path of ['/api/dashboard?url=https://attacker.test', '/api/dashboard?route=reconcile',
    '/api/index?route=dashboard&route=reconcile', '/api/dashboard/activity?path=reconcile']) {
    assert.equal((await s.app.fetch(s.req(path, { headers: { cookie: session.cookie } }))).status, 400);
  }
  assert.equal((await s.app.fetch(s.req('/api/dashboard/reconcile'))).status, 404);
  assert.equal((await s.app.fetch(s.req('/api/dashboard', { headers: { origin: 'https://attacker.test', cookie: session.cookie } }))).status, 403);
  assert.equal(s.store.reads, before); assert.equal(s.calls.factories.length, 0); noFinancialWrites(s);
});

test('simulations use the real pure planner and keep regular and held windfall cash separate', async () => {
  const s = setup(), session = await s.open(), before = structuredClone(s.store.value);
  const response = await s.app.fetch(s.post('/api/dashboard/simulate', { input: cashInput('2030-01') }, session));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.kind, 'synthetic_estimate'); assert.equal(result.realTransfers, 0);
  assert.equal(result.plan.openingRegularCents, 500000); assert.equal(result.plan.heldWindfallCents, 400000);
  assert.equal(result.flows.find(row => row.allocationId === 'bills').plannedCents, 100000);
  assert.equal(result.flows.find(row => row.allocationId === 'general-spending').plannedCents, 100000);
  assert.equal(result.flows.find(row => row.allocationId === 'emergency-fund').plannedCents, 37500);
  assert.equal(result.assumptions.rothEligibility, 'hypothetical_only');
  assert.equal(s.calls.factories.length, 0); assert.equal(s.store.writes.length, 0);
  assert.deepEqual(s.store.value, before); noPrivateValues(s, result); noFinancialWrites(s);
});

test('a future-year simulation does not inherit an unannounced Roth cap', async () => {
  const s = setup(), session = await s.open();
  const response = await s.app.fetch(s.post('/api/dashboard/simulate', { input: cashInput('2031-01') }, session));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.flows.find(row => row.allocationId === 'roth-ira').plannedCents, 0);
  assert.equal(result.flows.find(row => row.allocationId === 'personal-investment').plannedCents, 0);
  assert.ok(result.plan.alerts.length > 0); noFinancialWrites(s);
});

test('simulation and diagnostic bodies cannot inject targets, account IDs, execution switches or arbitrary actions', async () => {
  const s = setup(), session = await s.open();
  for (const body of [{ input: { ...cashInput('2030-01'), destinationAccountId: ID(999) } },
    { input: { ...cashInput('2030-01'), regularIncomeCents: -1 } }, { input: cashInput('2030-01'), live: true }]) {
    assert.equal((await s.app.fetch(s.post('/api/dashboard/simulate', body, session))).status, 400);
  }
  assert.equal((await s.app.fetch(s.post('/api/dashboard/diagnostics', { execute: true }, session))).status, 400);
  assert.equal(s.calls.factories.length, 0); assert.equal(s.store.writes.length, 0); noFinancialWrites(s);
});

test('valid settings updates save one versioned prospective control revision and no financial operation', async () => {
  const s = setup(), session = await s.open();
  const response = await s.app.fetch(s.post('/api/dashboard/settings', { expectedRevision: 0,
    changes: { generalMonthlyBudgetCents: 85000 } }, session));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.status, 'saved'); assert.equal(result.settings.revision, 1);
  assert.equal(result.settings.current.settings.generalMonthlyBudgetCents, 75000);
  assert.equal(result.settings.pending[0].settings.generalMonthlyBudgetCents, 85000);
  assert.equal(result.settings.pending[0].effectiveMonth, '2030-02');
  assert.equal(s.store.writes.length, 1); assert.equal(s.store.value.dashboardControls.versions.length, 1);
  assert.deepEqual(s.store.value.events, {}); assert.equal(s.store.value.active, null);
  assert.equal(s.calls.factories.length, 0); noPrivateValues(s, result); noFinancialWrites(s);
  const again = await s.app.fetch(s.post('/api/dashboard/settings', { expectedRevision: 0, changes: { generalMonthlyBudgetCents: 90000 } }, session));
  assert.equal(again.status, 409); assert.equal(s.store.writes.length, 1);
  s.clock.value = Date.parse('2030-02-01T15:00:00.000Z'); s.bills.bills_monitor.checkedAt = asISO(s.clock.value);
  const status = await s.app.fetch(s.req('/api/status', { headers: { authorization: `Bearer ${SECRET}` } }));
  assert.equal(status.status, 200); const configured = await status.json();
  assert.equal(configured.allocations.find(row => row.id === 'general-spending').monthlyBudgetCents, 85000);
  assert.equal(configured.allocations.find(row => row.id === 'general-spending').targetCents, 255000);
});

test('settings preview returns the same prospective version without writing or making provider calls', async () => {
  const s = setup(), session = await s.open(), before = structuredClone(s.store.value);
  const body = { expectedRevision: 0, changes: { generalMonthlyBudgetCents: 85000, executionDay: 15 } };
  const response = await s.app.fetch(s.post('/api/dashboard/settings/preview', body, session)), preview = await response.json();
  assert.equal(response.status, 200); assert.equal(preview.preview, true); assert.equal(preview.financialLedgerModified, false);
  assert.equal(preview.settings.revision, 1); assert.equal(preview.settings.current.effectiveMonth, '2030-01');
  assert.equal(preview.settings.current.settings.executionDay, 15);
  assert.equal(preview.settings.current.settings.generalMonthlyBudgetCents, 85000);
  const rewritten = await s.app.fetch(s.post('/api/index?route=dashboard/settings/preview', body, session));
  assert.equal(rewritten.status, 200); assert.deepEqual(await rewritten.json(), preview);
  assert.equal(s.store.writes.length, 0); assert.deepEqual(s.store.value, before); assert.equal(s.calls.factories.length, 0);
  const saved = await s.app.fetch(s.post('/api/dashboard/settings', body, session));
  assert.equal(saved.status, 200); assert.deepEqual((await saved.json()).settings, preview.settings);
  assert.equal(s.store.writes.length, 1); noPrivateValues(s, preview); noFinancialWrites(s);
});

test('a reviewed effective month cannot silently drift after its execution opportunity closes', async () => {
  const s = setup(), session = await s.open();
  const body = { expectedRevision: 0, changes: { executionDay: 15 } };
  const preview = await s.app.fetch(s.post('/api/dashboard/settings/preview', body, session));
  assert.equal(preview.status, 200); assert.equal((await preview.json()).settings.current.effectiveMonth, '2030-01');
  assert.equal((await s.app.fetch(s.post('/api/dashboard/settings/preview', { ...body, expectedEffectiveMonth: '2030-01' }, session))).status, 400);
  s.clock.value = Date.parse('2030-01-15T15:00:01.000Z');
  const renewed = await s.open();
  const save = await s.app.fetch(s.post('/api/dashboard/settings', { ...body, expectedEffectiveMonth: '2030-01' }, renewed));
  assert.equal(save.status, 409); assert.deepEqual(await save.json(), { code: 'DASHBOARD_SETTINGS_PREVIEW_EXPIRED' });
  assert.equal(s.store.writes.length, 0);
  assert.equal((await s.app.fetch(s.post('/api/dashboard/settings', { ...body, expectedEffectiveMonth: '2030-13' }, renewed))).status, 400);
  const compatible = await s.app.fetch(s.post('/api/dashboard/settings', body, renewed));
  assert.equal(compatible.status, 200); assert.equal((await compatible.json()).settings.pending[0].effectiveMonth, '2030-02');
  noFinancialWrites(s);
});

test('CAS conflicts never overwrite newer ledger state or automatically retry a settings edit', async () => {
  const s = setup(), session = await s.open();
  const newer = { ...initialState(), lastRun: { at: asISO(s.clock.value), result: { status: 'observe' } } };
  s.store.beforeCAS = async () => { s.store.beforeCAS = null; s.store.replaceForTest(newer); };
  const response = await s.app.fetch(s.post('/api/dashboard/settings', { expectedRevision: 0, changes: { executionDay: 15 } }, session));
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { code: 'STORE_CONFLICT' });
  assert.deepEqual(s.store.value, newer); assert.equal(s.store.writes.length, 0); noFinancialWrites(s);
});

test('an active financial lease and forbidden settings fields block control writes', async () => {
  const s = setup(), session = await s.open();
  for (const changes of [{ liveEnabled: true }, { accountId: ID(999) }, { rothAnnualLimitCents: 9999999 },
    { executionDay: 29 }, { decemberDay: 16 }, { generalMonthlyBudgetCents: 12.5 }]) {
    assert.equal((await s.app.fetch(s.post('/api/dashboard/settings', { expectedRevision: 0, changes }, session))).status, 400);
  }
  s.store.replaceForTest({ ...initialState(), lease: { owner: ID(900), expiresAt: asISO(s.clock.value + 60000) } });
  assert.equal((await s.app.fetch(s.post('/api/dashboard/settings', { expectedRevision: 0, changes: { executionDay: 15 } }, session))).status, 409);
  assert.equal(s.store.writes.length, 0); noFinancialWrites(s);
});

test('missing, wrong, cross-origin or expired CSRF sessions reject every mutation before source/store access', async () => {
  const s = setup(), session = await s.open(), before = s.store.reads;
  for (const path of ['/api/dashboard/settings', '/api/dashboard/settings/preview', '/api/dashboard/scheduler-test', '/api/dashboard/simulate', '/api/dashboard/diagnostics']) {
    for (const headers of [{ cookie: '' }, { 'x-csrf-token': 'wrong' }, { origin: 'https://attacker.test' }]) {
      const response = await s.app.fetch(s.post(path, {}, session, { headers }));
      assert.ok([401, 403].includes(response.status));
    }
  }
  s.clock.value += DASHBOARD_SESSION_MS;
  assert.equal((await s.app.fetch(s.post('/api/dashboard/diagnostics', {}, session))).status, 401);
  assert.equal(s.store.reads, before); assert.equal(s.calls.factories.length, 0); noFinancialWrites(s);
});

test('diagnostics performs bounded read-only evidence checks and returns the full snapshot without saving it', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' }), session = await s.open();
  const before = structuredClone(s.store.value), response = await s.app.fetch(s.post('/api/dashboard/diagnostics', {}, session));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.schemaVersion, 1); assert.equal(result.diagnosticSummary.readOnly, true);
  assert.equal(result.diagnosticSummary.financialLedgerWrites, 0); assert.equal(result.diagnosticSummary.realTransfers, 0);
  assert.ok(result.accounts.find(row => row.role === 'income').balanceCents > 0);
  assert.equal(result.accounts.find(row => row.role === 'income').balanceCents, 900000);
  assert.equal(result.income.availableRegularCents, 500000); assert.equal(result.income.windfallHeldCents, 400000);
  assert.ok(result.readiness.checks.length > 0); assert.equal(result.readiness.readyForActivation, false);
  assert.ok(result.diagnosticSummary.checks.every(row => row.checkedAt));
  assert.deepEqual(s.calls.factories, [{ readOnly: true }]); assert.equal(s.store.writes.length, 0);
  assert.deepEqual(s.store.value, before); noPrivateValues(s, result); noFinancialWrites(s);
});

test('unavailable policy/provider sections remain explicit, sanitized and do not suppress unrelated cards', async () => {
  const s = setup(); s.failures.bills = new Error('PRIVATE SOURCE ERROR synthetic-private-config-source');
  const session = await s.open();
  assert.equal(session.response.status, 200); assert.equal(session.snapshot.sections.bills.status, 'unavailable');
  assert.equal(session.snapshot.annual.roth.monthlyAmountCents, 62500);
  const sourceOnly = await s.app.fetch(s.post('/api/dashboard/diagnostics', {}, session)), sourceResult = await sourceOnly.json();
  assert.equal(sourceOnly.status, 200); assert.equal(sourceResult.diagnosticSummary.status, 'partial');
  assert.equal(sourceResult.diagnosticSummary.checks.find(row => row.id === 'bills_source').status, 'blocked');
  assert.equal(sourceResult.diagnosticSummary.checks.find(row => row.id === 'account_evidence').status, 'passed');
  assert.ok(sourceResult.sessionExpiresAt);
  s.client.getAccount = async () => { throw new Error('PRIVATE PROVIDER BODY synthetic-private-sequence-key'); };
  const response = await s.app.fetch(s.post('/api/dashboard/diagnostics', {}, session));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.diagnosticSummary.status, 'partial'); assert.equal(result.sections.accounts.status, 'unavailable');
  assert.ok(result.accounts.every(row => row.balanceCents === null));
  assert.equal(JSON.stringify(result).includes('PRIVATE PROVIDER BODY'), false);
  assert.equal(JSON.stringify(session.snapshot).includes('PRIVATE SOURCE ERROR'), false);
  assert.equal(s.store.writes.length, 0); noPrivateValues(s, result); noFinancialWrites(s);
});

test('activity and redacted debug are session-protected reads and exports omit session proof', async () => {
  const s = setup(), session = await s.open();
  for (const path of ['/api/dashboard/activity', '/api/dashboard/debug']) {
    assert.equal((await s.app.fetch(s.req(path))).status, 401);
    const response = await s.app.fetch(s.req(path, { headers: { cookie: session.cookie } }));
    assert.equal(response.status, 200); const value = await response.json(); noPrivateValues(s, value);
    assert.equal(JSON.stringify(value).includes(session.snapshot.csrfToken), false);
    if (path.endsWith('debug')) { assert.equal(value.redaction.sessionDataOmitted, true); assert.equal(value.kind, 'redacted_finance_diagnostics'); }
    else { assert.equal(value.completeRunLog, false); assert.deepEqual(value.items, []); }
  }
  assert.equal((await s.app.fetch(s.req('/api/dashboard/activity?limit=101', { headers: { cookie: session.cookie } }))).status, 400);
  assert.equal((await s.app.fetch(s.req('/api/dashboard/activity?cursor=bad', { headers: { cookie: session.cookie } }))).status, 400);
  assert.equal(s.store.writes.length, 0); assert.equal(s.calls.factories.length, 0); noFinancialWrites(s);
});

test('overview and debug expose finalized coordinator checks separately from transfer milestones', async () => {
  const s = setup();
  await s.run(); s.clock.advance(1000);
  await s.run({ dependencies: { readMonthlyEvidence: async () => { throw new Error('PRIVATE RUN ERROR'); } } });
  const saved = structuredClone(s.store.value), writes = s.store.writes.length, session = await s.open();
  assert.equal(session.response.status, 200); assert.equal(session.snapshot.runs.status, 'available');
  assert.equal(session.snapshot.runs.coverage, 'bounded_coordinator_runs');
  assert.equal(session.snapshot.runs.storedCount, 2);
  assert.deepEqual(session.snapshot.runs.items.map(row => row.code), ['INTERNAL_ERROR', 'READ_ONLY_MONTHLY_PLAN']);
  assert.ok(session.snapshot.runs.items.every(row => row.submittedCount === 0 && row.settledCount === 0));
  assert.deepEqual(session.snapshot.activity.items, []);
  const response = await s.app.fetch(s.req('/api/dashboard/debug', { headers: { cookie: session.cookie } })), debug = await response.json();
  assert.equal(response.status, 200); assert.equal(debug.runs.items.length, 2);
  assert.equal(JSON.stringify(debug).includes('PRIVATE RUN ERROR'), false);
  assert.deepEqual(s.store.value, saved); assert.equal(s.store.writes.length, writes);
  assert.equal(s.calls.factories.length, 0); noPrivateValues(s, debug); noFinancialWrites(s);
});

test('owner scheduler probe durably queues once and completes only through the canonical health-only consumer', async () => {
  const s = setup(), session = await s.open(), response = await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session));
  assert.equal(response.status, 202); const queued = await response.json();
  assert.equal(queued.status, 'queued'); assert.equal(queued.scheduler.status, 'queued'); assert.equal(queued.scheduler.completedAt, null);
  assert.equal(s.calls.probes.length, 1); assert.equal(s.calls.factories.length, 0);
  assert.equal(s.calls.bills, 1); assert.equal(s.calls.roth, 1); // only the initial overview read policy sources
  assert.equal((await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session))).status, 429);
  const probe = s.calls.probes[0]; s.clock.advance(61000);
  const urls = [];
  const delivered = await consumeSchedulerMessage(probe, { topicName: SCHEDULER_TOPIC, deliveryCount: 1 }, {
    env: s.env, now: () => s.clock.value, getOidcToken: async () => 'synthetic-private-oidc-proof',
    fetchImpl: async (url, options) => {
      urls.push(url); assert.equal(url, `${ORIGIN}/api/health`); assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      return Response.json({ status: 'ready', version: VERSION, mode: 'observe', liveEnabled: false });
    }, completeProbeImpl: args => completeSchedulerProbe({ ...args, store: s.store }),
  });
  assert.equal(delivered.financialExecutionRequested, false); assert.deepEqual(urls, [`${ORIGIN}/api/health`]);
  const refreshed = await s.open();
  assert.equal(refreshed.snapshot.tests.scheduler.status, 'completed');
  assert.equal(refreshed.snapshot.tests.scheduler.softwareVersion, VERSION);
  assert.equal(refreshed.snapshot.tests.scheduler.target, 'health_only');
  assert.equal(JSON.stringify(refreshed.snapshot).includes(probe.id), false);
  assert.equal(JSON.stringify(refreshed.snapshot).includes('synthetic-private-oidc-proof'), false);
  noPrivateValues(s, refreshed.snapshot); noFinancialWrites(s);
  assert.deepEqual(s.store.value.events, {}); assert.equal(s.store.value.active, null);
});

test('scheduler test rejects live modes, arbitrary instructions, missing identity, active workers and CAS races before enqueue', async () => {
  for (const changes of [{ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' }, { APP_MODE: 'live' }, { LIVE_TRANSFERS_ENABLED: 'true' },
    { VERCEL_DEPLOYMENT_ID: undefined }]) {
    const s = setup(changes), session = await s.open(), reads = s.store.reads;
    const response = await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session));
    assert.ok([409, 503].includes(response.status)); assert.equal(s.store.reads, reads); assert.equal(s.calls.probes.length, 0);
  }
  const s = setup(), session = await s.open();
  for (const body of [{ route: '/api/reconcile' }, { amountInCents: 1 }, { id: ID(999) }]) {
    assert.equal((await s.app.fetch(s.post('/api/dashboard/scheduler-test', body, session))).status, 400);
  }
  s.store.replaceForTest({ ...initialState(), lease: { owner: ID(50), expiresAt: asISO(s.clock.value + 10000) } });
  assert.equal((await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session))).status, 409);
  assert.equal(s.calls.probes.length, 0); assert.equal(s.store.writes.length, 0);
  s.store.replaceForTest(initialState());
  const newer = { ...initialState(), lastRun: { at: asISO(s.clock.value), mode: 'observe', result: { status: 'observe', code: 'NEWER_RUN' } } };
  s.store.beforeCAS = async () => { s.store.beforeCAS = null; s.store.replaceForTest(newer); };
  assert.equal((await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session))).status, 409);
  assert.deepEqual(s.store.value, newer); assert.equal(s.calls.probes.length, 0); noFinancialWrites(s);
});

test('a lost queue response keeps its private intent and cooldown without claiming delivery or leaking the error', async () => {
  const s = setup(), session = await s.open(); s.failures.scheduler = new Error('PRIVATE QUEUE RESPONSE synthetic-private-oidc-proof');
  const response = await s.app.fetch(s.post('/api/index?route=dashboard/scheduler-test', {}, session)), result = await response.json();
  assert.equal(response.status, 503); assert.equal(result.scheduler.status, 'unknown');
  assert.equal(result.scheduler.completedAt, null); assert.equal(s.calls.probes.length, 1);
  assert.equal((await s.app.fetch(s.post('/api/dashboard/scheduler-test', {}, session))).status, 429);
  assert.equal(s.calls.probes.length, 1); assert.equal(JSON.stringify(result).includes('PRIVATE QUEUE'), false);
  const next = await s.open(); assert.equal(next.snapshot.tests.scheduler.status, 'unknown');
  noPrivateValues(s, result); noFinancialWrites(s);
});
