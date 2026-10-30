import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../lib/config.mjs';
import { monthlySlot } from '../lib/monthly-schedule.mjs';
import { prepareDashboardControlUpdate } from '../lib/dashboard-controls.mjs';
import { SchedulerError, SCHEDULER_TOPIC, MAX_SCHEDULER_WAKES, parseSchedulerMessage, planSchedulerWakes,
  invokeCanonical, publishSchedulerProbe, consumeSchedulerMessage, schedulerRetry, createSchedulerApp } from '../lib/scheduler.mjs';
import { monthlyFixture as fixture, START } from './monthly-fixture.mjs';

const HOUR = 3_600_000;
const env = { VERCEL_ENV: 'production', APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false',
  FINANCE_CANONICAL_HOST: 'finance.example.test', CRON_SECRET: 'synthetic-cron-secret-32-characters',
  VERCEL_DEPLOYMENT_ID: 'dpl_synthetic', VERCEL_URL: 'old-deployment.example.test' };
const oidc = async () => 'synthetic.runtime.oidc';
const error = expected => value => value.code === expected && !value.message.includes('PRIVATE');
const metadata = () => ({ topicName: SCHEDULER_TOPIC, deliveryCount: 1, expiresAt: new Date(START + 14 * HOUR) });
const probe = () => ({ schemaVersion: 1, kind: 'probe', id: '11111111-1111-4111-8111-111111111111',
  queuedAt: new Date(START).toISOString(), expiresAt: new Date(START + 300_000).toISOString() });
const healthy = () => Response.json({ version: VERSION, status: 'ready', mode: 'observe', liveEnabled: false, private: 'PRIVATE' });
const coordinated = () => Response.json({ status: 'observe', code: 'MONTHLY_ACTIVATION_REQUIRED', private: 'PRIVATE' });
const wake = () => planSchedulerWakes({ config: fixture().config, now: START }).messages[0];
function harness({ config = fixture().config, state = {}, now = () => START, ...overrides } = {}) {
  const calls = { reads: 0, batches: [], fetches: [] };
  const app = createSchedulerApp({ env, now,
    readContext: async () => { calls.reads += 1; return { config, state }; },
    sendBatchImpl: async (topic, batch) => { calls.batches.push({ topic, batch }); return batch.map((_, index) => ({ status: 'sent', messageId: `synthetic-${index}` })); },
    fetchImpl: async (url, options) => { calls.fetches.push({ url, options }); return coordinated(); },
    getOidcToken: oidc, log: { error() {} }, ...overrides });
  const request = (url = `https://${env.FINANCE_CANONICAL_HOST}/api/scheduler`, options = {}) =>
    app.fetch(new Request(url, { headers: { Authorization: `Bearer ${env.CRON_SECRET}` }, ...options }));
  return { calls, request };
}

test('winter and summer wakes stop at the last hourly boundary before actual New York midnight', () => {
  for (const [monthKey, count, finalHour, expiry] of [
    ['2030-01', 13, '04:00:00.000Z', '2030-01-02T05:00:00.000Z'],
    ['2030-07', 12, '03:00:00.000Z', '2030-07-02T04:00:00.000Z'],
  ]) {
    const config = structuredClone(fixture().config);
    config.activationAt = `${monthKey}-01T14:00:00.000Z`;
    const result = planSchedulerWakes({ config, now: Date.parse(`${monthKey}-01T15:59:00.000Z`) });
    assert.equal(result.messages.length, count); assert.ok(count <= MAX_SCHEDULER_WAKES);
    assert.equal(result.messages[0].wakeAt, `${monthKey}-01T16:00:00.000Z`);
    assert.ok(result.messages.at(-1).wakeAt.endsWith(finalHour));
    assert.ok(result.messages.every(row => row.expiresAt === expiry && Date.parse(row.wakeAt) < Date.parse(expiry)));
  }
});

test('shared calendar respects custom days, early December and prospective activation', () => {
  const config = structuredClone(fixture().config);
  Object.assign(config.monthly, { executionDay: 20, decemberDay: 5 });
  config.activationAt = '2029-12-01T14:00:00.000Z';
  assert.equal(planSchedulerWakes({ config, now: Date.parse('2030-06-20T15:03:00.000Z') }).messages[0].date, '2030-06-20');
  assert.equal(planSchedulerWakes({ config, now: Date.parse('2030-12-05T15:03:00.000Z') }).messages[0].date, '2030-12-05');
  assert.equal(planSchedulerWakes({ config, now: Date.parse('2030-12-20T15:03:00.000Z') }).messages.length, 0);
  config.activationAt = '2030-06-20T15:30:00.000Z';
  assert.equal(planSchedulerWakes({ config, now: Date.parse('2030-06-20T15:45:00.000Z') }).messages.length, 0);
});

