import test from 'node:test';
import assert from 'node:assert/strict';
import { readRothPolicy, resolveRothPolicy } from '../lib/roth-source.mjs';
import { forecastRoth } from '../lib/roth.mjs';
import { rothEnvelopeFixture, ROTH_TEST_NOW } from './roth-policy-fixture.mjs';

test('Roth policy uses an origin-consistent bounded read and retains unknown personal facts', async () => {
  const calls = [];
  const result = await readRothPolicy({ now: ROTH_TEST_NOW, getAll: async (...args) => {
    calls.push(args); return { roth_policy: rothEnvelopeFixture() };
  } });
  assert.deepEqual(calls, [[['roth_policy'], { consistentRead: true }]]);
  const preview = forecastRoth(result.policy, { now: ROTH_TEST_NOW });
  assert.equal(preview.monthlyAmountCents, 62500);
  assert.equal(preview.amountInCents, 0);
  assert.equal(preview.outsideRothCents, null);
});

test('a disabled Roth feature never reads its source', async () => {
  const result = await resolveRothPolicy({ roth: { enabled: false } }, { getAll: () => { throw new Error('must not read'); } });
  assert.deepEqual(result, { rothPolicy: null, rothEvidence: null });
});

test('Roth-source failure is isolated and does not mutate cash funding configuration', async () => {
  const config = { roth: { enabled: true }, billsBufferCents: 350000 };
  const original = structuredClone(config);
  const result = await resolveRothPolicy(config, { now: ROTH_TEST_NOW, getAll: async () => { throw new Error('private-connection-secret'); } });
  assert.deepEqual(config, original);
  assert.equal(result.rothPolicyError, 'ROTH_SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private-connection-secret'), false);
});

test('missing and invalid annual sources never fall back to another policy', async () => {
  for (const data of [{}, { roth_policy: null }, { roth_policy: { ...rothEnvelopeFixture(), unexpected: 'private-value' } }]) {
    await assert.rejects(readRothPolicy({ getAll: async () => data, now: ROTH_TEST_NOW }), { code: 'ROTH_SOURCE_INVALID' });
  }
  const future = rothEnvelopeFixture(); future.policy.updatedAt = '2027-01-01T00:00:00Z';
  await assert.rejects(readRothPolicy({ getAll: async () => ({ roth_policy: future }), now: ROTH_TEST_NOW }), { code: 'ROTH_SOURCE_FUTURE_VERSION' });
});

test('Roth reads have no stale cache, and a new year without IRS evidence stays blocked', async () => {
  const data = { roth_policy: rothEnvelopeFixture() };
  const getAll = async () => structuredClone(data);
  const first = await readRothPolicy({ getAll, now: ROTH_TEST_NOW });
  data.roth_policy.policy.updatedAt = '2026-10-29T19:59:00Z';
  const next = await readRothPolicy({ getAll, now: ROTH_TEST_NOW });
  assert.notEqual(next.policy.updatedAt, first.policy.updatedAt);
  const newYear = forecastRoth(next.policy, { now: Date.parse('2027-01-01T15:00:00Z') });
  assert.equal(newYear.monthlyAmountCents, null);
  assert.ok(newYear.blockers.includes('ROTH_STATUTORY_LIMIT_UNVERIFIED'));
});

test('source timeout and oversized responses are bounded and sanitized', async () => {
  await assert.rejects(readRothPolicy({ getAll: () => new Promise(() => {}), now: ROTH_TEST_NOW, timeoutMs: 5 }), { code: 'ROTH_SOURCE_TIMEOUT' });
  await assert.rejects(readRothPolicy({ getAll: async () => ({ extra: 'x'.repeat(256001) }), now: ROTH_TEST_NOW }), { code: 'ROTH_SOURCE_TOO_LARGE' });
  for (const options of [{ now: NaN }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { getAll: 'wrong' }]) {
    await assert.rejects(readRothPolicy({ getAll: async () => ({}), now: ROTH_TEST_NOW, ...options }), { code: 'ROTH_SOURCE_CONFIGURATION_INVALID' });
  }
});
