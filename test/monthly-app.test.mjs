import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.mjs';
import { loadConfig, withCalculatedBillsTarget } from '../lib/config.mjs';
import { forecastBills } from '../lib/bills.mjs';
import { FakeStore, FakeSequence, cashAccount, makeRothPolicy, ID, asISO } from './fixtures.mjs';

// Every value and account in this file is synthetic. Both financial and email
// dependencies are injected; these route tests never access an external service.
const NOW = Date.parse('2030-01-01T15:05:00.000Z');
const OPENING = '2029-12-31T23:00:00.000Z';
const UPDATED = '2030-01-01T14:00:00.000Z';
const CRON = 'synthetic-monthly-route-secret';
const ACCOUNTS = { income: ID(1), pod: ID(2), general: ID(3), bills: ID(4) };
const RULES = { payout: ID(11), funding: ID(12), legacyGeneral: ID(13) };
function env(overrides = {}) {
  return { APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', AUTOMATION_START_AT: '2030-01-01T15:00:00.000Z',
    FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(ACCOUNTS), FINANCE_RULE_IDS_JSON: JSON.stringify(RULES), FINANCE_ALLOCATIONS_JSON: '[]',
    GENERAL_SPENDING_MONTHLY_BUDGET: '750', GENERAL_SPENDING_RESERVE_MONTHS: '3', INCOME_RESERVE: '0', MAX_BALANCE_AGE_HOURS: '26',
    MONTHLY_PRIORITY_ENABLED: 'true', ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: ID(30),
    EMERGENCY_ACCOUNT_ID: ID(5), PROJECT_ACCOUNT_ID: ID(6), PERSONAL_INVESTMENT_ACCOUNT_ID: ID(7), EMERGENCY_EXCESS_RULE_ID: ID(14),
    SEQUENCE_API_KEY: 'synthetic-private-sequence-key', BLOB_READ_WRITE_TOKEN: 'synthetic-private-store-key',
    GLOBAL_CONFIG: 'synthetic-private-policy-connection', CRON_SECRET: CRON,
    RESEND_API_KEY: 'synthetic-private-email-key', ALERTS_EMAIL_TO: 'private-recipient@example.test',
    ALERTS_EMAIL_FROM: 'Finance <private-sender@example.test>', ...overrides };
}
function billsSource() {
  return { bills_catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: UPDATED, bills: [{
    id: 'synthetic-bill', name: 'Private synthetic bill name', kind: 'expense', status: 'active', amountCents: 340000,
    frequency: 'monthly', evidence: { type: 'user_confirmation', reference: 'Private bill evidence', observedAt: UPDATED },
  }] }, bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: asISO(NOW), catalogUpdatedAt: UPDATED, reviewCodes: [] } };
}
function monthlySource() {
  return { monthly_policy: { schemaVersion: 1, id: 'monthly-priority', updatedAt: UPDATED,
    opening: { status: 'verified', asOf: OPENING, incomeBalanceCents: 0, regularCents: 0, windfallCents: 0, unknownCents: 0,
      reference: 'Private reviewed empty opening evidence' },
    classification: { rules: [
      { id: 'synthetic-pay', kind: 'navy-pay', descriptionEquals: 'PRIVATE SYNTHETIC ORDINARY PAY', merchantEquals: 'Synthetic Payroll',
        minAmountCents: 1, maxAmountCents: 500000, excludesBonuses: true, verifiedAt: OPENING, reference: 'Private ordinary-pay proof' },
      { id: 'synthetic-windfall', kind: 'windfall', descriptionEquals: 'PRIVATE SYNTHETIC REFUND', merchantEquals: 'Synthetic Agency',
        minAmountCents: 1, maxAmountCents: 400000, verifiedAt: OPENING, reference: 'Private refund proof' },
    ], overrides: [] } } };
}
function activationSource(environment) {
  return { activation_policy: { schemaVersion: 1, updatedAt: UPDATED,
    sequenceAuthority: { status: 'verified', verifiedAt: UPDATED, reference: 'Private synthetic unattended-authority proof',
      automaticApproval: true, maxAmountCents: null,
      accountPairs: [ID(4), ID(3), ID(5), ID(30), ID(6), ID(7)]
        .map(destinationAccountId => ({ sourceAccountId: ID(1), destinationAccountId }))
        .concat({ sourceAccountId: ID(5), destinationAccountId: ID(1) }) },
    emailDelivery: { status: 'verified', verifiedAt: UPDATED, reference: 'Private synthetic provider receipt and inbox proof',
      provider: 'resend', recipient: environment.ALERTS_EMAIL_TO, sender: environment.ALERTS_EMAIL_FROM,
      providerAccepted: true, recipientConfirmed: true } } };
}
function setup(overrides = {}, { regularCents = 500000, windfallCents = 400000 } = {}) {
  const environment = env(overrides), bills = billsSource(), monthly = monthlySource(), readiness = {};
  const config = withCalculatedBillsTarget(loadConfig(environment), forecastBills(bills.bills_catalog, { now: NOW }));
  const clock = { value: NOW, advance(milliseconds) { this.value += milliseconds; } }, store = new FakeStore();
  const client = new FakeSequence(config, clock);
  client.transfers.clear(); client.executions.clear();
  for (const rule of client.rules.values()) rule.status = 'DISABLED';
  const balanceAt = '2030-01-01T15:00:00.000Z';
  for (const [role, id, balance] of [['income', ID(1), regularCents + windfallCents], ['bills', ID(4), 250000],
    ['general', ID(3), 125000], ['emergency', ID(5), 900000], ['project', ID(6), 0]]) {
    client.accounts.set(id, cashAccount(id, balance, balanceAt));
  }
  client.accounts.set(ID(30), { id: ID(30), type: 'EXTERNAL_ACCOUNT', externalAccountType: 'INVESTMENT', institutionName: 'Fidelity',
    deletedAt: null, canBeSource: false, canBeDestination: true, balance: null });
  client.accounts.set(ID(7), { id: ID(7), type: 'EXTERNAL_ACCOUNT', externalAccountType: 'INVESTMENT', institutionName: 'Synthetic Broker',
    deletedAt: null, canBeSource: false, canBeDestination: true, balance: null });
  const bankRows = [
    { id: ID(501), accountId: ID(1), amountInCents: regularCents, direction: 'MONEY_IN', status: 'COMPLETE',
      transactionDate: '2030-01-01T12:00:00.000Z', description: 'PRIVATE SYNTHETIC ORDINARY PAY', merchantName: 'Synthetic Payroll', category: null },
    { id: ID(502), accountId: ID(1), amountInCents: windfallCents, direction: 'MONEY_IN', status: 'COMPLETE',
      transactionDate: '2030-01-01T11:00:00.000Z', description: 'PRIVATE SYNTHETIC REFUND', merchantName: 'Synthetic Agency', category: null },
  ].filter(row => row.amountInCents > 0);
  client.listExternalTransactions = async options => {
    client.calls.push({ method: 'listExternalTransactions', options: structuredClone(options) });
    return { items: structuredClone(bankRows.filter(row => Date.parse(row.transactionDate) >= Date.parse(options.from) &&
      Date.parse(row.transactionDate) <= Date.parse(options.to))), complete: true,
      window: { from: options.from, to: options.to, truncated: false } };
  };
  const roth = { roth_policy: { schemaVersion: 1, policy: makeRothPolicy(2030), evidence: { schemaVersion: 1, updatedAt: UPDATED,
    route: { status: 'verified', sourceAccountId: ID(1), destinationAccountId: ID(30), custodian: 'fidelity',
      contributionYear: 'current_calendar_year', verifiedAt: OPENING, reference: 'Private custodian route proof' },
    upstream: { status: 'unverified' } } } };
  const reads = { bills: [], roth: [], monthly: [], readiness: [] }, factories = [], emails = [], messages = [], factoryClients = [];
  const appOptions = { env: environment, now: () => clock.value, storeFactory: () => store,
    clientFactory: (resolved, readOnly) => { factoryClients.push({ config: resolved, readOnly }); return client; },
    billsReader: async (...args) => { reads.bills.push(args); if (bills.failure) throw bills.failure; return structuredClone(bills); },
    rothReader: async (...args) => { reads.roth.push(args); if (roth.failure) throw roth.failure; return structuredClone(roth); },
    monthlyReader: async (...args) => { reads.monthly.push(args); if (monthly.failure) throw monthly.failure; return structuredClone(monthly); },
    readinessReader: async (...args) => { reads.readiness.push(args); if (readiness.failure) throw readiness.failure; return structuredClone(readiness); },
    alertSenderFactory: options => { factories.push(options); return async alert => {
      emails.push(structuredClone(alert)); return { status: 'accepted', deliveryId: ID(8000 + emails.length) };
    }; }, log: { error: value => messages.push(value) } };
  const app = createApp(appOptions);
  const request = (path, options = {}) => new Request(`https://finance.example.test${path}`, {
    ...options, headers: { authorization: `Bearer ${CRON}`, ...options.headers },
  });
  return { app, appOptions, env: environment, config, clock, store, client, bills, monthly, roth, readiness, bankRows, reads, factories, emails, messages, factoryClients, request };
}