test('off-day, before-due, closed and inactive prospective windows publish no delayed money wakes', () => {
  const config = fixture().config;
  for (const now of [START - 1, START + 14 * HOUR, START + 24 * HOUR]) assert.equal(planSchedulerWakes({ config, now }).messages.length, 0);
  const inactive = fixture({ mode: 'observe', activationAt: null }).config;
  assert.equal(planSchedulerWakes({ config: inactive, now: START + 60_000 }).messages.length, 0);
});

test('frozen monthly slot survives future budget and calendar edits', async () => {
  const s = fixture(); await s.run();
  const changed = prepareDashboardControlUpdate({ config: s.config, state: s.store.value, expectedRevision: 0,
    changes: { executionDay: 20 }, now: START + 60_000 });
  const result = planSchedulerWakes({ config: s.config, state: changed.state, now: START + 120_000 });
  assert.equal(result.date, '2030-01-01'); assert.equal(result.messages.length, 13);
  const complete = structuredClone(changed.state); complete.monthly.cycles['2030-01'].status = 'COMPLETE';
  assert.equal(planSchedulerWakes({ config: s.config, state: complete, now: START + HOUR }).messages.length, 0);
});

test('Hobby15:37 jitter still publishes in the first live unbound cycle and a paused bound cycle', async () => {
  const s = fixture(), at = START + 37 * 60_000;
  const first = planSchedulerWakes({ config: s.config, state: {}, now: at });
  assert.equal(first.messages.length, 13); assert.equal(first.messages[0].wakeAt, '2030-01-01T16:00:00.000Z');
  await s.run();
  const paused = { ...s.config, mode: 'observe', liveEnabled: false };
  const bound = planSchedulerWakes({ config: paused, state: s.store.value, now: at });
  assert.deepEqual(bound.messages, first.messages);
});

test('wake schema cannot contain routes, amounts, alternate expiry or non-hourly times', () => {
  const valid = wake(); assert.deepEqual(parseSchedulerMessage(valid), valid);
  for (const value of [{ ...valid, url: 'https://elsewhere.invalid' }, { ...valid, amountInCents: 1 },
    { ...valid, kind: 'transfer' }, { ...valid, wakeAt: '2030-01-01T16:00:01.000Z' },
    { ...valid, expiresAt: '2030-01-03T05:00:00.000Z' }, { ...valid, date: '2030-02-29' },
    { ...valid, date: '2030-12-20' }, null, [], { ...valid, schemaVersion: 2 }]) {
    assert.throws(() => parseSchedulerMessage(value), error('SCHEDULER_MESSAGE_INVALID'));
  }
});

test('daily producer publishes finite deterministic delayed wakes then invokes canonical once', async () => {
  const h = harness(); const result = await h.request(), body = await result.json();
  assert.equal(result.status, 200); assert.equal(body.delayedWakeCount, 13); assert.equal(body.deliveryConfirmed, false);
  assert.equal(h.calls.batches.length, 1); assert.equal(h.calls.fetches.length, 1);
  const batch = h.calls.batches[0]; assert.equal(batch.topic, SCHEDULER_TOPIC);
  assert.equal(batch.batch[0].delaySeconds, 3600); assert.equal(batch.batch[0].retentionSeconds, 14 * 3600);
  assert.equal(new Set(batch.batch.map(row => row.idempotencyKey)).size, 13);
  assert.ok(batch.batch.every(row => row.retentionSeconds > row.delaySeconds));
  assert.equal(h.calls.fetches[0].url, `https://${env.FINANCE_CANONICAL_HOST}/api/reconcile`);
  assert.equal(h.calls.fetches[0].options.method, 'POST'); assert.equal(h.calls.fetches[0].options.body, undefined);
  assert.equal(h.calls.fetches[0].options.redirect, 'error');
  assert.equal(h.calls.fetches[0].options.headers['x-vercel-trusted-oidc-idp-token'], await oidc());
  assert.ok(!JSON.stringify(body).includes('PRIVATE')); assert.ok(!JSON.stringify(body).includes(env.CRON_SECRET));
  await h.request();
  assert.deepEqual(h.calls.batches[0].batch.map(row => row.idempotencyKey), h.calls.batches[1].batch.map(row => row.idempotencyKey));
});

