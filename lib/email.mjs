/** An explicitly authorized, email-only setup check. This module has no
 * financial client, ledger, policy writer, scheduler, or activation switch. */
import { createHash } from 'node:crypto';
import { summarizeAlertDelivery } from './alerts.mjs';

export const EMAIL_SETUP_WINDOW_MS = 23 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 10000;
const hash = value => createHash('sha256').update(value).digest('hex');

export class EmailSetupError extends Error {
  constructor(code, { uncertain = false } = {}) {
    super(code); this.name = 'EmailSetupError'; this.code = code; this.uncertain = uncertain;
  }
}
const fail = (code, options) => { throw new EmailSetupError(code, options); };

function authorizationTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail('EMAIL_SETUP_AUTHORIZATION_INVALID');
  }
  return Date.parse(value);
}

function setupRequest(env, at) {
  if (env.VERCEL_ENV !== 'production') fail('EMAIL_SETUP_PRODUCTION_REQUIRED');
  if (env.APP_MODE !== 'observe' || env.LIVE_TRANSFERS_ENABLED !== 'false') fail('EMAIL_SETUP_REQUIRES_FINANCIAL_GATES_OFF');
  if (env.ALERTS_SETUP_TEST_ENABLED !== 'true') fail('EMAIL_SETUP_DISABLED');
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()) || !UUID_V4.test(env.ALERTS_SETUP_TEST_ID ?? '')) {
    fail('EMAIL_SETUP_AUTHORIZATION_INVALID');
  }
  const authorizedAt = authorizationTime(env.ALERTS_SETUP_TEST_AUTHORIZED_AT);
  if (at < authorizedAt) fail('EMAIL_SETUP_AUTHORIZATION_FROM_FUTURE');
  if (at - authorizedAt >= EMAIL_SETUP_WINDOW_MS) fail('EMAIL_SETUP_WINDOW_EXPIRED');
  if (!summarizeAlertDelivery(env).configured || env.RESEND_API_KEY.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(env.RESEND_API_KEY)) {
    fail('EMAIL_SETUP_NOT_CONFIGURED');
  }
  const testId = env.ALERTS_SETUP_TEST_ID.toLowerCase();
  const setupReference = `finance-email-setup-${hash(testId).slice(0, 32)}`;
  const body = JSON.stringify({ from: env.ALERTS_EMAIL_FROM, to: [env.ALERTS_EMAIL_TO],
    subject: 'Finance Coordinator email setup test',
    text: ['This is the requested Finance Coordinator email setup test.',
      'Financial automation remains disabled. This test does not request any money transfers.',
      'The sending service accepting a message does not prove that it reached your inbox. Receipt is checked separately.',
      `Setup reference: ${setupReference}`].join('\n\n') });
  // Bind retry identity to the one authorized test, not to a caller-controlled
  // body or the current time. A changed body with the same key must be reviewed.
  return { body, setupReference, authorizedAt: new Date(authorizedAt).toISOString(),
    idempotencyKey: `finance-email-setup/v1/${testId}`, requestHash: hash(body) };
}

async function acceptedResponse(response) {
  const status = response?.status;
  let unexpectedOrigin = false;
  if (response?.url) {
    try { unexpectedOrigin = new URL(response.url).origin !== 'https://api.resend.com'; }
    catch { unexpectedOrigin = true; }
  }
  if (!Number.isInteger(status) || status < 100 || status > 599 || response.redirected || unexpectedOrigin || status >= 300 && status < 400) {
    fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true });
  }
  if (status < 200 || status >= 300) {
    void response.body?.cancel?.().catch(() => {});
    fail(status === 429 ? 'EMAIL_SETUP_RATE_LIMITED' : status === 409 ? 'EMAIL_SETUP_IDEMPOTENCY_CONFLICT' : 'EMAIL_SETUP_PROVIDER_REJECTED',
      { uncertain: status >= 500 || status === 409 });
  }
  let value;
  try {
    if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true });
    const reader = response.body?.getReader();
    if (!reader) fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true });
    let bytes = 0, content = ''; const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true }); }
        content += decoder.decode(chunk, { stream: true });
      }
      content += decoder.decode(); value = JSON.parse(content);
    } finally { reader.releaseLock(); }
  } catch { fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true }); }
  if (!UUID.test(value?.id ?? '')) fail('EMAIL_SETUP_RESPONSE_INVALID', { uncertain: true });
  return value.id.toLowerCase();
}

/** One POST per authorized invocation; retries retain the same provider key.
 * No argument can supply a recipient or message, and no send updates proof. */
export async function sendEmailSetupTest({ env = process.env, now = () => Date.now(), fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof now !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    fail('EMAIL_SETUP_CONFIGURATION_INVALID');
  }
  const request = setupRequest(env, now()), controller = new AbortController();
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': request.idempotencyKey },
        body: request.body });
    } catch { fail('EMAIL_SETUP_DELIVERY_UNCERTAIN', { uncertain: true }); }
    const deliveryId = await acceptedResponse(response);
    return { schemaVersion: 1, status: 'accepted', code: 'EMAIL_SETUP_PROVIDER_ACCEPTED', provider: 'resend',
      providerAccepted: true, recipientConfirmed: false, deliveryId,
      setupReference: request.setupReference, requestHash: request.requestHash, authorizedAt: request.authorizedAt,
      financialExecutionEnabled: false, realTransfers: 0 };
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new EmailSetupError('EMAIL_SETUP_DELIVERY_UNCERTAIN', { uncertain: true })); }, timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}
