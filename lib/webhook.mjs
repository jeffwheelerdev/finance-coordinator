import { createHmac, timingSafeEqual } from 'node:crypto';
import { initialState, validateState, EngineError } from './engine.mjs';
import { validTime } from './evidence.mjs';

const MAX_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Map([['transfer.changed', 'transfer'], ['external_transaction.changed', 'external_transaction'], ['card_transaction.changed', 'card_transaction']]);

export class WebhookError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'WebhookError'; this.code = code; this.status = status; }
}

export async function verifiedWebhook(request, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 16) throw new WebhookError('WEBHOOK_NOT_CONFIGURED', 503);
  if (request.method !== 'POST') throw new WebhookError('METHOD_NOT_ALLOWED', 405);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw new WebhookError('JSON_REQUIRED', 415);
  const header = request.headers.get('x-sequence-signature') ?? '';
  if (header.length > 1000) throw new WebhookError('INVALID_SIGNATURE', 401);
  const parts = header.split(',').map((s) => s.trim());
  const timestamps = parts.filter((s) => /^t=\d+$/.test(s));
  const signatures = parts.filter((s) => /^v1=[a-f0-9]{64}$/i.test(s)).map((s) => s.slice(3));
  if (timestamps.length !== 1 || signatures.length < 1 || signatures.length > 5) throw new WebhookError('INVALID_SIGNATURE', 401);
  const timestamp = timestamps[0].slice(2);
  if (!Number.isSafeInteger(Number(timestamp)) || Math.abs(now - Number(timestamp) * 1000) > 300_000) throw new WebhookError('SIGNATURE_EXPIRED', 401);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BYTES) throw new WebhookError('BODY_TOO_LARGE', 413);
  const chunks = [];
  let size = 0;
  if (!request.body) throw new WebhookError('INVALID_BODY');
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new WebhookError('BODY_TOO_LARGE', 413); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks);
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  if (!signatures.some((value) => timingSafeEqual(expected, Buffer.from(value, 'hex')))) throw new WebhookError('INVALID_SIGNATURE', 401);
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw new WebhookError('INVALID_BODY'); }
  if (!event || !UUID.test(event.id ?? '') || request.headers.get('x-sequence-event-id') !== event.id ||
      !TYPES.has(event.type) || TYPES.get(event.type) !== event.resource?.type || !UUID.test(event.resource?.id ?? '') ||
      typeof event.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.created_at) ||
      !Number.isFinite(Date.parse(event.created_at)) || Date.parse(event.created_at) > now + 300_000) {
    throw new WebhookError('INVALID_EVENT');
  }
  try { validTime(event.created_at, now + 300_000); } catch { throw new WebhookError('INVALID_EVENT'); }
  // Retain only the documented identity envelope. Never treat the payload as a balance.
  return { id: event.id, type: event.type, resource: { type: event.resource.type, id: event.resource.id }, created_at: event.created_at };
}

/** Acknowledge only after durable receipt. A busy ledger makes Sequence retry. */
export async function recordWebhook(store, event, now = Date.now()) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await store.read();
    const state = validateState(structuredClone(record?.value ?? initialState()));
    const prior = state.inbox[event.id];
    if (prior) {
      if (JSON.stringify(prior.event) !== JSON.stringify(event)) throw new WebhookError('EVENT_ID_REUSED', 409);
      return { duplicate: true };
    }
    if (state.lease && Date.parse(state.lease.expiresAt) > now) throw new WebhookError('LEDGER_BUSY', 503);
    // Inbox dedup is only an optimization. Permanent refund/intent identities are
    // kept in events and are never pruned here.
    for (const [id, entry] of Object.entries(state.inbox)) {
      if (Date.parse(entry.receivedAt) < now - 48 * 3600_000) delete state.inbox[id];
    }
    if (Object.keys(state.inbox).length >= 1000) throw new WebhookError('WEBHOOK_INBOX_FULL', 503);
    state.inbox[event.id] = { event, receivedAt: new Date(now).toISOString() };
    try { await store.compareAndSwap(record?.etag ?? null, state); return { duplicate: false }; }
    catch (error) {
      if (error.code !== 'STORE_CONFLICT' && error.name !== 'StoreConflict') throw error;
    }
  }
  throw new EngineError('STORE_CONFLICT');
}