test('monthly health is public but exposes no identifiers, recipients, evidence or source credentials', async () => {
  const s = setup(), response = await s.app.fetch(new Request('https://finance.example.test/api/health'));
  const body = await response.json(), output = JSON.stringify(body);
  assert.equal(response.status, 200); assert.equal(body.monthlyPriorityConfigured, true); assert.equal(body.emailDeliveryConfigured, true);
  for (const privateValue of [s.env.RESEND_API_KEY, s.env.ALERTS_EMAIL_TO, s.env.ALERTS_EMAIL_FROM, s.env.GLOBAL_CONFIG,
    s.env.SEQUENCE_API_KEY, CRON, ...Object.values(s.config.accounts), ID(6), ID(7), ID(30), 'Private ordinary-pay proof']) {
    assert.equal(output.includes(privateValue), false);
  }
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.reads, 0); assert.equal(s.factories.length, 0);
  assert.deepEqual(s.reads, { bills: [], roth: [], monthly: [], readiness: [] });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('monthly, alerts and readiness routes preserve bearer authentication including Vercel rewrites', async () => {
  const s = setup();
  for (const path of ['/api/monthly', '/api/alerts', '/api/readiness', '/api/index?route=monthly', '/api/index?route=alerts', '/api/index?route=readiness']) {
    for (const headers of [{}, { authorization: `Bearer ${CRON}wrong` }]) {
      assert.equal((await s.app.fetch(new Request(`https://finance.example.test${path}`, { headers }))).status, 401);
    }
  }
  assert.equal(s.store.reads, 0); assert.equal(s.client.calls.length, 0); assert.equal(s.factories.length, 0);
  assert.equal(s.reads.monthly.length, 0); assert.equal(s.reads.readiness.length, 0);
});

test('monthly, alerts and readiness are GET-only and reject mutations before reading private data', async () => {
  const s = setup();
  for (const path of ['/api/monthly', '/api/alerts', '/api/readiness', '/api/index?route=alerts', '/api/index?route=readiness']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await s.app.fetch(s.request(path, { method }))).status, 405);
  }
  assert.equal(s.store.reads, 0); assert.equal(s.client.calls.length, 0); assert.equal(s.reads.monthly.length, 0);
  assert.equal(s.reads.readiness.length, 0);
});

