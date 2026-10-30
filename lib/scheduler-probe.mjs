/** Private outbox intent and health-only delivery receipt for the scheduler.
 * No HTTP, queue client, transfer client, or message sender is constructed here. */
import { VERSION } from './config.mjs';
import { initialState } from './engine.mjs';
import { validateMonthlyState } from './monthly-engine.mjs';
import { createBlobStore } from './store.mjs';

export const SCHEDULER_PROBE_LIFETIME_MS = 5 * 60 * 1000;
export const SCHEDULER_PROBE_COOLDOWN_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEPLOYMENT = /^[A-Za-z0-9_-]{3,160}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const STATUSES = ['pending', 'queued', 'unknown', 'completed'];
const CODES = { pending: 'SCHEDULER_PROBE_PENDING', queued: 'SCHEDULER_PROBE_QUEUED',
  unknown: 'SCHEDULER_PROBE_QUEUE_UNCONFIRMED', completed: 'SCHEDULER_PROBE_COMPLETED' };
const FIELDS = ['schemaVersion', 'id', 'queuedAt', 'expiresAt', 'status', 'softwareVersion', 'publisherDeploymentId',
  'publishedAt', 'completedAt', 'healthStatus', 'deliveryCount', 'code'];
const MESSAGE_FIELDS = ['schemaVersion', 'kind', 'id', 'queuedAt', 'expiresAt'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const iso = value => new Date(value).toISOString();
function isTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
}
function shape(value, fields) {
  return object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
export class SchedulerProbeError extends Error {
  constructor(code, status = 503, retryable = false) {
    super(code); this.name = 'SchedulerProbeError'; this.code = code; this.status = status; this.retryable = retryable;
  }
}
const fail = (code, status, retryable) => { throw new SchedulerProbeError(code, status, retryable); };
function clock(value) {
  const at = typeof value === 'function' ? value() : value;
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) fail('SCHEDULER_PROBE_CLOCK_INVALID');
  return at;
}
export function assertSchedulerProbeEnvironment(env) {
  if (env.VERCEL_ENV !== 'production') fail('SCHEDULER_PROBE_PRODUCTION_REQUIRED');
  if (env.APP_MODE !== 'observe' || env.LIVE_TRANSFERS_ENABLED !== 'false') fail('SCHEDULER_PROBE_MONEY_MUST_BE_OFF', 409);
  if (typeof env.VERCEL_DEPLOYMENT_ID !== 'string' || !DEPLOYMENT.test(env.VERCEL_DEPLOYMENT_ID)) fail('SCHEDULER_PROBE_DEPLOYMENT_REQUIRED');
  return env.VERCEL_DEPLOYMENT_ID;
}
const environment = assertSchedulerProbeEnvironment;
function leaseFree(state, at) {
  if (state.lease && (!Number.isFinite(Date.parse(state.lease.expiresAt)) || Date.parse(state.lease.expiresAt) > at)) {
    fail('DASHBOARD_WORKER_ACTIVE', 409, true);
  }
}
export function validateSchedulerProbe(value) {
  if (value === undefined || value === null) return null;
  if (!shape(value, FIELDS) || value.schemaVersion !== 1 || !UUID.test(value.id ?? '') ||
      !isTime(value.queuedAt) || !isTime(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.queuedAt) !== SCHEDULER_PROBE_LIFETIME_MS ||
      !STATUSES.includes(value.status) || value.code !== CODES[value.status] ||
      typeof value.softwareVersion !== 'string' || !SEMVER.test(value.softwareVersion) ||
      typeof value.publisherDeploymentId !== 'string' || !DEPLOYMENT.test(value.publisherDeploymentId) ||
      value.publishedAt !== null && (!isTime(value.publishedAt) || Date.parse(value.publishedAt) < Date.parse(value.queuedAt)) ||
      value.status === 'queued' && value.publishedAt === null) fail('SCHEDULER_PROBE_STATE_INVALID');
  if (value.status === 'completed') {
    if (!isTime(value.completedAt) || Date.parse(value.completedAt) < Date.parse(value.queuedAt) ||
        Date.parse(value.completedAt) > Date.parse(value.expiresAt) || value.healthStatus !== 200 ||
        !Number.isSafeInteger(value.deliveryCount) || value.deliveryCount < 0 || value.deliveryCount > 1000) fail('SCHEDULER_PROBE_STATE_INVALID');
  } else if (value.completedAt !== null || value.healthStatus !== null || value.deliveryCount !== null) fail('SCHEDULER_PROBE_STATE_INVALID');
  return structuredClone(value);
}
function validateMessage(probe, at) {
  if (!shape(probe, MESSAGE_FIELDS) || probe.schemaVersion !== 1 || probe.kind !== 'probe' || !UUID.test(probe.id ?? '') ||
      !isTime(probe.queuedAt) || !isTime(probe.expiresAt) || Date.parse(probe.expiresAt) - Date.parse(probe.queuedAt) !== SCHEDULER_PROBE_LIFETIME_MS ||
      Date.parse(probe.queuedAt) > at) fail('SCHEDULER_PROBE_MESSAGE_INVALID', 400);
  if (at >= Date.parse(probe.expiresAt)) fail('SCHEDULER_PROBE_EXPIRED', 410);
}
function boundProbe(state, env, probe, at) {
  const deployment = environment(env); validateMessage(probe, at);
  const row = validateSchedulerProbe(state.schedulerProbe);
  if (!row || row.id !== probe.id || row.queuedAt !== probe.queuedAt || row.expiresAt !== probe.expiresAt) fail('SCHEDULER_PROBE_SUPERSEDED', 409);
  if (row.softwareVersion !== VERSION) fail('SCHEDULER_PROBE_VERSION_CHANGED', 409);
  if (row.publisherDeploymentId !== deployment) fail('SCHEDULER_PROBE_DEPLOYMENT_CHANGED', 409);
  return row;
}

