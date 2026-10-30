import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivationPolicy, resolveActivationPolicy } from '../lib/activation-source.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const AT = '2030-01-01T11:00:00.000Z';
const ID = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const inactive = () => ({ schemaVersion: 1, updatedAt: AT,
  sequenceAuthority: { status: 'unverified' }, emailDelivery: { status: 'unverified' } });
const verified = () => ({ schemaVersion: 1, updatedAt: AT,
  sequenceAuthority: { status: 'verified', verifiedAt: AT, reference: 'Synthetic reviewed permission settings',
    automaticApproval: true, accountPairs: [{ sourceAccountId: ID(1), destinationAccountId: ID(2) }], maxAmountCents: null },
  emailDelivery: { status: 'verified', verifiedAt: AT, reference: 'Synthetic provider receipt and inbox confirmation', provider: 'resend',
    recipient: 'recipient@example.test', sender: 'Finance <sender@example.test>', providerAccepted: true, recipientConfirmed: true } });

test('unverified activation evidence stays explicitly unverified', () => {
  assert.deepEqual(parseActivationPolicy(JSON.stringify(inactive())), inactive());
});

test('reviewed permission and inbox evidence round trips without leaking or inferring authority', () => {
  assert.deepEqual(parseActivationPolicy(verified()), verified());
  const limited = verified(); limited.sequenceAuthority.maxAmountCents = 100000;
  limited.sequenceAuthority.automaticApproval = false;
  assert.equal(parseActivationPolicy(limited).sequenceAuthority.automaticApproval, false);
  assert.equal(parseActivationPolicy(limited).sequenceAuthority.maxAmountCents, 100000);
});

test('authority rejects malformed, duplicate, self, or subminimum pair definitions', async t => {
  const cases = [
    value => { value.sequenceAuthority.accountPairs = []; },
    value => { value.sequenceAuthority.accountPairs.push(value.sequenceAuthority.accountPairs[0]); },
    value => { value.sequenceAuthority.accountPairs[0].destinationAccountId = ID(1); },
    value => { value.sequenceAuthority.accountPairs[0].sourceAccountId = 'not-an-account'; },
    value => { value.sequenceAuthority.maxAmountCents = 99; },
    value => { value.sequenceAuthority.maxAmountCents = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.sequenceAuthority.automaticApproval = 'true'; },
    value => { value.sequenceAuthority.accountPairs[0].allowAll = true; },
  ];
  for (const [index, edit] of cases.entries()) await t.test(String(index + 1), () => {
    const value = verified(); edit(value); assert.throws(() => parseActivationPolicy(value), { name: 'ActivationPolicyError' });
  });
});

test('email evidence requires both acceptance and receipt, bound to valid sender and recipient', async t => {
  const cases = [
    value => { value.emailDelivery.providerAccepted = false; },
    value => { value.emailDelivery.recipientConfirmed = false; },
    value => { value.emailDelivery.recipient = 'a@example.test,b@example.test'; },
    value => { value.emailDelivery.sender = 'Sender\r\nBcc: another@example.test'; },
    value => { delete value.emailDelivery.sender; },
    value => { value.emailDelivery.provider = 'unreviewed'; },
  ];
  for (const [index, edit] of cases.entries()) await t.test(String(index + 1), () => {
    const value = verified(); edit(value); assert.throws(() => parseActivationPolicy(value), { name: 'ActivationPolicyError' });
  });
});

test('evidence rejects normalized calendar mistakes, newer proofs, injected fields and oversized sources', () => {
  const invalidDate = inactive(); invalidDate.updatedAt = '2030-02-30T00:00:00Z';
  assert.throws(() => parseActivationPolicy(invalidDate), { code: 'ACTIVATION_POLICY_TIME_INVALID' });
  const newer = verified(); newer.emailDelivery.verifiedAt = '2030-01-01T11:01:00Z';
  assert.throws(() => parseActivationPolicy(newer), { code: 'ACTIVATION_EVIDENCE_NEWER_THAN_POLICY' });
  assert.throws(() => parseActivationPolicy({ ...inactive(), enableTransfers: true }), { code: 'ACTIVATION_POLICY_INVALID' });
  assert.throws(() => parseActivationPolicy(' '.repeat(50001)), { code: 'ACTIVATION_POLICY_TOO_LARGE' });
});

test('activation evidence reader uses a consistent uncached key read and refuses future evidence', async () => {
  const calls = [];
  const result = await resolveActivationPolicy({ monthly: { enabled: true } }, { now: NOW,
    getAll: async (...args) => { calls.push(args); return { activation_policy: inactive() }; } });
  assert.deepEqual(calls, [[['activation_policy'], { consistentRead: true }]]);
  assert.equal(result.readinessEvidenceError, null); assert.deepEqual(result.readinessEvidence, inactive());
  const future = inactive(); future.updatedAt = '2030-01-02T00:00:00Z';
  const blocked = await resolveActivationPolicy({ monthly: { enabled: true } }, { now: NOW,
    getAll: async () => ({ activation_policy: future }) });
  assert.equal(blocked.readinessEvidenceError, 'ACTIVATION_POLICY_FROM_FUTURE');
});

test('source failures are bounded and sanitized; disabled monthly mode performs no read', async () => {
  const result = await resolveActivationPolicy({ monthly: { enabled: true } }, { now: NOW,
    getAll: async () => { throw Error('PRIVATE_PROVIDER_DETAILS'); } });
  assert.deepEqual(result, { readinessEvidence: null, readinessEvidenceError: 'ACTIVATION_POLICY_UNAVAILABLE' });
  const timed = await resolveActivationPolicy({ monthly: { enabled: true } }, { now: NOW, timeoutMs: 1,
    getAll: () => new Promise(() => {}) });
  assert.equal(timed.readinessEvidenceError, 'ACTIVATION_SOURCE_TIMEOUT');
  const disabled = await resolveActivationPolicy({ monthly: { enabled: false } }, {
    getAll: async () => { throw Error('MUST_NOT_CALL'); } });
  assert.deepEqual(disabled, { readinessEvidence: null, readinessEvidenceError: null });
});