test('disabled monthly routes return 404 without readers, ledger activity or alert construction', async () => {
  const s = setup({ MONTHLY_PRIORITY_ENABLED: 'false' });
  for (const path of ['/api/monthly', '/api/alerts', '/api/readiness', '/api/index?route=monthly', '/api/index?route=alerts', '/api/index?route=readiness']) {
    const response = await s.app.fetch(s.request(path));
    assert.equal(response.status, 404); assert.equal((await response.json()).code, 'NOT_FOUND');
  }
  assert.equal(s.store.reads, 0); assert.equal(s.store.writes.length, 0); assert.equal(s.client.calls.length, 0);
  assert.equal(s.factories.length, 0); assert.equal(s.reads.monthly.length, 0); assert.equal(s.reads.readiness.length, 0);
});

test('live-configured status, monthly, Roth and alerts endpoints remain read-only', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  for (const path of ['/api/status', '/api/monthly', '/api/roth', '/api/alerts']) {
    const response = await s.app.fetch(s.request(path)), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const output = JSON.stringify(body);
    for (const secret of [s.env.ALERTS_EMAIL_TO, s.env.ALERTS_EMAIL_FROM, s.env.RESEND_API_KEY,
      'PRIVATE SYNTHETIC ORDINARY PAY', 'Private ordinary-pay proof', ID(1), ID(30)]) assert.equal(output.includes(secret), false);
  }
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
  assert.equal(s.client.calls.length, 0);
  assert.ok(s.factories.every(options => options.readOnly));
  assert.ok(s.factoryClients.every(options => options.readOnly));
  assert.ok(s.reads.monthly.every(args => JSON.stringify(args[0]) === '["monthly_policy"]'));
});