test('daily off-window call continues settlement monitoring without a delayed batch', async () => {
  const h = harness({ now: () => START + 24 * HOUR }); const result = await h.request();
  assert.equal(result.status, 200); assert.equal(h.calls.batches.length, 0); assert.equal(h.calls.fetches.length, 1);
});

test('unauthorized, wrong method, preview and caller-selected query cannot read or enqueue', async () => {
  const h = harness();
  assert.equal((await h.request(undefined, { headers: {} })).status, 401);
  assert.equal((await h.request(undefined, { method: 'POST' })).status, 405);
  assert.equal((await h.request(`https://${env.FINANCE_CANONICAL_HOST}/api/scheduler?url=elsewhere`)).status, 503);
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.batches.length, 0);
  const preview = harness({ env: { ...env, VERCEL_ENV: 'preview' } });
  assert.equal((await preview.request()).status, 503); assert.equal(preview.calls.reads, 0);
});

test('production cron can arrive on its exact platform hostname but the wake always targets canonical', async () => {
  const h = harness({ now: () => START + 24 * HOUR });
  assert.equal((await h.request(`https://${env.VERCEL_URL}/api/scheduler`)).status, 200);
  assert.equal(h.calls.fetches[0].url, `https://${env.FINANCE_CANONICAL_HOST}/api/reconcile`);
  for (const url of ['https://other.example.test/api/scheduler', `http://${env.VERCEL_URL}/api/scheduler`,
    `https://suffix.${env.VERCEL_URL}/api/scheduler`, `https://${env.VERCEL_URL}:8443/api/scheduler`]) {
    assert.equal((await h.request(url)).status, 503);
  }
  assert.equal(h.calls.reads, 1); assert.equal(h.calls.fetches.length, 1);
  const poisoned = harness({ env: { ...env, VERCEL_URL: 'https://other.example.test' } });
  assert.equal((await poisoned.request('https://other.example.test/api/scheduler')).status, 503);
  assert.equal(poisoned.calls.reads, 0);
});

test('partial or uncertain publish remains explicit while primary daily coordinator still runs', async () => {
  for (const sendBatchImpl of [async (_, batch) => batch.map((_, index) => index ? { status: 'deferred', messageId: null } : { status: 'failed', error: 'PRIVATE' }),
    async () => { throw new Error('PRIVATE provider body and credentials'); }]) {
    const h = harness({ sendBatchImpl }), result = await h.request(), body = await result.json();
    assert.equal(result.status, 503); assert.equal(body.status, 'partial'); assert.equal(h.calls.fetches.length, 1);
    assert.equal(body.deliveryConfirmed, false); assert.ok(!JSON.stringify(body).includes('PRIVATE'));
  }
});

test('source read failure is sanitized and cannot submit a wake or financial request', async () => {
  const h = harness({ readContext: async () => { throw new Error('PRIVATE ledger'); } });
  assert.deepEqual(await (await h.request()).json(), { status: 'blocked', code: 'SCHEDULER_SAVED_STATE_UNAVAILABLE' });
  assert.equal(h.calls.fetches.length, 0); assert.equal(h.calls.batches.length, 0);
});

test('canonical transport requires runtime OIDC and never follows redirects or switches auth after a request', async () => {
  let calls = 0;
  await assert.rejects(invokeCanonical({ env, now: () => START, getOidcToken: async () => null,
    fetchImpl: async () => { calls += 1; return coordinated(); } }), error('SCHEDULER_OIDC_UNAVAILABLE'));
  assert.equal(calls, 0);
  await assert.rejects(invokeCanonical({ env, now: () => START, getOidcToken: oidc,
    fetchImpl: async (_, options) => { calls += 1; assert.equal(options.redirect, 'error'); return new Response('', { status: 302, headers: { Location: 'https://private.invalid' } }); } }), error('SCHEDULER_CANONICAL_HTTP_ERROR'));
  assert.equal(calls, 1);
});

test('canonical transport checks again when identity retrieval crosses midnight', async () => {
  let now = START + 14 * HOUR - 1, calls = 0;
  await assert.rejects(invokeCanonical({ env, expiresAt: '2030-01-02T05:00:00.000Z', now: () => now,
    getOidcToken: async () => { now += 2; return 'synthetic'; }, fetchImpl: async () => { calls += 1; return coordinated(); } }), error('SCHEDULER_WINDOW_CLOSED'));
  assert.equal(calls, 0);
});

