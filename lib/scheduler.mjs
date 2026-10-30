/** Durable wake messages contain no financial instructions. All money decisions
 * remain in the current canonical coordinator and its immutable CAS ledger. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { VERSION } from './config.mjs';
import { nextMonthlySlot } from './dashboard-controls.mjs';
import { monthlyClock, monthlySlot } from './monthly-schedule.mjs';

export const SCHEDULER_TOPIC = 'finance-coordinator-wakes-v1';
export const SCHEDULER_REGION = 'iad1';
export const MAX_SCHEDULER_WAKES = 13;
export const MAX_SCHEDULER_DELIVERIES = 3;
const HOUR = 3_600_000;
const MAX_JSON_BYTES = 64 * 1024;
const RUN_STATUSES = ['busy', 'blocked', 'review', 'waiting', 'observe', 'uncertain', 'pending', 'complete'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();

export class SchedulerError extends Error {
  constructor(code, { permanent = false } = {}) { super(code); this.name = 'SchedulerError'; this.code = code; this.permanent = permanent; }
}
const fail = (code, permanent = true) => { throw new SchedulerError(code, { permanent }); };
const safeCode = error => error instanceof SchedulerError ? error.code : 'SCHEDULER_UNAVAILABLE';
const atTime = now => { const at = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(at) || at < Date.UTC(2000, 0, 1) || at >= Date.UTC(9999, 0, 1)) fail('SCHEDULER_TIME_INVALID'); return at; };
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
function shape(value, keys) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('SCHEDULER_MESSAGE_INVALID');
}
function production(env) {
  if (env?.VERCEL_ENV !== 'production') fail('SCHEDULER_PRODUCTION_REQUIRED');
}
const validHost = host => typeof host === 'string' && host.length <= 253 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host);
function canonical(env) {
  production(env);
  const host = env.FINANCE_CANONICAL_HOST;
  if (!validHost(host)) fail('SCHEDULER_CANONICAL_HOST_INVALID');
  if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 16 || env.CRON_SECRET.length > 512 || /[\r\n]/.test(env.CRON_SECRET)) fail('SCHEDULER_AUTH_REQUIRED');
  return `https://${host}`;
}
function authorized(request, env) {
  if (typeof env?.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 16) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(`Bearer ${env.CRON_SECRET}`));
}
function executionDate(slot) { return `${slot.monthKey}-${String(slot.dayOfMonth).padStart(2, '0')}`; }
function dateSlot(date) {
  if (typeof date !== 'string' || !/^(?:[2-9]\d{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d)$/.test(date)) fail('SCHEDULER_MESSAGE_INVALID');
  const day = Number(date.slice(8)), december = date.slice(5, 7) === '12';
  if (day > (december ? 15 : 28)) fail('SCHEDULER_MESSAGE_INVALID');
  try { return monthlySlot(date.slice(0, 7), { executionDay: day, decemberDay: december ? day : 1 }); }
  catch { fail('SCHEDULER_MESSAGE_INVALID'); }
}

export function parseSchedulerMessage(value) {
  if (value?.kind === 'probe') {
    shape(value, ['schemaVersion', 'kind', 'id', 'queuedAt', 'expiresAt']);
    if (value.schemaVersion !== 1 || !UUID.test(value.id ?? '') || !stamp(value.queuedAt) || !stamp(value.expiresAt) ||
        Date.parse(value.expiresAt) - Date.parse(value.queuedAt) !== 300_000) fail('SCHEDULER_MESSAGE_INVALID');
    return { schemaVersion: 1, kind: 'probe', id: value.id, queuedAt: value.queuedAt, expiresAt: value.expiresAt };
  }
  shape(value, ['schemaVersion', 'kind', 'date', 'wakeAt', 'expiresAt']);
  if (value.schemaVersion !== 1 || value.kind !== 'wake' || !stamp(value.wakeAt) || !stamp(value.expiresAt)) fail('SCHEDULER_MESSAGE_INVALID');
  const slot = dateSlot(value.date), wake = Date.parse(value.wakeAt);
  if (value.expiresAt !== slot.closesAt || wake % HOUR !== 0 || wake <= Date.parse(slot.dueAt) || wake >= Date.parse(slot.closesAt)) fail('SCHEDULER_MESSAGE_INVALID');
  return { schemaVersion: 1, kind: 'wake', date: value.date, wakeAt: value.wakeAt, expiresAt: value.expiresAt };
}

/** Shared slot selection honors future settings, frozen plans and activation.
 * No delayed messages are needed outside the current monthly execution window. */