test('monthly preflight checks all seven real roles and all disabled legacy rules without reading the routing Pod', async () => {
  const s = setup();
  s.monthly.monthly_policy.opening = { status: 'unverified' };
  const response = await s.app.fetch(s.request('/api/preflight')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.transferPermission, 'not_exercised'); assert.equal(body.monthly.accountRolesVerified, true);
  assert.equal(body.monthly.openingVerified, false); assert.ok(body.monthly.blockers.includes('INCOME_OPENING_UNVERIFIED'));
  assert.equal(body.activationRequired, true);
  const readAccounts = new Set(s.client.calls.filter(row => row.method === 'getAccount').map(row => row.id));
  assert.deepEqual(readAccounts, new Set([ID(1), ID(3), ID(4), ID(5), ID(6), ID(7), ID(30)]));
  assert.equal(readAccounts.has(ID(2)), false);
  assert.deepEqual(new Set(s.client.calls.filter(row => row.method === 'getRule').map(row => row.id)), new Set([...Object.values(RULES), ID(14)]));
  assert.equal(s.client.calls.some(row => ['getRuleExecution', 'listRuleExecutions'].includes(row.method)), false);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
});

test('readiness and its rewrite perform only reads and never expose private evidence, identities or credentials', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  Object.assign(s.readiness, activationSource(s.env));
  const beforeEnvironment = structuredClone(s.env), beforeLedger = structuredClone(s.store.value);
  for (const path of ['/api/readiness', '/api/index?route=readiness', '/api/preflight']) {
    const response = await s.app.fetch(s.request(path)), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const readiness = path === '/api/preflight' ? body.readiness : body;
    assert.equal(readiness.readChecks, 'passed'); assert.equal(readiness.readyForActivation, true);
    assert.equal(readiness.limitations.realTransferTested, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const output = JSON.stringify(body);
    for (const secret of [CRON, s.env.SEQUENCE_API_KEY, s.env.BLOB_READ_WRITE_TOKEN, s.env.GLOBAL_CONFIG, s.env.RESEND_API_KEY,
      s.env.ALERTS_EMAIL_TO, s.env.ALERTS_EMAIL_FROM, 'private-sender@example.test', ...Object.values(s.config.accounts),
      ...Object.values(s.config.rules), ID(6), ID(7), ID(30), 'Private synthetic unattended-authority proof',
      'Private synthetic provider receipt and inbox proof', 'Private custodian route proof', 'Private ordinary-pay proof',
      'PRIVATE SYNTHETIC ORDINARY PAY', 'Private reviewed empty opening evidence', 'Synthetic reviewed test evidence']) {
      assert.equal(output.includes(secret), false, `Private test data leaked: ${secret}`);
    }
  }
  assert.deepEqual(s.env, beforeEnvironment); assert.deepEqual(s.store.value, beforeLedger);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
  assert.ok(s.factories.every(options => options.readOnly)); assert.ok(s.factoryClients.every(options => options.readOnly));
  assert.deepEqual(s.reads.readiness, Array.from({ length: 3 }, () => [['activation_policy'], { consistentRead: true }]));
  assert.ok(s.reads.monthly.every(args => JSON.stringify(args[0]) === '["monthly_policy"]'));
});

