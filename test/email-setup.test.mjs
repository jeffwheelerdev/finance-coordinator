import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EmailSetupError, EMAIL_SETUP_WINDOW_MS, sendEmailSetupTest } from '../lib/email.mjs';

const NOW = Date.parse('2030-01-01T15:00:00.000Z');
const TEST_ID = '00000000-0000-4000-8000-000000000101';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000201';
const environment = overrides => ({ VERCEL_ENV: 'production', APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false',
  ALERTS_SETUP_TEST_ENABLED: 'true', ALERTS_SETUP_TEST_ID: TEST_ID, ALERTS_SETUP_TEST_AUTHORIZED_AT: '2030-01-01T14:00:00.000Z',
  RESEND_API_KEY: 'synthetic-private-email-key', ALERTS_EMAIL_TO: 'owner@example.test',
  ALERTS_EMAIL_FROM: 'Finance Coordinator <alerts@example.test>', ...overrides });

test('setup sends only the fixed clearly labeled message to the configured owner and returns acceptance without inbox proof', async () => {
  const env = environment(), before = structuredClone(env), calls = [];
  const receipt = await sendEmailSetupTest({ env, now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return Response.json({ id: DELIVERY_ID, providerPrivateField: 'must-not-be-returned' });
  }, to: 'attacker@example.test', body: 'caller-controlled message' });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
  assert.equal(calls[0].headers['Idempotency-Key'], `finance-email-setup/v1/${TEST_ID}`);
  const message = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(message).sort(), ['from', 'subject', 'text', 'to']);
  assert.deepEqual(message.to, [env.ALERTS_EMAIL_TO]); assert.equal(message.from, env.ALERTS_EMAIL_FROM);
  assert.equal(message.subject, 'Finance Coordinator email setup test');
  assert.match(message.text, /Financial automation remains disabled/); assert.ok(message.text.includes(receipt.setupReference));
  assert.doesNotMatch(calls[0].body, /attacker|caller-controlled/);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.providerAccepted, true);
  assert.equal(receipt.recipientConfirmed, false); assert.equal(receipt.deliveryId, DELIVERY_ID);
  assert.equal(receipt.financialExecutionEnabled, false); assert.equal(receipt.realTransfers, 0);
  assert.equal(receipt.requestHash, createHash('sha256').update(calls[0].body).digest('hex'));
  const output = JSON.stringify(receipt);
  for (const privateValue of [env.RESEND_API_KEY, env.ALERTS_EMAIL_TO, env.ALERTS_EMAIL_FROM, TEST_ID, 'must-not-be-returned']) {
    assert.equal(output.includes(privateValue), false);
  }
  assert.deepEqual(env, before);
});

test('concurrent invocations and later retries reuse one provider identity and byte-identical content', async () => {
  const accepted = new Map(), requests = [], env = environment(); let time = NOW;
  const fetchImpl = async (_url, options) => {
    const key = options.headers['Idempotency-Key']; requests.push(options);
    if (accepted.has(key)) assert.equal(options.body, accepted.get(key).body);
    else accepted.set(key, { body: options.body, id: DELIVERY_ID });
    return Response.json({ id: accepted.get(key).id });
  };
  const invoke = () => sendEmailSetupTest({ env, now: () => time, fetchImpl });
  const first = await Promise.all([invoke(), invoke()]);
  time += 60000; const retried = await invoke();
  assert.equal(requests.length, 3); assert.equal(accepted.size, 1);
  assert.deepEqual(first[0], first[1]); assert.deepEqual(first[0], retried);
});

