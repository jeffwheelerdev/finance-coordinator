import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../lib/app.mjs';

const NOW = Date.parse('2030-01-01T15:00:00.000Z');
const SECRET = 'synthetic-private-setup-route-secret';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000201';
const TEST_ID = '00000000-0000-4000-8000-000000000101';

function setup(overrides = {}, fetchImpl = null) {
  // No financial account, bank credential, storage credential or policy source
  // is configured. Email setup must work without invoking those dependencies.
  const env = { VERCEL_ENV: 'production', FINANCE_CANONICAL_HOST: 'finance.example.test',
    APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', CRON_SECRET: SECRET,
    ALERTS_SETUP_TEST_ENABLED: 'true', ALERTS_SETUP_TEST_ID: TEST_ID,
    ALERTS_SETUP_TEST_AUTHORIZED_AT: '2030-01-01T14:00:00.000Z',
    RESEND_API_KEY: 'synthetic-private-resend-key', ALERTS_EMAIL_TO: 'owner@example.test',
    ALERTS_EMAIL_FROM: 'Finance <alerts@example.test>', ...overrides };
  const calls = [], financial = [], logs = [];
  const forbidden = name => () => { financial.push(name); throw Error(`Unexpected financial dependency: ${name}`); };
  const app = createApp({ env, now: () => NOW, clientFactory: forbidden('Sequence'), storeFactory: forbidden('Blob'),
    billsReader: forbidden('Bills'), rothReader: forbidden('Roth'), monthlyReader: forbidden('Monthly'),
    readinessReader: forbidden('Activation policy'), alertSenderFactory: forbidden('Critical outbox'),
    emailTestFetch: async (url, options) => { calls.push({ url, ...options }); return fetchImpl ? fetchImpl(url, options) : Response.json({ id: DELIVERY_ID }); },
    log: { error: value => logs.push(value) } });
  const request = (path = '/api/alerts/test', options = {}) => new Request(`https://finance.example.test${path}`, {
    method: 'POST', ...options, headers: { authorization: `Bearer ${SECRET}`, ...options.headers },
  });
  return { app, env, calls, financial, logs, request };
}

test('authorized production setup reaches only Resend and leaves money, ledger, policy and critical outbox untouched', async () => {
  const s = setup(), before = structuredClone(s.env);
  const response = await s.app.fetch(s.request()), body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body)); assert.equal(body.code, 'EMAIL_SETUP_PROVIDER_ACCEPTED');
  assert.equal(body.providerAccepted, true); assert.equal(body.recipientConfirmed, false);
  assert.equal(body.realTransfers, 0); assert.equal(body.financialExecutionEnabled, false);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(s.financial, []); assert.deepEqual(s.logs, []); assert.deepEqual(s.env, before);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  for (const value of [SECRET, s.env.RESEND_API_KEY, s.env.ALERTS_EMAIL_TO, s.env.ALERTS_EMAIL_FROM, TEST_ID]) {
    assert.equal(JSON.stringify(body).includes(value), false);
  }
});

test('Vercel rewrite uses the same authorized, fixed email request and retry identity', async () => {
  const s = setup();
  const first = await (await s.app.fetch(s.request())).json();
  const response = await s.app.fetch(s.request('/api/index?route=alerts/test')), second = await response.json();
  assert.equal(response.status, 202); assert.deepEqual(first, second);
  assert.equal(s.calls[0].body, s.calls[1].body);
  assert.equal(s.calls[0].headers['Idempotency-Key'], s.calls[1].headers['Idempotency-Key']);
  assert.deepEqual(s.financial, []);
});

test('setup route and rewrite require the existing bearer authorization before any dependency', async () => {
  const s = setup();
  for (const path of ['/api/alerts/test', '/api/index?route=alerts/test']) {
    for (const headers of [{}, { authorization: 'Bearer incorrect-secret' }]) {
      const response = await s.app.fetch(new Request(`https://finance.example.test${path}`, { method: 'POST', headers }));
      assert.equal(response.status, 401);
    }
  }
  assert.equal(s.calls.length, 0); assert.deepEqual(s.financial, []);
});