test('missing activation evidence blocks readiness while account reads and the verified existing Roth route pass', async () => {
  const s = setup(), response = await s.app.fetch(s.request('/api/preflight')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.status, 'read_checks_passed');
  assert.equal(body.readiness.readChecks, 'passed'); assert.equal(body.readiness.readyForActivation, false);
  assert.equal(body.readiness.status, 'blocked'); assert.equal(body.activationRequired, true);
  assert.ok(body.readiness.blockers.includes('ACTIVATION_POLICY_INVALID'));
  assert.ok(body.readiness.blockers.includes('SEQUENCE_AUTHORITY_UNVERIFIED'));
  assert.ok(body.readiness.blockers.includes('EMAIL_DELIVERY_UNVERIFIED'));
  assert.equal(body.roth.destinationVerified, true);
  assert.equal(body.roth.blockers.includes('ROTH_ROUTE_UNVERIFIED'), false);
  for (const id of ['account_and_cash_reads', 'legacy_rules_disabled', 'income_reconciliation', 'next_cycle_roth_policy', 'roth_route_and_contributions']) {
    assert.equal(body.readiness.checks.find(check => check.id === id)?.status, 'passed', id);
  }
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
});

test('a fully reviewed synthetic setup can be ready while both execution switches remain inactive', async () => {
  const s = setup(); Object.assign(s.readiness, activationSource(s.env));
  const response = await s.app.fetch(s.request('/api/readiness?mode=live&live=true&recipient=attacker@example.test&amountInCents=1'));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.status, 'ready_for_user_activation');
  assert.equal(body.readyForActivation, true); assert.equal(body.executionEnabled, false); assert.equal(body.activationEstablished, false);
  assert.deepEqual(body.blockers, []); assert.ok(body.checks.every(check => check.status === 'passed'));
  assert.deepEqual(body.nextCycle, { year: 2030, monthKey: '2030-02', dueAt: '2030-02-01T15:00:00.000Z', timeZone: 'America/New_York' });
  assert.deepEqual(body.activationChanges.map(change => change.setting), ['APP_MODE', 'LIVE_TRANSFERS_ENABLED', 'AUTOMATION_START_AT']);
  assert.equal(body.recheckAtActivation, true);
  assert.equal(s.env.APP_MODE, 'observe'); assert.equal(s.env.LIVE_TRANSFERS_ENABLED, 'false');
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
  assert.equal(JSON.stringify(body).includes('attacker@example.test'), false);
});

test('a delivered-email proof for another recipient cannot make the current configuration ready', async () => {
  const s = setup(); Object.assign(s.readiness, activationSource(s.env));
  s.readiness.activation_policy.emailDelivery.recipient = 'previous-private-recipient@example.test';
  const response = await s.app.fetch(s.request('/api/readiness')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.readChecks, 'passed');
  assert.equal(body.readyForActivation, false); assert.deepEqual(body.blockers, ['EMAIL_DELIVERY_RECIPIENT_MISMATCH']);
  assert.equal(body.checks.find(check => check.id === 'activation_evidence').status, 'passed');
  assert.equal(body.checks.find(check => check.id === 'email_delivery').status, 'blocked');
  assert.equal(JSON.stringify(body).includes('previous-private-recipient@example.test'), false);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
});

test('a delivered-email proof for another sender cannot make the current configuration ready', async () => {
  const s = setup(); Object.assign(s.readiness, activationSource(s.env));
  s.readiness.activation_policy.emailDelivery.sender = 'Finance <previous-private-sender@example.test>';
  const response = await s.app.fetch(s.request('/api/readiness')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.readChecks, 'passed');
  assert.equal(body.readyForActivation, false); assert.deepEqual(body.blockers, ['EMAIL_DELIVERY_SENDER_MISMATCH']);
  assert.equal(body.checks.find(check => check.id === 'activation_evidence').status, 'passed');
  assert.equal(body.checks.find(check => check.id === 'email_delivery').status, 'blocked');
  assert.equal(JSON.stringify(body).includes('previous-private-sender@example.test'), false);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
});

test('activation evidence read failures leave safe blockers without leaking diagnostics or suppressing account reads', async () => {
  const s = setup(); s.readiness.failure = new Error('Private activation-provider credential and response');
  const response = await s.app.fetch(s.request('/api/readiness')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.readChecks, 'passed');
  assert.equal(body.readyForActivation, false); assert.ok(body.blockers.includes('ACTIVATION_POLICY_UNAVAILABLE'));
  assert.equal(JSON.stringify([body, s.messages]).includes('Private activation-provider'), false);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
});