export function planSchedulerWakes({ config, state = {}, now = Date.now() } = {}) {
  const at = atTime(now);
  if (config?.monthly?.enabled !== true) fail('SCHEDULER_MONTHLY_REQUIRED');
  let slot;
  try { slot = nextMonthlySlot({ config, state: state ?? {}, now: at }); }
  catch { fail('SCHEDULER_SAVED_SCHEDULE_INVALID'); }
  const opens = Date.parse(slot.dueAt), closes = Date.parse(slot.closesAt);
  const activeWindow = at >= opens && at < closes;
  const messages = [];
  if (activeWindow) {
    for (let wake = (Math.floor(at / HOUR) + 1) * HOUR; wake < closes; wake += HOUR) {
      messages.push(parseSchedulerMessage({ schemaVersion: 1, kind: 'wake', date: executionDate(slot), wakeAt: iso(wake), expiresAt: slot.closesAt }));
    }
  }
  if (messages.length > MAX_SCHEDULER_WAKES) fail('SCHEDULER_WAKE_LIMIT');
  return { date: executionDate(slot), activeWindow, dueAt: slot.dueAt, closesAt: slot.closesAt, messages };
}

async function timed(operation, milliseconds, code) {
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SchedulerError(code)); }, milliseconds); });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}
async function jsonBody(response) {
  if (!/^application\/json(?:;|$)/i.test(response?.headers?.get('content-type') ?? '') || !response.body?.getReader) fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false);
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array)) fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false);
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) { void reader.cancel().catch(() => {}); fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false); }
      text += decoder.decode(value, { stream: true });
    }
    const result = JSON.parse(text + decoder.decode());
    if (!record(result)) fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false);
    return result;
  } catch { fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false); }
  finally { reader.releaseLock(); }
}
async function runtimeOidc() { const { getVercelOidcToken } = await import('@vercel/oidc'); return getVercelOidcToken(); }
async function runtimeQueue() {
  const { QueueClient } = await import('@vercel/queue');
  return new QueueClient({ region: SCHEDULER_REGION, telemetry: { isEnabled: false } });
}
async function sendBatch(topic, messages) { return (await runtimeQueue()).sendBatch(topic, messages); }
async function sendOne(topic, payload, options) { return (await runtimeQueue()).send(topic, payload, options); }

/** No caller URL or headers are accepted. A pinned older deployment can only
 * wake the currently routed canonical coordinator, which rechecks live gates. */
export async function invokeCanonical({ env, purpose = 'reconcile', expiresAt, now = () => Date.now(), fetchImpl = fetch,
  getOidcToken = runtimeOidc } = {}) {
  const origin = canonical(env);
  if (!['reconcile', 'probe'].includes(purpose)) fail('SCHEDULER_PURPOSE_INVALID');
  const expiry = expiresAt === undefined ? atTime(now) + 180_000 : stamp(expiresAt) ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= atTime(now)) fail('SCHEDULER_WINDOW_CLOSED');
  let token;
  try { token = await timed(() => getOidcToken(), Math.min(10_000, expiry - atTime(now)), 'SCHEDULER_OIDC_TIMEOUT'); }
  catch { fail('SCHEDULER_OIDC_UNAVAILABLE', false); }
  if (typeof token !== 'string' || !token || token.length > 16_384 || /[\r\n]/.test(token)) fail('SCHEDULER_OIDC_UNAVAILABLE', false);
  const remaining = expiry - atTime(now);
  if (remaining <= 0) fail('SCHEDULER_WINDOW_CLOSED');
  const path = purpose === 'probe' ? '/api/health' : '/api/reconcile';
  try {
    return await timed(async signal => {
      // This second guard matters when obtaining runtime identity crossed midnight.
      if (atTime(now) >= expiry) fail('SCHEDULER_WINDOW_CLOSED');
      const response = await fetchImpl(`${origin}${path}`, { method: purpose === 'probe' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'x-vercel-trusted-oidc-idp-token': token, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal });
      if (response.status !== 200) { void response.body?.cancel?.().catch(() => {}); fail('SCHEDULER_CANONICAL_HTTP_ERROR', false); }
      const body = await jsonBody(response);
      if (purpose === 'probe') {
        if (body.status !== 'ready' || body.version !== VERSION || body.mode !== 'observe' || body.liveEnabled !== false) fail('SCHEDULER_PROBE_HEALTH_INVALID');
        return { status: 200, applicationStatus: 'ready', softwareVersion: VERSION, mode: 'observe', liveEnabled: false };
      }
      if (!RUN_STATUSES.includes(body.status) || typeof body.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(body.code)) fail('SCHEDULER_CANONICAL_RESPONSE_INVALID', false);
      if (body.status === 'busy') fail('SCHEDULER_COORDINATOR_BUSY', false);
      return { status: body.status, code: body.code };
    }, Math.min(purpose === 'probe' ? 15_000 : 180_000, remaining), 'SCHEDULER_CANONICAL_TIMEOUT');
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    fail('SCHEDULER_CANONICAL_UNAVAILABLE', false);
  }
}