/** Save this returned intent by one exact ETag CAS before publishing its fixed
 * message. A failed or ambiguous publish retains this same id and cooldown. */
export function prepareSchedulerProbe({ state, env, now = Date.now(), id }) {
  const at = clock(now), deployment = environment(env);
  if (!UUID.test(id ?? '')) fail('SCHEDULER_PROBE_ID_INVALID', 400);
  leaseFree(state, at);
  const previous = validateSchedulerProbe(state.schedulerProbe);
  if (previous && at < Date.parse(previous.queuedAt) + SCHEDULER_PROBE_COOLDOWN_MS) fail('SCHEDULER_PROBE_COOLDOWN', 429);
  const queuedAt = iso(at), expiresAt = iso(at + SCHEDULER_PROBE_LIFETIME_MS);
  const row = { schemaVersion: 1, id, queuedAt, expiresAt, status: 'pending', softwareVersion: VERSION,
    publisherDeploymentId: deployment, publishedAt: null, completedAt: null, healthStatus: null,
    deliveryCount: null, code: CODES.pending };
  return { state: { ...structuredClone(state), schedulerProbe: row },
    probe: { schemaVersion: 1, kind: 'probe', id, queuedAt, expiresAt } };
}

async function context({ env, store, probe, now }) {
  const at = clock(now); environment(env); validateMessage(probe, at);
  const target = store ?? createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  const record = await target.read();
  const state = validateMonthlyState(structuredClone(record?.value ?? initialState()));
  const row = boundProbe(state, env, probe, at);
  return { at, target, record, state, row, env, probe, now };
}
async function save(context, nextProbe) {
  const { target, record, state } = context, at = clock(context.now);
  // A slow ledger read cannot turn an expired message into fresh proof. Recheck
  // the current clock and lease immediately before the exact conditional write.
  boundProbe(state, context.env, context.probe, at);
  if (nextProbe.status === 'completed') nextProbe = { ...nextProbe, completedAt: iso(at) };
  if (nextProbe.status === 'queued') nextProbe = { ...nextProbe, publishedAt: iso(at) };
  leaseFree(state, at); validateSchedulerProbe(nextProbe);
  try { await target.compareAndSwap(record?.etag ?? null, { ...state, schedulerProbe: nextProbe }); }
  catch (error) {
    if (error.code === 'STORE_CONFLICT' || error.name === 'StoreConflict') fail('SCHEDULER_PROBE_STORE_CONFLICT', 409, true);
    fail('SCHEDULER_PROBE_STORE_UNAVAILABLE', 503, true);
  }
  return { ...state, schedulerProbe: nextProbe };
}

