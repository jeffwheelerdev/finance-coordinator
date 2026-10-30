import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../lib/app.mjs';
import { loadConfig, withCalculatedBillsTarget } from '../lib/config.mjs';
import { forecastBills } from '../lib/bills.mjs';
import { verifiedWebhook, recordWebhook } from '../lib/webhook.mjs';
import { initialState } from '../lib/engine.mjs';
import { FakeStore, FakeSequence, ID, TEST_NOW, asISO } from './fixtures.mjs';
import { rothEnvelopeFixture } from './roth-policy-fixture.mjs';

const fixtureEnv = Object.fromEntries(readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split('\n')
  .filter((line) => line && !line.startsWith('#')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const secret = 'synthetic-webhook-secret-for-offline-tests';
const cron = 'synthetic-cron-secret-for-offline-tests';

function setup(overrides = {}) {
  const env = { ...fixtureEnv, SEQUENCE_API_KEY: 'synthetic-provider-key', BLOB_READ_WRITE_TOKEN: 'synthetic-blob-token', CRON_SECRET: cron, SEQUENCE_WEBHOOK_SECRET: secret,
    GLOBAL_CONFIG: 'synthetic-private-policy-connection', ...overrides };
  const policy = policyFixture();
  const rothSource = { roth_policy: rothEnvelopeFixture() };
  rothSource.roth_policy.policy.updatedAt = asISO(TEST_NOW - 60_000);
  rothSource.roth_policy.policy.statutoryLimits[0].year = 2030;
  rothSource.roth_policy.policy.years[0].year = 2030;
  const config = withCalculatedBillsTarget(loadConfig(env), forecastBills(policy.bills_catalog, { now: TEST_NOW })), store = new FakeStore(), clock = { value: TEST_NOW, advance(ms) { this.value += ms; } };
  const client = new FakeSequence(config, clock), messages = [], pending = [];
  let policyReads = 0;
  const app = createApp({ env, now: () => clock.value, clientFactory: () => client, storeFactory: () => store,
    billsReader: async () => { policyReads += 1; if (policy.failure) throw policy.failure; return structuredClone(policy); },
    rothReader: async () => { if (rothSource.failure) throw rothSource.failure; return structuredClone(rothSource); },
    background: (promise) => pending.push(promise), log: { error: (message) => messages.push(message) } });
  return { app, env, config, store, client, clock, messages, pending, policy, rothSource, policyReads: () => policyReads };
}

function policyFixture() {
  const updatedAt = asISO(TEST_NOW - 60_000);
  return {
    bills_catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt, bills: [{
      id: 'synthetic-utility', name: 'Synthetic utility', kind: 'expense', status: 'active',
      amountCents: 45000, frequency: 'monthly',
      evidence: { type: 'user_confirmation', reference: 'Offline fixture', observedAt: updatedAt },
    }] },
    bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: asISO(TEST_NOW), catalogUpdatedAt: updatedAt, reviewCodes: [] },
  };
}

function signed({ event = { id: ID(801), type: 'transfer.changed', resource: { type: 'transfer', id: ID(101) }, created_at: asISO(TEST_NOW) },
  raw = JSON.stringify(event, null, 2), timestamp = Math.floor(TEST_NOW / 1000), key = secret, headers = {} } = {}) {
  const signature = createHmac('sha256', key).update(`${timestamp}.`).update(raw).digest('hex');
  return new Request('https://example.test/api/webhook', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-sequence-signature': `t=${timestamp},v1=${signature}`, 'x-sequence-event-id': event.id, ...headers } });
}

test('health is safe without auth and never accesses provider/storage', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/health'));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.liveEnabled, false);
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.reads, 0);
  const text = JSON.stringify(body);
  for (const privateValue of [s.env.SEQUENCE_API_KEY, cron, secret, ...Object.values(s.config.accounts), 'monthlyBudgetCents']) assert.ok(!text.includes(privateValue));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('all administration routes reject missing or incorrect authorization', async () => {
  const s = setup();
  for (const path of ['status', 'preflight', 'plan', 'bills', 'roth', 'reconcile']) {
    const response = await s.app.fetch(new Request(`https://example.test/api/${path}`, { headers: { authorization: `Bearer ${cron}wrong` } }));
    assert.equal(response.status, 401);
  }
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.writes.length, 0); assert.equal(s.policyReads(), 0);
});

