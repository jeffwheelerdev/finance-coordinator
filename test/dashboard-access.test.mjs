import test from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_COOKIE, DASHBOARD_SESSION_MS, DashboardAccessError, assertDashboardAccess,
  dashboardSession, authorizeDashboardMutation, readDashboardJson, dashboardJson } from '../lib/dashboard-access.mjs';

const NOW = Date.parse('2030-01-01T15:00:00.000Z');
const env = () => ({ VERCEL_ENV: 'production', FINANCE_CANONICAL_HOST: 'finance.example.test',
  DASHBOARD_ENABLED: 'true', DASHBOARD_ACCESS_POLICY: 'vercel-all-deployments', CRON_SECRET: 'synthetic-private-machine-credential' });
const request = (options = {}, path = '/api/dashboard') => new Request(`https://finance.example.test${path}`, options);
const cookie = session => session.setCookie.split(';', 1)[0];
const rejects = (fn, code, status) => assert.throws(fn, error => error instanceof DashboardAccessError && error.code === code && error.status === status);
function mutation(session, overrides = {}) {
  return request({ method: 'POST', body: '{}', ...overrides, headers: { cookie: cookie(session),
    origin: 'https://finance.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    'x-csrf-token': session.csrfToken, ...overrides.headers } }, '/api/dashboard/settings');
}

test('the reviewed platform gate and canonical production origin are mandatory before minting a session', async t => {
  for (const [name, change, code] of [
    ['disabled', { DASHBOARD_ENABLED: 'false' }, 'DASHBOARD_ACCESS_NOT_CONFIGURED'],
    ['unverified policy', { DASHBOARD_ACCESS_POLICY: undefined }, 'DASHBOARD_ACCESS_NOT_CONFIGURED'],
    ['wrong policy', { DASHBOARD_ACCESS_POLICY: 'trust-header' }, 'DASHBOARD_ACCESS_NOT_CONFIGURED'],
    ['preview', { VERCEL_ENV: 'preview' }, 'DASHBOARD_PRODUCTION_REQUIRED'],
    ['local', { VERCEL_ENV: undefined }, 'DASHBOARD_PRODUCTION_REQUIRED'],
    ['missing host', { FINANCE_CANONICAL_HOST: undefined }, 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
    ['wrong host', { FINANCE_CANONICAL_HOST: 'other.example.test' }, 'CANONICAL_PRODUCTION_HOST_REQUIRED'],
    ['missing signer', { CRON_SECRET: undefined }, 'DASHBOARD_SESSION_KEY_REQUIRED'],
  ]) await t.test(name, () => rejects(() => dashboardSession(request(), { env: { ...env(), ...change }, now: NOW, create: true }), code, 503));
  for (const url of ['http://finance.example.test/api/dashboard', 'https://finance.example.test:444/api/dashboard', 'https://finance.example.test.attacker.test/api/dashboard']) {
    rejects(() => dashboardSession(new Request(url), { env: env(), now: NOW, create: true }), 'CANONICAL_PRODUCTION_HOST_REQUIRED', 503);
  }
});

test('sessions contain fresh scoped randomness and a distinct CSRF token, never the machine credential', () => {
  const a = dashboardSession(request(), { env: env(), now: NOW, create: true });
  const b = dashboardSession(request(), { env: env(), now: NOW, create: true });
  assert.notEqual(cookie(a), cookie(b)); assert.notEqual(a.csrfToken, b.csrfToken);
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=1800']) assert.ok(a.setCookie.includes(attribute));
  assert.ok(a.setCookie.startsWith(`${DASHBOARD_COOKIE}=`)); assert.equal(a.setCookie.includes('Domain='), false);
  assert.equal(JSON.stringify(a).includes(env().CRON_SECRET), false);
  const existing = dashboardSession(request({ headers: { cookie: cookie(a) } }), { env: env(), now: NOW + 1000, create: true });
  assert.equal(existing.csrfToken, a.csrfToken); assert.equal(existing.setCookie, undefined);
});

test('cookie signature tampering, duplicate cookies and rotated signing key fail closed', () => {
  const session = dashboardSession(request(), { env: env(), now: NOW, create: true });
  const original = cookie(session), changed = `${original.slice(0, -1)}${original.endsWith('A') ? 'B' : 'A'}`;
  for (const value of [changed, `${original}; ${original}`, `${DASHBOARD_COOKIE}=forged`, `${DASHBOARD_COOKIE}=`]) {
    rejects(() => dashboardSession(request({ headers: { cookie: value } }), { env: env(), now: NOW }), 'DASHBOARD_SESSION_INVALID', 401);
  }
  rejects(() => dashboardSession(request({ headers: { cookie: original } }), { env: { ...env(), CRON_SECRET: 'rotated-synthetic-machine-credential' }, now: NOW }), 'DASHBOARD_SESSION_INVALID', 401);
});

test('session expiry rejects writes; only a new overview GET can mint a replacement', () => {
  const session = dashboardSession(request(), { env: env(), now: NOW, create: true });
  rejects(() => authorizeDashboardMutation(mutation(session), { env: env(), now: NOW + DASHBOARD_SESSION_MS }), 'DASHBOARD_SESSION_EXPIRED', 401);
  const replacement = dashboardSession(request({ headers: { cookie: cookie(session) } }), { env: env(), now: NOW + DASHBOARD_SESSION_MS, create: true });
  assert.ok(replacement.setCookie); assert.notEqual(replacement.csrfToken, session.csrfToken);
  rejects(() => dashboardSession(mutation(session), { env: env(), now: NOW, create: true }), 'METHOD_NOT_ALLOWED', 405);
  rejects(() => dashboardSession(request({ headers: { cookie: cookie(session) } }), { env: env(), now: NOW - 1 }), 'DASHBOARD_SESSION_EXPIRED', 401);
});

test('session and CSRF proof are bound to the exact canonical origin', () => {
  const session = dashboardSession(request(), { env: env(), now: NOW, create: true });
  const other = new Request('https://other.example.test/api/dashboard', { headers: { cookie: cookie(session) } });
  rejects(() => dashboardSession(other, { env: { ...env(), FINANCE_CANONICAL_HOST: 'other.example.test' }, now: NOW }), 'DASHBOARD_SESSION_INVALID', 401);
  rejects(() => assertDashboardAccess(request({ headers: { origin: 'https://attacker.test' } }), env()), 'DASHBOARD_SAME_ORIGIN_REQUIRED', 403);
  rejects(() => assertDashboardAccess(request({ headers: { 'sec-fetch-site': 'same-site' } }), env()), 'DASHBOARD_SAME_ORIGIN_REQUIRED', 403);
});

test('every mutation requires exact Origin, matching cookie and CSRF, POST and JSON', () => {
  const session = dashboardSession(request(), { env: env(), now: NOW, create: true });
  assert.equal(authorizeDashboardMutation(mutation(session), { env: env(), now: NOW }).csrfToken, session.csrfToken);
  for (const [headers, code, status] of [
    [{ origin: '' }, 'DASHBOARD_SAME_ORIGIN_REQUIRED', 403],
    [{ origin: 'https://attacker.test' }, 'DASHBOARD_SAME_ORIGIN_REQUIRED', 403],
    [{ 'sec-fetch-site': 'cross-site' }, 'DASHBOARD_SAME_ORIGIN_REQUIRED', 403],
    [{ cookie: '' }, 'DASHBOARD_SESSION_REQUIRED', 401],
    [{ 'x-csrf-token': 'forged' }, 'DASHBOARD_CSRF_INVALID', 403],
    [{ 'content-type': 'text/plain' }, 'DASHBOARD_JSON_REQUIRED', 415],
  ]) rejects(() => authorizeDashboardMutation(mutation(session, { headers }), { env: env(), now: NOW }), code, status);
  rejects(() => authorizeDashboardMutation(request(), { env: env(), now: NOW }), 'METHOD_NOT_ALLOWED', 405);
});

test('JSON parsing enforces actual streamed bytes, object shape and valid UTF-8', async () => {
  assert.deepEqual(await readDashboardJson(request({ method: 'POST', body: '{"changes":{}}' })), { changes: {} });
  for (const body of ['null', '[]', '1', 'bad', '{} trailing']) {
    await assert.rejects(readDashboardJson(request({ method: 'POST', body })), { code: 'DASHBOARD_REQUEST_INVALID' });
  }
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); controller.close(); } });
  await assert.rejects(readDashboardJson(request({ method: 'POST', body: huge, duplex: 'half' })), { code: 'DASHBOARD_REQUEST_TOO_LARGE' });
  await assert.rejects(readDashboardJson(request({ method: 'POST', body: '{}', headers: { 'content-length': '999999' } })), { code: 'DASHBOARD_REQUEST_TOO_LARGE' });
  await assert.rejects(readDashboardJson(request({ method: 'POST', body: new Uint8Array([255, 254]) })), { code: 'DASHBOARD_REQUEST_INVALID' });
});

test('a stalled request body is cancelled within its bounded read window', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readDashboardJson(request({ method: 'POST', body, duplex: 'half' }), { timeoutMs: 1 }),
    { code: 'DASHBOARD_REQUEST_TIMEOUT', status: 408 });
  assert.equal(cancelled, true);
});

test('dashboard responses cannot be cached, framed or read by another origin and do not serialize the cookie', async () => {
  const session = dashboardSession(request(), { env: env(), now: NOW, create: true });
  const response = dashboardJson({ csrfToken: session.csrfToken, status: 'ready' }, { session });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.text(); assert.equal(body.includes(cookie(session)), false); assert.equal(body.includes(env().CRON_SECRET), false);
});