export async function publishSchedulerProbe({ env = process.env, probe, sendImpl = sendOne, now = () => Date.now() } = {}) {
  production(env);
  if (env.APP_MODE !== 'observe' || env.LIVE_TRANSFERS_ENABLED !== 'false') fail('SCHEDULER_PROBE_OBSERVE_REQUIRED');
  const message = parseSchedulerMessage(probe), at = atTime(now);
  if (message.kind !== 'probe' || Date.parse(message.queuedAt) > at || Date.parse(message.expiresAt) - at <= 60_000) fail('SCHEDULER_PROBE_EXPIRED');
  const options = { delaySeconds: 60, retentionSeconds: Math.floor((Date.parse(message.expiresAt) - at) / 1000),
    idempotencyKey: `finance-probe-v1:${message.id}` };
  try {
    const result = await timed(() => sendImpl(SCHEDULER_TOPIC, message, options), 15_000, 'SCHEDULER_PUBLISH_TIMEOUT');
    if (!record(result) || result.messageId !== null && typeof result.messageId !== 'string') fail('SCHEDULER_PUBLISH_RESPONSE_INVALID', false);
    return { status: 'queued', deliveryConfirmed: false, expiresAt: message.expiresAt };
  } catch (error) { throw new SchedulerError(safeCode(error) === 'SCHEDULER_UNAVAILABLE' ? 'SCHEDULER_PROBE_PUBLISH_UNCERTAIN' : safeCode(error)); }
}

async function completeProbe(args) { const { completeSchedulerProbe } = await import('./scheduler-probe.mjs'); return completeSchedulerProbe(args); }

export async function consumeSchedulerMessage(value, metadata, { env = process.env, now = () => Date.now(),
  fetchImpl = fetch, getOidcToken = runtimeOidc, completeProbeImpl = completeProbe } = {}) {
  production(env);
  const message = parseSchedulerMessage(value);
  if (metadata?.topicName !== SCHEDULER_TOPIC || !Number.isSafeInteger(metadata.deliveryCount) || metadata.deliveryCount < 1) fail('SCHEDULER_DELIVERY_INVALID');
  if (metadata.deliveryCount > MAX_SCHEDULER_DELIVERIES) return { status: 'skipped', code: 'SCHEDULER_DELIVERY_LIMIT' };
  const at = atTime(now), expiry = Date.parse(message.expiresAt);
  if (at >= expiry) return { status: 'skipped', code: 'SCHEDULER_WINDOW_CLOSED' };
  if (message.kind === 'probe') {
    if (at < Date.parse(message.queuedAt)) fail('SCHEDULER_PROBE_EARLY', false);
    const health = await invokeCanonical({ env, purpose: 'probe', expiresAt: message.expiresAt, now, fetchImpl, getOidcToken });
    try { await completeProbeImpl({ env, probe: message, now, health, delivery: { deliveryCount: metadata.deliveryCount } }); }
    catch { fail('SCHEDULER_PROBE_RECEIPT_FAILED', false); }
    return { status: 'complete', code: 'SCHEDULER_PROBE_DELIVERED', financialExecutionRequested: false };
  }
  if (at < Date.parse(message.wakeAt)) fail('SCHEDULER_WAKE_EARLY', false);
  const clock = monthlyClock(at);
  if (`${clock.monthKey}-${String(clock.day).padStart(2, '0')}` !== message.date) return { status: 'skipped', code: 'SCHEDULER_WINDOW_CLOSED' };
  const result = await invokeCanonical({ env, expiresAt: message.expiresAt, now, fetchImpl, getOidcToken });
  return { status: 'invoked', code: 'SCHEDULER_COORDINATOR_INVOKED', coordinator: result };
}