test('rewritten Vercel destinations retain routing and authorization', async () => {
  const s = setup();
  assert.equal((await s.app.fetch(new Request('https://example.test/api/index?route=health'))).status, 200);
  assert.equal((await s.app.fetch(new Request('https://example.test/api/index?route=reconcile'))).status, 401);
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.writes.length, 0);
});

test('authenticated preflight uses reads and reports that transfer permission was not exercised', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/preflight', { headers: { authorization: `Bearer ${cron}` } }));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.transferPermission, 'not_exercised');
  assert.equal(body.configuration.allocations.find(item => item.id === 'general-spending').targetCents, 300000);
  assert.equal(body.configuration.allocations[0].id, 'bills');
  assert.equal(body.configuration.allocations[0].targetCents, 50000);
  assert.equal(s.client.creates.length, 0); assert.equal(s.store.writes.length, 0);
});

test('plan in live configuration cannot submit or consume a refund', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW - 86400000) });
  const response = await s.app.fetch(new Request('https://example.test/api/plan', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 200); assert.equal((await response.json()).code, 'READ_ONLY_PLAN');
  assert.equal(s.client.creates.length, 0); assert.equal(s.store.writes.length, 0);
});

test('observe reconcile ignores caller query attempts to enable live transfers', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/reconcile?live=true&amount=999999999', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'observe');
  assert.equal(s.client.creates.length, 0);
  assert.deepEqual(s.store.value.events, {});
});

test('reconcile rejects a request body containing a money instruction', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/reconcile', { method: 'POST', body: '{"amount":1}', headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 400); assert.equal(s.client.calls.length, 0); assert.equal(s.store.writes.length, 0);
});

test('preview deployments cannot touch the financial ledger even with live flags', async () => {
  const s = setup({ VERCEL_ENV: 'preview', APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW - 86400000) });
  const response = await s.app.fetch(new Request('https://preview.example.test/api/reconcile', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED');
  assert.equal(s.store.reads, 0); assert.equal(s.client.creates.length, 0);
});

test('old production deployment hosts cannot reconcile stale configuration', async () => {
  const s = setup({ VERCEL_ENV: 'production', FINANCE_CANONICAL_HOST: 'current.example.test' });
  const response = await s.app.fetch(new Request('https://old.example.test/api/reconcile', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CANONICAL_PRODUCTION_HOST_REQUIRED');
  assert.equal(s.store.reads, 0); assert.equal(s.client.creates.length, 0);
});

test('a future activation can pass read-only preflight without querying a reversed time window', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW + 86400000) });
  const response = await s.app.fetch(new Request('https://example.test/api/preflight', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activationRequired, true); assert.equal(body.upstream.status, 'activation_not_started');
  assert.equal(s.client.creates.length, 0);
});

test('raw bytes, not reserialized JSON, determine the webhook signature', async () => {
  const event = await verifiedWebhook(signed(), secret, TEST_NOW);
  assert.equal(event.id, ID(801));
  const request = signed();
  const bad = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(JSON.parse(await request.text())) });
  await assert.rejects(verifiedWebhook(bad, secret, TEST_NOW), { code: 'INVALID_SIGNATURE' });
});

test('webhooks reject expired signatures, wrong event headers, and absent signing keys', async () => {
  await assert.rejects(verifiedWebhook(signed({ timestamp: Math.floor(TEST_NOW / 1000) - 301 }), secret, TEST_NOW), { code: 'SIGNATURE_EXPIRED' });
  await assert.rejects(verifiedWebhook(signed({ headers: { 'x-sequence-event-id': ID(802) } }), secret, TEST_NOW), { code: 'INVALID_EVENT' });
  await assert.rejects(verifiedWebhook(signed(), '', TEST_NOW), { code: 'WEBHOOK_NOT_CONFIGURED' });
});