test('production, explicit setup authorization and both money-disabled switches are required before any network call', async t => {
  const cases = [
    ['preview', { VERCEL_ENV: 'preview' }, 'EMAIL_SETUP_PRODUCTION_REQUIRED'],
    ['development', { VERCEL_ENV: 'development' }, 'EMAIL_SETUP_PRODUCTION_REQUIRED'],
    ['missing deployment environment', { VERCEL_ENV: undefined }, 'EMAIL_SETUP_PRODUCTION_REQUIRED'],
    ['live mode', { APP_MODE: 'live' }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    ['live transfer switch', { LIVE_TRANSFERS_ENABLED: 'true' }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    ['missing live switch', { LIVE_TRANSFERS_ENABLED: undefined }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    ['boolean instead of literal false', { LIVE_TRANSFERS_ENABLED: false }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    ['setup flag missing', { ALERTS_SETUP_TEST_ENABLED: undefined }, 'EMAIL_SETUP_DISABLED'],
    ['setup flag false', { ALERTS_SETUP_TEST_ENABLED: 'false' }, 'EMAIL_SETUP_DISABLED'],
    ['setup flag wrong case', { ALERTS_SETUP_TEST_ENABLED: 'TRUE' }, 'EMAIL_SETUP_DISABLED'],
  ];
  for (const [name, overrides, code] of cases) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(sendEmailSetupTest({ env: environment(overrides), now: () => NOW,
      fetchImpl: async () => { calls += 1; } }), { code });
    assert.equal(calls, 0);
  });
});

test('the fixed 23-hour authorization window cannot be bypassed with future, normalized or missing timestamps', async t => {
  const cases = [
    ['missing id', { ALERTS_SETUP_TEST_ID: undefined }, 'EMAIL_SETUP_AUTHORIZATION_INVALID'],
    ['not a version-four UUID', { ALERTS_SETUP_TEST_ID: '00000000-0000-1000-8000-000000000101' }, 'EMAIL_SETUP_AUTHORIZATION_INVALID'],
    ['missing authorization time', { ALERTS_SETUP_TEST_AUTHORIZED_AT: undefined }, 'EMAIL_SETUP_AUTHORIZATION_INVALID'],
    ['invalid date', { ALERTS_SETUP_TEST_AUTHORIZED_AT: '2030-02-30T14:00:00Z' }, 'EMAIL_SETUP_AUTHORIZATION_INVALID'],
    ['normalized hour', { ALERTS_SETUP_TEST_AUTHORIZED_AT: '2029-12-31T24:00:00Z' }, 'EMAIL_SETUP_AUTHORIZATION_INVALID'],
    ['future authorization', { ALERTS_SETUP_TEST_AUTHORIZED_AT: '2030-01-01T15:00:01Z' }, 'EMAIL_SETUP_AUTHORIZATION_FROM_FUTURE'],
    ['expired at exact boundary', { ALERTS_SETUP_TEST_AUTHORIZED_AT: new Date(NOW - EMAIL_SETUP_WINDOW_MS).toISOString() }, 'EMAIL_SETUP_WINDOW_EXPIRED'],
  ];
  for (const [name, overrides, code] of cases) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(sendEmailSetupTest({ env: environment(overrides), now: () => NOW,
      fetchImpl: async () => { calls += 1; } }), { code });
    assert.equal(calls, 0);
  });
});

test('invalid sender, recipient and key settings are rejected without revealing their values', async () => {
  for (const overrides of [{ ALERTS_EMAIL_TO: 'owner@example.test,other@example.test' },
    { ALERTS_EMAIL_TO: 'owner@example.test\nBcc: other@example.test' }, { ALERTS_EMAIL_FROM: 'Sender\r\nBcc: other@example.test' },
    { RESEND_API_KEY: undefined }, { RESEND_API_KEY: 'private\nsecret' }, { RESEND_API_KEY: 'private secret' }]) {
    let calls = 0;
    await assert.rejects(sendEmailSetupTest({ env: environment(overrides), now: () => NOW,
      fetchImpl: async () => { calls += 1; } }), error => error.code === 'EMAIL_SETUP_NOT_CONFIGURED' && !error.message.includes('private'));
    assert.equal(calls, 0);
  }
});

test('provider errors remain sanitized and ambiguous delivery never becomes accepted or confirmed', async () => {
  for (const [status, code, uncertain] of [[403, 'EMAIL_SETUP_PROVIDER_REJECTED', false], [429, 'EMAIL_SETUP_RATE_LIMITED', false],
    [500, 'EMAIL_SETUP_PROVIDER_REJECTED', true], [409, 'EMAIL_SETUP_IDEMPOTENCY_CONFLICT', true]]) {
    await assert.rejects(sendEmailSetupTest({ env: environment(), now: () => NOW,
      fetchImpl: async () => new Response('PRIVATE PROVIDER SECRET', { status }) }), error =>
      error instanceof EmailSetupError && error.code === code && error.uncertain === uncertain && !error.message.includes('PRIVATE'));
  }
});

test('malformed, oversized or redirected successful responses require review instead of manufacturing delivery proof', async () => {
  const wrongOrigin = Response.json({ id: DELIVERY_ID }); Object.defineProperty(wrongOrigin, 'url', { value: 'https://untrusted.example.test/emails' });
  for (const response of [Response.json({}), new Response('not JSON'), new Response('x'.repeat(10001)),
    new Response('', { status: 302 }), wrongOrigin]) {
    await assert.rejects(sendEmailSetupTest({ env: environment(), now: () => NOW, fetchImpl: async () => response }),
      error => error.code === 'EMAIL_SETUP_RESPONSE_INVALID' && error.uncertain === true);
  }
});

test('network loss and timeout remain unknown and never trigger automatic retries', async () => {
  let calls = 0;
  await assert.rejects(sendEmailSetupTest({ env: environment(), now: () => NOW,
    fetchImpl: async () => { calls += 1; throw Error('private transport details'); } }),
    error => error.code === 'EMAIL_SETUP_DELIVERY_UNCERTAIN' && error.uncertain && !error.message.includes('private'));
  assert.equal(calls, 1);
  let signal;
  await assert.rejects(sendEmailSetupTest({ env: environment(), now: () => NOW, timeoutMs: 2,
    fetchImpl: (_url, options) => { calls += 1; signal = options.signal; return new Promise(() => {}); } }),
    error => error.code === 'EMAIL_SETUP_DELIVERY_UNCERTAIN' && error.uncertain);
  assert.equal(calls, 2); assert.equal(signal.aborted, true);
});
