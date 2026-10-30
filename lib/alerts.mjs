import { createHash } from 'node:crypto';

export class AlertError extends Error {
  constructor(code, { uncertain = false } = {}) { super(code); this.name = 'AlertError'; this.code = code; this.uncertain = uncertain; }
}
const fail = (code, options) => { throw new AlertError(code, options); };
const address = x => typeof x === 'string' && x.length <= 254 && /^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/.test(x);
function fromAddress(x) {
  if (typeof x !== 'string' || x.length > 340 || /[\r\n]/.test(x)) return false;
  if (address(x)) return true;
  const match = /^([A-Za-z0-9 ._-]{1,70}) <([^<>]+)>$/.exec(x);
  return Boolean(match && address(match[2]));
}
export function summarizeAlertDelivery(env) {
  return { channel: 'email', configured: Boolean(typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.trim() &&
    !/[\r\n]/.test(env.RESEND_API_KEY) && address(env.ALERTS_EMAIL_TO) && fromAddress(env.ALERTS_EMAIL_FROM)),
    timing: 'send_on_detection', provider: 'resend' };
}
const money = x => Number.isSafeInteger(x) && x >= 0 ? `$${(x / 100).toFixed(2)}` : 'Not yet verified';

/** Render only stable, intended alert fields. Never forward arbitrary provider
 * responses, account identifiers, stack traces or credentials to email. */
export function formatFinanceAlert(alert) {
  if (!alert || typeof alert.id !== 'string' || alert.id.length < 1 || alert.id.length > 200 ||
      !/^[A-Za-z0-9:_/-]+$/.test(alert.id) || typeof alert.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(alert.code)) fail('ALERT_INPUT_INVALID');
  const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(alert.monthKey ?? '') ? alert.monthKey : null;
  const titles = {
    BILLS_CASH_SHORTFALL: 'Bills funding is short', GENERAL_CASH_SHORTFALL: 'General Spending funding is short',
    EMERGENCY_CASH_SHORTFALL: 'Emergency Fund contribution is short', ROTH_CASH_SHORTFALL: 'Roth IRA contribution is short',
    PROJECT_CASH_SHORTFALL: 'Project Savings contribution is short', INCOME_CLASSIFICATION_REQUIRED: 'An Income deposit needs classification',
    MONTHLY_SUBMISSION_UNCERTAIN: 'A transfer outcome needs review', MONTHLY_TRANSFER_FAILED: 'A finance transfer failed',
  };
  const title = titles[alert.code] ?? 'Finance automation needs attention';
  const amount = alert.shortfallCents ?? alert.amountInCents;
  const lines = [title, ...(month ? [`Allocation month: ${month}`] : []), `Issue: ${alert.code}`,
    ...(amount !== undefined ? [`Amount requiring attention: ${money(amount)}`] : []),
    'Check the finance-coordinator status before changing a transfer or sending a replacement.',
    'A submitted or pending transfer is not proof that the destination has received the money.',
    `Alert reference: ${alert.id}`];
  return { subject: `Finance alert${month ? ` (${month})` : ''}: ${title}`, text: lines.join('\n\n') };
}

export function createAlertSender({ env = process.env, liveEnabled = false, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const ready = summarizeAlertDelivery(env).configured;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || typeof fetchImpl !== 'function') fail('ALERT_CONFIGURATION_INVALID');
  return async alert => {
    if (!liveEnabled || env.VERCEL_ENV === 'preview') fail('ALERT_DELIVERY_DISABLED');
    if (!ready) fail('ALERT_DELIVERY_NOT_CONFIGURED');
    const body = { from: env.ALERTS_EMAIL_FROM, to: [env.ALERTS_EMAIL_TO], ...formatFinanceAlert(alert) };
    const key = `finance-alert/${createHash('sha256').update(alert.id).digest('hex')}`;
    const controller = new AbortController();
    let timer;
    const operation = (async () => {
      let response;
      try { response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }); }
      catch { fail('ALERT_DELIVERY_UNCERTAIN', { uncertain: true }); }
      if (!response || response.redirected || response.url && new URL(response.url).origin !== 'https://api.resend.com') fail('ALERT_RESPONSE_INVALID', { uncertain: true });
      if (!response.ok) fail(response.status === 429 ? 'ALERT_RATE_LIMITED' : 'ALERT_DELIVERY_REJECTED', { uncertain: response.status >= 500 });
      let value;
      try {
        if (Number(response.headers?.get?.('content-length')) > 10000) fail('ALERT_RESPONSE_INVALID', { uncertain: true });
        const reader = response.body?.getReader(); if (!reader) fail('ALERT_RESPONSE_INVALID', { uncertain: true });
        let bytes = 0, content = ''; const decoder = new TextDecoder();
        for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; bytes += chunk.byteLength;
          if (bytes > 10000) { void reader.cancel(); fail('ALERT_RESPONSE_INVALID', { uncertain: true }); }
          content += decoder.decode(chunk, { stream: true }); }
        content += decoder.decode(); value = JSON.parse(content);
      } catch { fail('ALERT_RESPONSE_INVALID', { uncertain: true }); }
      if (typeof value?.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)) fail('ALERT_RESPONSE_INVALID', { uncertain: true });
      // Provider acceptance is recorded as acceptance, not an inbox-read receipt.
      return { deliveryId: value.id, status: 'accepted' };
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AlertError('ALERT_DELIVERY_UNCERTAIN', { uncertain: true })); }, timeoutMs); });
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  };
}