test('signed request is durable before acknowledgement and duplicate delivery is harmless', async () => {
  const s = setup();
  const response = await s.app.fetch(signed());
  assert.equal(response.status, 202);
  assert.ok(s.store.value.inbox[ID(801)]);
  await Promise.all(s.pending);
  const duplicate = await s.app.fetch(signed());
  assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).duplicate, true);
  await Promise.all(s.pending);
  assert.equal(s.client.creates.length, 0);
  assert.equal(Object.keys(s.store.value.inbox).length, 1);
});

test('a storage failure never acknowledges a new webhook', async () => {
  const s = setup();
  s.store.compareAndSwap = async () => { throw Object.assign(new Error('private detail'), { code: 'STORE_UNAVAILABLE' }); };
  const response = await s.app.fetch(signed());
  assert.equal(response.status, 503); assert.equal(s.pending.length, 0);
  assert.ok(!JSON.stringify(s.messages).includes('private detail'));
});

test('busy lease asks Sequence to retry without modifying an in-progress ledger', async () => {
  const store = new FakeStore({ ...initialState(), lease: { owner: ID(900), expiresAt: asISO(TEST_NOW + 300000) } });
  const event = await verifiedWebhook(signed(), secret, TEST_NOW);
  await assert.rejects(recordWebhook(store, event, TEST_NOW), { code: 'LEDGER_BUSY' });
  assert.equal(store.writes.length, 0);
});

test('inbox eviction never erases handled refund identity', async () => {
  const oldId = ID(804), state = initialState();
  state.inbox[oldId] = { event: { id: oldId }, receivedAt: asISO(TEST_NOW - 49 * 3600000) };
  const eventKey = `${ID(12)}:${ID(201)}`;
  state.events[eventKey] = { key: eventKey, status: 'COMPLETE', children: { 'general-spending': { allocationId: 'general-spending', status: 'NOOP' } } };
  const store = new FakeStore(state), event = await verifiedWebhook(signed(), secret, TEST_NOW);
  await recordWebhook(store, event, TEST_NOW);
  assert.equal(store.value.inbox[oldId], undefined); assert.equal(store.value.events[eventKey].status, 'COMPLETE');
});

test('reused event ID with different signed metadata is rejected', async () => {
  const store = new FakeStore(), event = await verifiedWebhook(signed(), secret, TEST_NOW);
  await recordWebhook(store, event, TEST_NOW);
  await assert.rejects(recordWebhook(store, { ...event, resource: { type: 'transfer', id: ID(999) } }, TEST_NOW), { code: 'EVENT_ID_REUSED' });
});

test('large webhook bodies are rejected before persistence', async () => {
  await assert.rejects(verifiedWebhook(signed({ raw: 'x'.repeat(70000) }), secret, TEST_NOW), { code: 'BODY_TOO_LARGE' });
});

test('bill forecast is private, read-only, and follows changed configuration without redeploying', async () => {
  const s = setup();
  const request = () => new Request('https://example.test/api/bills', { headers: { authorization: `Bearer ${cron}` } });
  let response = await s.app.fetch(request()), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.targetCents, 50000); assert.equal(body.months.length, 12);
  s.policy.bills_catalog.bills[0].amountCents = 50001;
  s.policy.bills_catalog.updatedAt = asISO(TEST_NOW);
  s.policy.bills_monitor.catalogUpdatedAt = asISO(TEST_NOW);
  response = await s.app.fetch(request()); body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.targetCents, 100000);
  assert.equal(s.policyReads(), 2); assert.equal(s.client.creates.length, 0); assert.equal(s.store.writes.length, 0);
  assert.ok(!JSON.stringify(body).includes('Synthetic utility'));
});

test('stale bill monitoring blocks a new refund allocation before a financial provider call', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW - 86400000) });
  s.clock.advance(8 * 86400000);
  const response = await s.app.fetch(new Request('https://example.test/api/reconcile', { headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BILLS_MONITOR_STALE');
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.writes.length, 0);
});

