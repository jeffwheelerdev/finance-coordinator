import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertSender, formatFinanceAlert, summarizeAlertDelivery } from '../lib/alerts.mjs';
const env = { RESEND_API_KEY: 'synthetic-email-key', ALERTS_EMAIL_TO: 'owner@example.test', ALERTS_EMAIL_FROM: 'Finance Coordinator <alerts@example.test>', VERCEL_ENV: 'production' };
const alert = { id: 'monthly:2030-01:roth-shortfall', code: 'ROTH_CASH_SHORTFALL', monthKey: '2030-01', shortfallCents: 22500 };
const deliveryId = '00000000-0000-4000-8000-000000000001';
test('sender targets only the configured owner with a stable idempotency key', async () => {
  const requests = [];
  const sender = createAlertSender({ env, liveEnabled: true, fetchImpl: async (url, init) => { requests.push({ url, ...init }); return Response.json({ id: deliveryId }); } });
  assert.equal((await sender({ ...alert, to: 'attacker@example.test' })).deliveryId, deliveryId);
  await sender(alert);
  assert.equal(requests[0].url, 'https://api.resend.com/emails'); assert.equal(requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].body).to, [env.ALERTS_EMAIL_TO]);
  assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
  assert.match(JSON.parse(requests[0].body).text, /\$225\.00/);
});
test('observe, preview and missing sender configurations never send', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; };
  for (const options of [{ env, liveEnabled: false }, { env: { ...env, VERCEL_ENV: 'preview' }, liveEnabled: true }, { env: {}, liveEnabled: true }]) {
    await assert.rejects(createAlertSender({ ...options, fetchImpl })(alert), e => ['ALERT_DELIVERY_DISABLED', 'ALERT_DELIVERY_NOT_CONFIGURED'].includes(e.code));
  }
  assert.equal(calls, 0);
});
test('email headers cannot inject recipients or new header fields', () => {
  for (const to of ['owner@example.test\nBcc: hidden@example.test', 'one@example.test,two@example.test']) assert.equal(summarizeAlertDelivery({ ...env, ALERTS_EMAIL_TO: to }).configured, false);
});
test('alerts never forward raw provider bodies or arbitrary error text', () => {
  const result = formatFinanceAlert({ ...alert, stack: 'private-secret', provider: { accountId: 'private-account' } });
  assert.doesNotMatch(JSON.stringify(result), /private-secret|private-account/);
});
test('HTTP errors are sanitized and accepted malformed responses remain uncertain', async () => {
  for (const [response, code, uncertain] of [[new Response('private-secret', { status: 500 }), 'ALERT_DELIVERY_REJECTED', true],
    [new Response('private-secret', { status: 429 }), 'ALERT_RATE_LIMITED', false], [Response.json({ token: 'private-secret' }), 'ALERT_RESPONSE_INVALID', true]]) {
    await assert.rejects(createAlertSender({ env, liveEnabled: true, fetchImpl: async () => response })(alert), e => e.code === code && e.uncertain === uncertain && !e.message.includes('private-secret'));
  }
});
test('a timeout is recorded as uncertain rather than as a definite rejection', async () => {
  await assert.rejects(createAlertSender({ env, liveEnabled: true, timeoutMs: 2, fetchImpl: () => new Promise(() => {}) })(alert), e => e.code === 'ALERT_DELIVERY_UNCERTAIN' && e.uncertain);
});