test('canonical timeout aborts the bounded request and returns only a safe code', async () => {
  let signal;
  await assert.rejects(invokeCanonical({ env, expiresAt: new Date(START + 20).toISOString(), now: () => START,
    getOidcToken: oidc, fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); } }), error('SCHEDULER_CANONICAL_TIMEOUT'));
  assert.equal(signal.aborted, true);
});

test('invalid response bodies and busy runs are not marked as a successful wake', async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response('PRIVATE HTML', { status: 200 }), 'SCHEDULER_CANONICAL_RESPONSE_INVALID'],
    [async () => Response.json({ status: 'complete', code: 'private details' }), 'SCHEDULER_CANONICAL_RESPONSE_INVALID'],
    [async () => Response.json({ status: 'busy', code: 'BUSY' }), 'SCHEDULER_COORDINATOR_BUSY'],
    [async () => new Response('"' + 'x'.repeat(70_000) + '"', { headers: { 'Content-Type': 'application/json' } }), 'SCHEDULER_CANONICAL_RESPONSE_INVALID'],
  ]) await assert.rejects(invokeCanonical({ env, now: () => START, getOidcToken: oidc, fetchImpl }), error(expected));
});

test('private consumer expires old messages before authentication and never republishes', async () => {
  let calls = 0;
  const result = await consumeSchedulerMessage(wake(), metadata(), { env, now: () => START + 14 * HOUR,
    getOidcToken: async () => { calls += 1; return 'token'; }, fetchImpl: async () => { calls += 1; return coordinated(); } });
  assert.equal(result.code, 'SCHEDULER_WINDOW_CLOSED'); assert.equal(calls, 0);
  const limited = await consumeSchedulerMessage(wake(), { ...metadata(), deliveryCount: 4 }, { env, now: () => START + HOUR });
  assert.equal(limited.code, 'SCHEDULER_DELIVERY_LIMIT');
  await assert.rejects(consumeSchedulerMessage(wake(), { ...metadata(), topicName: 'other' }, { env }), error('SCHEDULER_DELIVERY_INVALID'));
});

test('duplicate wakes call the guarded current coordinator and cannot duplicate synthetic financial requests', async () => {
  const s = fixture(); s.clock.value = START + HOUR; s.refresh();
  let calls = 0;
  const options = { env: { ...env, VERCEL_URL: 'old-production-deployment.example.test' }, now: () => s.clock.value, getOidcToken: oidc,
    fetchImpl: async (url, options) => { calls += 1; assert.equal(url, `https://${env.FINANCE_CANONICAL_HOST}/api/reconcile`);
      assert.equal(options.method, 'POST'); return Response.json(await s.run()); } };
  await consumeSchedulerMessage(wake(), metadata(), options);
  const first = [...s.client.transfers.keys()]; assert.equal(first.length, 6);
  await consumeSchedulerMessage(wake(), { ...metadata(), deliveryCount: 2 }, options);
  assert.deepEqual([...s.client.transfers.keys()], first); assert.equal(calls, 2);
});

test('an older queue callback observes current canonical pause instead of its old live environment', async () => {
  const s = fixture({ mode: 'observe' }); s.clock.value = START + HOUR; s.refresh();
  const result = await consumeSchedulerMessage(wake(), metadata(), { env: { ...env, APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' },
    now: () => s.clock.value, getOidcToken: oidc, fetchImpl: async () => Response.json(await s.run()) });
  assert.equal(result.coordinator.status, 'observe'); assert.equal(s.client.transfers.size, 0);
});

test('queue retry policy is bounded and acknowledges expired or permanently invalid messages', () => {
  assert.deepEqual(schedulerRetry(new SchedulerError('TEMPORARY'), metadata(), START), { afterSeconds: 300 });
  assert.deepEqual(schedulerRetry(new SchedulerError('BAD', { permanent: true }), metadata(), START), { acknowledge: true });
  assert.deepEqual(schedulerRetry(new SchedulerError('TEMPORARY'), { ...metadata(), deliveryCount: 3 }, START), { acknowledge: true });
  assert.deepEqual(schedulerRetry(new SchedulerError('TEMPORARY'), metadata(), START + 14 * HOUR), { acknowledge: true });
});

test('probe publication is one delayed health-only message gated to inactive production', async () => {
  const calls = [];
  const result = await publishSchedulerProbe({ env, probe: probe(), now: () => START,
    sendImpl: async (...args) => { calls.push(args); return { messageId: 'PRIVATE' }; } });
  assert.equal(result.status, 'queued'); assert.equal(result.deliveryConfirmed, false); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SCHEDULER_TOPIC); assert.deepEqual(calls[0][1], probe());
  assert.deepEqual(calls[0][2], { delaySeconds: 60, retentionSeconds: 300, idempotencyKey: `finance-probe-v1:${probe().id}` });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for (const change of [{ APP_MODE: 'live' }, { LIVE_TRANSFERS_ENABLED: 'true' }, { VERCEL_ENV: 'preview' }]) {
    await assert.rejects(publishSchedulerProbe({ env: { ...env, ...change }, probe: probe(), now: () => START,
      sendImpl: async () => { throw new Error('must never publish'); } }), value => value instanceof SchedulerError);
  }
});