export function schedulerRetry(error, metadata, now = Date.now()) {
  const expires = metadata?.expiresAt instanceof Date ? metadata.expiresAt.getTime() : Date.parse(metadata?.expiresAt ?? '');
  if (error?.permanent === true || !Number.isSafeInteger(metadata?.deliveryCount) || metadata.deliveryCount >= MAX_SCHEDULER_DELIVERIES ||
      Number.isFinite(expires) && expires <= atTime(now)) return { acknowledge: true };
  return { afterSeconds: 300 };
}

async function runtimeContext(env) {
  const [{ loadConfig }, { createBlobStore }, { validateMonthlyState }, { initialState }] = await Promise.all([
    import('./config.mjs'), import('./store.mjs'), import('./monthly-engine.mjs'), import('./engine.mjs'),
  ]);
  const config = loadConfig(env), store = createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  return { config, state: validateMonthlyState((await store.read())?.value ?? initialState()) };
}
const response = (value, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });

export function createSchedulerApp({ env = process.env, now = () => Date.now(), readContext = runtimeContext,
  sendBatchImpl = sendBatch, fetchImpl = fetch, getOidcToken = runtimeOidc, log = console } = {}) {
  return { async fetch(request) {
    if (request.method !== 'GET') return response({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (!authorized(request, env)) return response({ code: 'UNAUTHORIZED' }, 401);
    try {
      const url = new URL(request.url), origin = canonical(env);
      // Cron's documented target is the production deployment URL. Accept only
      // this exact platform-provided hostname or the canonical alias; all
      // outgoing requests still use the current canonical coordinator.
      const incomingOrigins = [origin, ...(validHost(env.VERCEL_URL) ? [`https://${env.VERCEL_URL}`] : [])];
      if (!incomingOrigins.includes(url.origin) || url.pathname !== '/api/scheduler' || url.search || request.body) fail('SCHEDULER_REQUEST_INVALID');
      let context;
      try { context = await readContext(env); }
      catch { fail('SCHEDULER_SAVED_STATE_UNAVAILABLE', false); }
      const plan = planSchedulerWakes({ ...context, now: atTime(now) });
      let queuedCount = 0, publishCode = null;
      if (plan.messages.length) {
        const at = atTime(now), batch = plan.messages.filter(message => Date.parse(message.wakeAt) > at)
          .map(payload => ({ payload, delaySeconds: Math.ceil((Date.parse(payload.wakeAt) - at) / 1000),
            retentionSeconds: Math.floor((Date.parse(payload.expiresAt) - at) / 1000),
            idempotencyKey: `finance-wake-v1:${payload.date}:${payload.wakeAt}` }));
        if (batch.length) {
          try {
            const results = await timed(() => sendBatchImpl(SCHEDULER_TOPIC, batch), 20_000, 'SCHEDULER_PUBLISH_TIMEOUT');
            if (!Array.isArray(results) || results.length !== batch.length) fail('SCHEDULER_PUBLISH_RESPONSE_INVALID', false);
            for (const result of results) {
              if (result?.status === 'sent' && typeof result.messageId === 'string' || result?.status === 'deferred' && result.messageId === null) queuedCount += 1;
              else publishCode = 'SCHEDULER_QUEUE_PUBLISH_INCOMPLETE';
            }
          } catch { publishCode = 'SCHEDULER_QUEUE_PUBLISH_UNCERTAIN'; }
        }
      }
      // Every daily invocation still monitors settlements, including other days.
      // The immediate call does not enqueue again, and partial publish is visible.
      const coordinator = await invokeCanonical({ env, now, fetchImpl, getOidcToken,
        ...(plan.activeWindow ? { expiresAt: plan.closesAt } : {}) });
      if (publishCode) log.error(JSON.stringify({ component: 'finance-scheduler', status: 'partial', code: publishCode }));
      return response({ status: publishCode ? 'partial' : 'complete', code: publishCode ?? 'SCHEDULER_DAILY_COMPLETED',
        delayedWakeCount: queuedCount, requestedWakeCount: plan.messages.length, deliveryConfirmed: false, coordinator }, publishCode ? 503 : 200);
    } catch (error) {
      const code = safeCode(error);
      log.error(JSON.stringify({ component: 'finance-scheduler', status: 'blocked', code }));
      return response({ status: 'blocked', code }, 503);
    }
  } };
}