test('GET, HEAD and other methods never send a setup email', async () => {
  const s = setup();
  for (const path of ['/api/alerts/test', '/api/index?route=alerts/test']) {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await s.app.fetch(s.request(path, { method }))).status, 405);
    }
  }
  assert.equal(s.calls.length, 0); assert.deepEqual(s.financial, []);
});

test('only the canonical production HTTPS origin can send, never a preview or stale deployment origin', async () => {
  for (const [overrides, url, code] of [
    [{ VERCEL_ENV: 'preview' }, 'https://finance.example.test/api/alerts/test', 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED'],
    [{ VERCEL_ENV: 'development' }, 'https://finance.example.test/api/alerts/test', 'EMAIL_SETUP_PRODUCTION_REQUIRED'],
    [{}, 'https://old-deployment.example.test/api/alerts/test', 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
    [{}, 'http://finance.example.test/api/alerts/test', 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
    [{}, 'https://finance.example.test:8443/api/alerts/test', 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
    [{ FINANCE_CANONICAL_HOST: undefined }, 'https://finance.example.test/api/alerts/test', 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
  ]) {
    const s = setup(overrides), response = await s.app.fetch(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }));
    assert.equal(response.status, 503); assert.equal((await response.json()).code, code);
    assert.equal(s.calls.length, 0); assert.deepEqual(s.financial, []);
  }
});

test('request bodies and recipient, sender, message, gate or repeated-route query arguments are rejected', async () => {
  const s = setup();
  for (const path of ['/api/alerts/test?to=attacker@example.test', '/api/alerts/test?from=other@example.test',
    '/api/alerts/test?message=custom', '/api/alerts/test?enabled=true', '/api/alerts/test?route=health',
    '/api/index?route=alerts/test&to=attacker@example.test', '/api/index?route=alerts/test&route=alerts/test']) {
    const response = await s.app.fetch(s.request(path));
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'EMAIL_SETUP_DOES_NOT_ACCEPT_ARGUMENTS');
  }
  for (const body of ['{}', '{"recipient":"attacker@example.test"}', '']) {
    assert.equal((await s.app.fetch(s.request('/api/alerts/test', { body }))).status, 400);
  }
  assert.equal(s.calls.length, 0); assert.deepEqual(s.financial, []);
});

test('live money switches, missing setup gate and expired authorization cannot be overridden by an authenticated caller', async () => {
  for (const [overrides, code] of [[{ APP_MODE: 'live' }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    [{ LIVE_TRANSFERS_ENABLED: 'true' }, 'EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF'],
    [{ ALERTS_SETUP_TEST_ENABLED: undefined }, 'EMAIL_SETUP_DISABLED'],
    [{ ALERTS_SETUP_TEST_AUTHORIZED_AT: '2029-12-30T14:00:00.000Z' }, 'EMAIL_SETUP_WINDOW_EXPIRED']]) {
    const s = setup(overrides), response = await s.app.fetch(s.request()), body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.code, code); assert.equal(body.providerAccepted, false);
    assert.equal(body.recipientConfirmed, false); assert.equal(s.calls.length, 0); assert.deepEqual(s.financial, []);
  }
});

test('a lost provider response remains unknown with no automatic retry, proof write or secret disclosure', async () => {
  const s = setup({}, async () => { throw Error('PRIVATE RESPONSE SECRET'); });
  const response = await s.app.fetch(s.request()), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'EMAIL_SETUP_DELIVERY_UNCERTAIN');
  assert.equal(body.status, 'unknown'); assert.equal(body.providerAccepted, null); assert.equal(body.recipientConfirmed, false);
  assert.equal(s.calls.length, 1); assert.deepEqual(s.financial, []);
  assert.doesNotMatch(JSON.stringify([body, s.logs]), /PRIVATE RESPONSE SECRET/);
});
