import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../lib/app.mjs';
import { loadConfig } from '../lib/config.mjs';
import { verifiedWebhook, recordWebhook } from '../lib/webhook.mjs';
import { initialState } from '../lib/engine.mjs';
import { FakeStore, FakeSequence, ID, TEST_NOW, asISO } from './fixtures.mjs';

const fixtureEnv = Object.fromEntries(readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split('\n')
  .filter((line) => line && !line.startsWith('#')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const secret = 'synthetic-webhook-secret-for-offline-tests';
const cron = 'synthetic-cron-secret-for-offline-tests';

function setup(overrides = {}) {
  const env = { ...fixtureEnv, SEQUENCE_API_KEY: 'synthetic-provider-key', BLOB_READ_WRITE_TOKEN: 'synthetic-blob-token', CRON_SECRET: cron, SEQUENCE_WEBHOOK_SECRET: secret, ...overrides };
  const config = loadConfig(env), store = new FakeStore(), clock = { value: TEST_NOW };
  const client = new FakeSequence(config, clock), messages = [], pending = [];
  const app = createApp({ env, now: () => clock.value, clientFactory: () => client, storeFactory: () => store,
    background: (promise) => pending.push(promise), log: { error: (message) => messages.push(message) } });
  return { app, env, config, store, client, clock, messages, pending };
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
  for (const path of ['status', 'preflight', 'plan', 'reconcile']) {
    const response = await s.app.fetch(new Request(`https://example.test/api/${path}`, { headers: { authorization: `Bearer ${cron}wrong` } }));
    assert.equal(response.status, 401);
  }
  assert.equal(s.client.calls.length, 0); assert.equal(s.store.writes.length, 0);
});

test('authenticated preflight uses reads and reports that transfer permission was not exercised', async () => {
  const s = setup();
  const response = await s.app.fetch(new Request('https://example.test/api/preflight', { headers: { authorization: `Bearer ${cron}` } }));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.transferPermission, 'not_exercised');
  assert.equal(body.configuration.allocations[0].targetCents, 300000);
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