test('known accepted transfers remain observable during a catalog outage without any new transfer', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW - 86400000) });
  const request = () => new Request('https://example.test/api/reconcile', { headers: { authorization: `Bearer ${cron}` } });
  let response = await s.app.fetch(request()), body = await response.json();
  assert.equal(body.status, 'pending'); assert.equal(s.client.creates.length, 1);
  const transferId = [...s.client.accepted.values()][0];
  s.client.settle(transferId);
  s.policy.failure = new Error('private-connection-token-must-never-leak');
  response = await s.app.fetch(request()); body = await response.json();
  assert.equal(body.code, 'TOPUP_SETTLED'); assert.equal(body.billsPolicyError, 'BILLS_SOURCE_UNAVAILABLE');
  assert.equal(body.newSubmissionsBlocked, true); assert.equal(s.client.creates.length, 1);
  assert.ok(!JSON.stringify(body).includes('private-connection'));
  assert.ok(!JSON.stringify(s.messages).includes('private-connection'));
  response = await s.app.fetch(request());
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BILLS_SOURCE_UNAVAILABLE');
  assert.equal(s.client.creates.length, 1);
});

test('an unknown submission outcome is never retried during a bill catalog outage', async () => {
  const s = setup({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', AUTOMATION_START_AT: asISO(TEST_NOW - 86400000) });
  s.client.onCreate = () => { throw Object.assign(new Error('Network uncertainty'), { uncertain: true }); };
  const request = () => new Request('https://example.test/api/reconcile', { headers: { authorization: `Bearer ${cron}` } });
  let response = await s.app.fetch(request());
  assert.equal((await response.json()).status, 'uncertain'); assert.equal(s.client.creates.length, 1);
  s.policy.failure = new Error('Catalog unavailable'); s.clock.advance(61000);
  response = await s.app.fetch(request());
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BILLS_SOURCE_UNAVAILABLE');
  assert.equal(s.client.creates.length, 1);
});

test('invalid webhook signatures never read the bill catalog or financial provider', async () => {
  const s = setup();
  const response = await s.app.fetch(signed({ key: 'incorrect-offline-key' }));
  assert.equal(response.status, 401); assert.equal(s.policyReads(), 0); assert.equal(s.client.calls.length, 0);
});

test('bill routes reject writes and rewritten routes preserve authentication', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/bills', { method: 'POST', headers: { authorization: `Bearer ${cron}` } }));
  assert.equal(response.status, 405);
  assert.equal((await s.app.fetch(new Request('https://example.test/api/index?route=bills'))).status, 401);
  assert.equal(s.policyReads(), 0); assert.equal(s.client.calls.length, 0);
});

test('Roth endpoint shows aggregate unknown eligibility without exposing private bindings or writes', async () => {
  const s = setup({ ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: ID(60) });
  const response = await s.app.fetch(new Request('https://example.test/api/roth', { headers: { authorization: `Bearer ${cron}` } }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.monthlyAmountCents, 62500);
  assert.equal(body.eligible, false);
  assert.ok(body.blockers.includes('ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED'));
  assert.equal(s.client.creates.length, 0);
  assert.equal(s.store.writes.length, 0);
  for (const privateValue of [ID(60), ...Object.values(s.config.accounts), s.env.SEQUENCE_API_KEY, cron]) {
    assert.equal(JSON.stringify(body).includes(privateValue), false);
  }
});

test('a Roth source outage does not suppress the Bills forecast or corrupt its policy', async () => {
  const s = setup({ ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: ID(60) });
  s.rothSource.failure = new Error('private-roth-source-secret');
  const headers = { authorization: `Bearer ${cron}` };
  const response = await s.app.fetch(new Request('https://example.test/api/bills', { headers }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).targetCents, 50000);
  const roth = await s.app.fetch(new Request('https://example.test/api/roth', { headers }));
  const body = await roth.json();
  assert.equal(roth.status, 200);
  assert.ok(body.blockers.includes('ROTH_SOURCE_UNAVAILABLE'));
  assert.equal(JSON.stringify(body).includes('private-roth-source'), false);
  assert.equal(s.client.creates.length, 0);
});

test('Roth routes reject mutations and rewritten routes preserve authentication', async () => {
  const s = setup();
  assert.equal((await s.app.fetch(new Request('https://example.test/api/roth', { method: 'POST', headers: { authorization: `Bearer ${cron}` } }))).status, 405);
  assert.equal((await s.app.fetch(new Request('https://example.test/api/index?route=roth'))).status, 401);
  assert.equal(s.policyReads(), 0);
  assert.equal(s.client.calls.length, 0);
});
