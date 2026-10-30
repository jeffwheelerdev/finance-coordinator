/** Dashboard request integrity behind reviewed Vercel All Deployments access.
 * This is not an identity provider: the deployment perimeter authenticates the
 * owner. These scoped cookies never authorize financial or email endpoints. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DASHBOARD_COOKIE = '__Host-finance-dashboard';
export const DASHBOARD_SESSION_MS = 30 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT = value => value && typeof value === 'object' && !Array.isArray(value);

export class DashboardAccessError extends Error {
  constructor(code, status = 403) { super(code); this.name = 'DashboardAccessError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new DashboardAccessError(code, status); };

export function assertDashboardAccess(request, env) {
  if (env.DASHBOARD_ENABLED !== 'true' || env.DASHBOARD_ACCESS_POLICY !== 'vercel-all-deployments') {
    fail('DASHBOARD_ACCESS_NOT_CONFIGURED', 503);
  }
  if (env.VERCEL_ENV !== 'production') fail('DASHBOARD_PRODUCTION_REQUIRED', 503);
  const url = new URL(request.url), origin = `https://${env.FINANCE_CANONICAL_HOST ?? ''}`;
  if (!env.FINANCE_CANONICAL_HOST || url.origin !== origin) fail('CANONICAL_PRODUCTION_HOST_REQUIRED', 503);
  if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 16 || env.CRON_SECRET.length > 4096 || /[\r\n]/.test(env.CRON_SECRET)) {
    fail('DASHBOARD_SESSION_KEY_REQUIRED', 503);
  }
  // Cross-origin browser reads should not reveal private data even when an
  // authenticated perimeter cookie happens to accompany the request.
  const suppliedOrigin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  if (suppliedOrigin && suppliedOrigin !== origin || site && !['same-origin', 'none'].includes(site)) {
    fail('DASHBOARD_SAME_ORIGIN_REQUIRED');
  }
  return origin;
}

function key(env, purpose) { return createHmac('sha256', env.CRON_SECRET).update(`finance-dashboard/${purpose}/v1`).digest(); }
function sign(payload, origin, env, purpose) {
  return createHmac('sha256', key(env, purpose)).update(`${origin}\n${payload}`).digest('base64url');
}
function equal(a, b) {
  return typeof a === 'string' && TOKEN.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cookieValue(request) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  if (cookie.length > 16384) fail('DASHBOARD_SESSION_INVALID', 401);
  const values = cookie.split(';').map(part => part.trim()).filter(part => part.split('=', 1)[0] === DASHBOARD_COOKIE);
  if (values.length > 1) fail('DASHBOARD_SESSION_INVALID', 401);
  return values.length ? values[0].slice(DASHBOARD_COOKIE.length + 1) : null;
}
function readSession(request, env, now, origin) {
  const value = cookieValue(request);
  if (value === null) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || parts[0].length > 400 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !equal(parts[1], sign(parts[0], origin, env, 'session'))) {
    fail('DASHBOARD_SESSION_INVALID', 401);
  }
  let row;
  try { row = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { fail('DASHBOARD_SESSION_INVALID', 401); }
  if (!OBJECT(row) || Object.keys(row).sort().join(',') !== 'expiresAt,issuedAt,nonce,version' || row.version !== 1 || typeof row.nonce !== 'string' || !TOKEN.test(row.nonce) ||
      !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt - row.issuedAt !== DASHBOARD_SESSION_MS ||
      row.issuedAt > now || row.expiresAt <= now) fail('DASHBOARD_SESSION_EXPIRED', 401);
  return { csrfToken: sign(parts[0], origin, env, 'csrf'), expiresAt: new Date(row.expiresAt).toISOString() };
}

/** A session is minted only by the private overview GET. The browser receives
 * its CSRF token, never the signing key or the HttpOnly cookie value. */
export function dashboardSession(request, { env, now = Date.now(), create = false } = {}) {
  const origin = assertDashboardAccess(request, env);
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) fail('DASHBOARD_CLOCK_INVALID', 503);
  if (request.method !== 'GET' && create) fail('METHOD_NOT_ALLOWED', 405);
  let existing;
  try { existing = readSession(request, env, now, origin); }
  catch (error) {
    if (!create || !(error instanceof DashboardAccessError) || error.code !== 'DASHBOARD_SESSION_EXPIRED') throw error;
  }
  if (existing) return existing;
  if (!create) fail('DASHBOARD_SESSION_REQUIRED', 401);
  if (!Number.isFinite(new Date(now + DASHBOARD_SESSION_MS).getTime())) fail('DASHBOARD_CLOCK_INVALID', 503);
  const row = { version: 1, nonce: randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + DASHBOARD_SESSION_MS };
  const payload = Buffer.from(JSON.stringify(row)).toString('base64url'), value = `${payload}.${sign(payload, origin, env, 'session')}`;
  return { csrfToken: sign(payload, origin, env, 'csrf'), expiresAt: new Date(row.expiresAt).toISOString(),
    setCookie: `${DASHBOARD_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DASHBOARD_SESSION_MS / 1000}` };
}

export function authorizeDashboardMutation(request, { env, now = Date.now() } = {}) {
  if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
  const origin = assertDashboardAccess(request, env);
  if (request.headers.get('origin') !== origin || request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin') {
    fail('DASHBOARD_SAME_ORIGIN_REQUIRED');
  }
  const session = dashboardSession(request, { env, now });
  if (!equal(request.headers.get('x-csrf-token'), session.csrfToken)) fail('DASHBOARD_CSRF_INVALID');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    fail('DASHBOARD_JSON_REQUIRED', 415);
  }
  return session;
}

/** Bounded JSON parser, including chunked bodies. Error output never includes
 * submitted values, private source errors, or secret-bearing request headers. */
export async function readDashboardJson(request, { maxBytes = 16384, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 65536 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) fail('DASHBOARD_REQUEST_LIMIT_INVALID', 503);
  const contentLength = request.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    void request.body?.cancel().catch(() => {}); fail('DASHBOARD_REQUEST_TOO_LARGE', 413);
  }
  if (!request.body) fail('DASHBOARD_JSON_REQUIRED', 400);
  let text = '', bytes = 0;
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const operation = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { void reader.cancel().catch(() => {}); fail('DASHBOARD_REQUEST_TOO_LARGE', 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const value = JSON.parse(text);
      if (!OBJECT(value)) fail('DASHBOARD_REQUEST_INVALID', 400);
      return value;
    } catch (error) {
      if (error instanceof DashboardAccessError) throw error;
      fail('DASHBOARD_REQUEST_INVALID', 400);
    } finally { reader.releaseLock(); }
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new DashboardAccessError('DASHBOARD_REQUEST_TIMEOUT', 408));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

export function dashboardJson(value, { status = 200, session } = {}) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Vary': 'Cookie, Origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
  if (session?.setCookie) headers['Set-Cookie'] = session.setCookie;
  return Response.json(value, { status, headers });
}