/** An acknowledged enqueue is different from a verified queue delivery. This
 * metadata update preserves all concurrent financial fields by exact CAS. */
export async function recordSchedulerProbePublication({ env, probe, outcome, now = Date.now, store } = {}) {
  if (!['queued', 'unknown'].includes(outcome)) fail('SCHEDULER_PROBE_PUBLICATION_INVALID', 400);
  const ctx = await context({ env, probe, now, store });
  if (ctx.row.status === 'completed' || ctx.row.status === 'queued' && outcome === 'unknown') return ctx.state;
  return save(ctx, { ...ctx.row, status: outcome, code: CODES[outcome],
    publishedAt: outcome === 'queued' ? iso(ctx.at) : ctx.row.publishedAt });
}

/** Called only by the verified private queue consumer after its fixed GET to
 * the canonical health URL. It cannot call a financial endpoint or any HTTP. */
export async function completeSchedulerProbe({ env, probe, now = Date.now, health, delivery, store } = {}) {
  if (!health || health.status !== 200 || health.applicationStatus !== 'ready' || health.softwareVersion !== VERSION ||
      health.mode !== 'observe' || health.liveEnabled !== false) fail('SCHEDULER_PROBE_HEALTH_UNVERIFIED', 409);
  if (!Number.isSafeInteger(delivery?.deliveryCount) || delivery.deliveryCount < 0 || delivery.deliveryCount > 1000) fail('SCHEDULER_PROBE_DELIVERY_INVALID', 400);
  const ctx = await context({ env, probe, now, store });
  if (ctx.row.status === 'completed') return { status: 'completed', completedAt: ctx.row.completedAt, duplicate: true };
  const saved = await save(ctx, { ...ctx.row, status: 'completed', code: CODES.completed, completedAt: iso(ctx.at), healthStatus: 200,
    deliveryCount: delivery.deliveryCount });
  return { status: 'completed', completedAt: saved.schedulerProbe.completedAt, duplicate: false };
}

/** A private deployment id binds proof internally and is never projected. */
export function summarizeSchedulerProbe({ state, env, now = Date.now() } = {}) {
  const empty = { status: 'not_run', queuedAt: null, expiresAt: null, completedAt: null, checkedAt: null,
    softwareVersion: null, code: null, transport: 'vercel-queue', authentication: 'vercel-oidc',
    target: 'health_only', realTransfers: 0, realEmails: 0 };
  let row, at;
  try { at = clock(now); row = validateSchedulerProbe(state?.schedulerProbe); }
  catch { return { ...empty, status: 'unverified', code: 'SCHEDULER_PROBE_STATE_INVALID' }; }
  if (!row) return empty;
  const receipt = { ...empty, status: row.status, queuedAt: row.queuedAt, expiresAt: row.expiresAt,
    completedAt: row.completedAt, checkedAt: row.completedAt, softwareVersion: row.softwareVersion, code: row.code };
  if (row.softwareVersion !== VERSION) return { ...receipt, status: 'unverified', code: 'SCHEDULER_PROBE_VERSION_CHANGED' };
  if (!env?.VERCEL_DEPLOYMENT_ID || row.publisherDeploymentId !== env.VERCEL_DEPLOYMENT_ID) {
    return { ...receipt, status: 'unverified', code: 'SCHEDULER_PROBE_DEPLOYMENT_CHANGED' };
  }
  if (Date.parse(row.queuedAt) > at || row.completedAt && Date.parse(row.completedAt) > at) {
    return { ...receipt, status: 'unverified', code: 'SCHEDULER_PROBE_CLOCK_INVALID' };
  }
  if (row.status !== 'completed' && at >= Date.parse(row.expiresAt)) return { ...receipt, status: 'expired', code: 'SCHEDULER_PROBE_EXPIRED' };
  return receipt;
}