test('live preview computes the real monthly plan offline without POST, email or durable mutations', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  const response = await s.app.fetch(s.request('/api/plan')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.code, 'READ_ONLY_MONTHLY_PLAN');
  assert.equal(body.plan.openingRegularCents, 500000); assert.equal(body.plan.heldWindfallCents, 400000);
  assert.deepEqual(body.plan.allocations.map(row => row.amountInCents), [100000, 100000, 37500, 62500, 25000, 175000]);
  assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
  assert.ok(s.factories.every(options => options.readOnly));
  assert.equal(s.client.calls.some(row => row.method === 'getAccount' && row.id === ID(2)), false);
});

test('live first-day route executes exactly the offline plan once while preserving the held windfall', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  const preview = await (await s.app.fetch(s.request('/api/plan'))).json();
  let response = await s.app.fetch(s.request('/api/reconcile?amount=999999&live=false&destination=attacker')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.equal(body.submitted, 6);
  assert.deepEqual(s.client.creates.map(item => item.request.amountInCents), preview.plan.allocations.map(row => row.amountInCents));
  assert.deepEqual(s.client.creates.map(item => item.request.destinationAccountId), [ID(4), ID(3), ID(5), ID(30), ID(6), ID(7)]);
  assert.ok(s.client.creates.every(item => item.request.sourceAccountId === ID(1)));
  assert.equal(new Set(s.client.creates.map(item => item.idempotencyKey)).size, 6);
  assert.equal(s.store.value.monthly.cycles['2030-01'].plan.heldWindfallCents, 400000);
  response = await s.app.fetch(s.request('/api/reconcile')); body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(s.client.creates.length, 6);
  assert.equal(s.emails.length, 0);
  assert.equal(s.client.calls.some(row => row.method === 'getAccount' && row.id === ID(2)), false);
});

test('real REST adapter completes the six-leg route within the configured monthly request budget', { concurrency: false }, async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  const originalFetch = globalThis.fetch, http = [];
  // No fallback to the network: every possible request must match this local
  // synthetic service. The application constructs its normal SequenceClient.
  globalThis.fetch = async (urlText, options) => {
    const url = new URL(urlText), method = options.method;
    assert.equal(url.origin, 'https://api.getsequence.io');
    assert.equal(options.headers.Authorization, `Bearer ${s.env.SEQUENCE_API_KEY}`);
    http.push({ method, path: url.pathname });
    const page = items => ({ items, pagination: { page: 1, pageSize: 100, hasNextPage: false } });
    let data;
    const account = /^\/platform\/v1\/accounts\/([^/]+)$/.exec(url.pathname);
    const rule = /^\/platform\/v1\/rules\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && account) data = await s.client.getAccount(account[1]);
    else if (method === 'GET' && rule) data = await s.client.getRule(rule[1]);
    else if (method === 'GET' && url.pathname === '/platform/v1/transfers') {
      const result = await s.client.listTransfers({ accountIds: url.searchParams.getAll('accountIds[]'), executionMode: 'LIVE' });
      data = page(result.items);
    } else if (method === 'GET' && url.pathname === '/platform/v1/external-transactions') {
      const result = await s.client.listExternalTransactions({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
      data = { ...page(result.items), window: result.window };
    } else if (method === 'POST' && url.pathname === '/platform/v1/transfers') {
      data = await s.client.createTransfer({ idempotencyKey: options.headers['idempotency-key'],
        firstAttemptAt: asISO(s.clock.value), request: JSON.parse(options.body) });
    } else assert.fail(`Unexpected synthetic HTTP request: ${method} ${url.pathname}`);
    return Response.json({ data }, { status: method === 'POST' ? 201 : 200 });
  };
  try {
    const app = createApp({ ...s.appOptions, clientFactory: undefined });
    const response = await app.fetch(s.request('/api/reconcile')), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'MONTHLY_TRANSFERS_SUBMITTED'); assert.equal(body.submitted, 6);
    assert.deepEqual(s.client.creates.map(item => item.request.amountInCents), [100000, 100000, 37500, 62500, 25000, 175000]);
    assert.equal(http.filter(row => row.method === 'POST').length, 6);
    assert.ok(http.length > 90, `Expected to exercise the previous 90-request ceiling, observed ${http.length}`);
    assert.ok(http.length <= 250);
    assert.equal(s.emails.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('observe reconcile ignores query activation attempts and sends neither transfers nor email', async () => {
  const s = setup();
  const response = await s.app.fetch(s.request('/api/reconcile?mode=live&live=true&amount=900000&email=attacker@example.test'));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.code, 'READ_ONLY_MONTHLY_PLAN');
  assert.equal(s.client.creates.length, 0); assert.equal(s.emails.length, 0);
  assert.deepEqual(s.store.value.monthly.cycles, {});
});

test('shortfall email injection is invoked only by live reconcile and alert reads do not redeliver', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' }, { regularCents: 150000 });
  const planResponse = await s.app.fetch(s.request('/api/plan'));
  assert.equal(planResponse.status, 200); assert.equal(s.emails.length, 0);
  const response = await s.app.fetch(s.request('/api/reconcile')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(s.client.creates.map(item => item.request.amountInCents), [100000, 50000]);
  assert.ok(s.emails.some(alert => alert.code === 'GENERAL_CASH_SHORTFALL'));
  const count = s.emails.length;
  const alertResponse = await s.app.fetch(s.request('/api/alerts')), alerts = await alertResponse.json();
  assert.equal(alertResponse.status, 200); assert.equal(s.emails.length, count);
  assert.ok(alerts.alerts.some(alert => alert.code === 'GENERAL_CASH_SHORTFALL' && alert.status === 'DELIVERED'));
  assert.equal(JSON.stringify(alerts).includes(s.env.ALERTS_EMAIL_TO), false);
});

test('monthly source failures preserve a typed blocker without leaking source diagnostics or making a financial POST', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  s.monthly.failure = new Error('private-policy-secret-do-not-return');
  let response = await s.app.fetch(s.request('/api/monthly')), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.sourceValid, false); assert.equal(body.policyError, 'MONTHLY_POLICY_UNAVAILABLE');
  response = await s.app.fetch(s.request('/api/reconcile')); body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'MONTHLY_POLICY_UNAVAILABLE');
  assert.equal(s.client.creates.length, 0);
  assert.equal(JSON.stringify([body, s.messages, s.emails]).includes('private-policy-secret'), false);
});