test('probe callback can only GET health and completes the receipt after verified inactive current-version response', async () => {
  let proof, calls = 0;
  const result = await consumeSchedulerMessage(probe(), metadata(), { env, now: () => START + 60_000, getOidcToken: oidc,
    fetchImpl: async (url, options) => { calls += 1; assert.equal(url, `https://${env.FINANCE_CANONICAL_HOST}/api/health`);
      assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); return healthy(); },
    completeProbeImpl: async value => { proof = value; } });
  assert.equal(calls, 1); assert.equal(result.financialExecutionRequested, false); assert.equal(result.code, 'SCHEDULER_PROBE_DELIVERED');
  assert.deepEqual(proof.health, { status: 200, applicationStatus: 'ready', softwareVersion: VERSION, mode: 'observe', liveEnabled: false });
  assert.ok(!JSON.stringify(proof.health).includes('PRIVATE'));
});

test('even a live-environment probe never invokes reconcile or accepts live, old-version or HTML health', async () => {
  for (const body of [{ status: 'ready', version: VERSION, mode: 'live', liveEnabled: true },
    { status: 'ready', version: '0.1.0', mode: 'observe', liveEnabled: false },
    { status: 'configuration_required', version: VERSION, mode: 'observe', liveEnabled: false }]) {
    let proofs = 0;
    await assert.rejects(consumeSchedulerMessage(probe(), metadata(), { env: { ...env, APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' },
      now: () => START + 60_000, getOidcToken: oidc, fetchImpl: async (url, options) => {
        assert.ok(url.endsWith('/api/health')); assert.equal(options.method, 'GET'); return Response.json(body); },
      completeProbeImpl: async () => { proofs += 1; } }), error('SCHEDULER_PROBE_HEALTH_INVALID'));
    assert.equal(proofs, 0);
  }
});

test('probe extra fields, wrong expiry, exhausted TTL and receipt failure cannot claim completed delivery', async () => {
  for (const value of [{ ...probe(), route: '/api/reconcile' }, { ...probe(), expiresAt: new Date(START + 301_000).toISOString() },
    { ...probe(), id: 'arbitrary' }]) assert.throws(() => parseSchedulerMessage(value), error('SCHEDULER_MESSAGE_INVALID'));
  await assert.rejects(publishSchedulerProbe({ env, probe: probe(), now: () => START + 240_000,
    sendImpl: async () => { throw new Error('must not publish'); } }), error('SCHEDULER_PROBE_EXPIRED'));
  await assert.rejects(consumeSchedulerMessage(probe(), metadata(), { env, now: () => START + 60_000, getOidcToken: oidc,
    fetchImpl: healthy, completeProbeImpl: async () => { throw new Error('PRIVATE receipt details'); } }), error('SCHEDULER_PROBE_RECEIPT_FAILED'));
});

test('queue entrypoint uses documented Node callback and contains no direct money or publishing path', async () => {
  const source = await readFile(new URL('../api/queue-wake.mjs', import.meta.url), 'utf8');
  assert.match(source, /handleNodeCallback/); assert.match(source, /schedulerRetry/);
  for (const forbidden of ['SequenceClient', 'reconcileMonthly', 'createTransfer', '.send(', 'sendBatch', 'createApp']) assert.ok(!source.includes(forbidden));
  const imported = await import('../api/queue-wake.mjs'); assert.equal(typeof imported.default, 'function');
});