test('preview deployment gate protects monthly routes before readers, provider calls or email construction', async () => {
  const s = setup({ VERCEL_ENV: 'preview', APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  for (const path of ['/api/monthly', '/api/alerts', '/api/readiness', '/api/index?route=readiness', '/api/plan', '/api/reconcile']) {
    const response = await s.app.fetch(s.request(path));
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED');
  }
  assert.equal(s.store.reads, 0); assert.equal(s.client.calls.length, 0); assert.equal(s.factories.length, 0);
  assert.equal(s.reads.monthly.length, 0); assert.equal(s.reads.readiness.length, 0);
});

test('canonical host and no-body gates prevent stale or caller-defined live reconciliations', async () => {
  const s = setup({ VERCEL_ENV: 'production', FINANCE_CANONICAL_HOST: 'canonical.example.test', APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  const old = await s.app.fetch(s.request('/api/reconcile'));
  assert.equal(old.status, 503); assert.equal((await old.json()).code, 'CANONICAL_PRODUCTION_HOST_REQUIRED');
  const injected = await s.app.fetch(new Request('https://canonical.example.test/api/reconcile', { method: 'POST',
    headers: { authorization: `Bearer ${CRON}`, 'content-type': 'application/json' }, body: '{"recipient":"attacker","amountInCents":1}' }));
  assert.equal(injected.status, 400); assert.equal((await injected.json()).code, 'RECONCILE_DOES_NOT_ACCEPT_A_BODY');
  assert.equal(s.store.reads, 0); assert.equal(s.client.calls.length, 0); assert.equal(s.factories.length, 0);
});

test('a second-day invocation cannot create the missed monthly transfers', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' });
  s.clock.advance(24 * 3600000);
  // Refresh only read evidence; the missed first-day opportunity remains missed.
  s.bills.bills_monitor.checkedAt = asISO(s.clock.value);
  for (const account of s.client.accounts.values()) if (account.balance?.balanceLastUpdatedAt) account.balance.balanceLastUpdatedAt = asISO(s.clock.value - 1000);
  const response = await s.app.fetch(s.request('/api/reconcile')), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.code, 'MONTHLY_FIRST_DAY_ONLY');
  assert.equal(s.client.creates.length, 0);
  assert.ok(s.emails.some(alert => alert.code === 'MONTHLY_CYCLE_MISSED'));
});
