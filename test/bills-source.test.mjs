import test from 'node:test';
import assert from 'node:assert/strict';
import { readBillsPolicy, resolveBillsConfiguration, summarizeBillsPolicy, MAX_MONITOR_AGE_MS } from '../lib/bills-source.mjs';
import { makeConfig, TEST_NOW, asISO } from './fixtures.mjs';

function fixture() {
  const updatedAt = asISO(TEST_NOW - 10_000);
  return {
    bills_catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt, bills: [{
      id: 'fixture-rent', name: 'Fixture rent', kind: 'expense', status: 'active', amountCents: 123456,
      frequency: 'monthly', evidence: { type: 'user_confirmation', reference: 'Synthetic fixture', observedAt: updatedAt },
    }] },
    bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: asISO(TEST_NOW), catalogUpdatedAt: updatedAt, reviewCodes: ['UNKNOWN_RENEWAL_DATE'] },
  };
}

test('private source reads one coherent catalog and monitor bundle, then rounds exact cents', async () => {
  const data = fixture(), calls = [];
  const result = await readBillsPolicy({ getAll: async (keys, options) => { calls.push({ keys, options }); return data; }, now: TEST_NOW });
  assert.deepEqual(calls, [{ keys: ['bills_catalog', 'bills_monitor'], options: { consistentRead: true } }]);
  assert.equal(result.forecast.targetCents, 150000);
  assert.equal(result.forecast.peakMonthCents, 123456);
  assert.equal(result.monitor.checkedAt, asISO(TEST_NOW));
  const summary = summarizeBillsPolicy(result);
  assert.ok(!JSON.stringify(summary).includes('Fixture rent'));
  assert.ok(!JSON.stringify(summary).includes('Synthetic fixture'));
  assert.deepEqual(summary.reviewCodes, ['UNKNOWN_RENEWAL_DATE']);
});

test('missing or invalid private source never falls back to a fixed dollar target', async () => {
  await assert.rejects(readBillsPolicy({ now: TEST_NOW }), { code: 'BILLS_SOURCE_CONFIGURATION_REQUIRED' });
  await assert.rejects(readBillsPolicy({ getAll: async () => null, now: TEST_NOW }), { code: 'BILLS_SOURCE_INVALID' });
  await assert.rejects(readBillsPolicy({ getAll: async () => ({}), now: TEST_NOW }), { code: 'INVALID_BILLS_CATALOG' });
});

test('catalog/network errors never return or log a secret-bearing SDK message', async () => {
  const privateText = 'https://example.invalid?token=do-not-echo';
  await assert.rejects(readBillsPolicy({ getAll: async () => { throw new Error(privateText); }, now: TEST_NOW }), error =>
    error.code === 'BILLS_SOURCE_UNAVAILABLE' && !error.message.includes(privateText));
});

test('a delayed private source is bounded', async () => {
  await assert.rejects(readBillsPolicy({ getAll: () => new Promise(() => {}), now: TEST_NOW, timeoutMs: 5 }), { code: 'BILLS_SOURCE_TIMEOUT' });
});

test('catalog and daily monitoring heartbeat must match', async () => {
  const data = fixture();
  data.bills_monitor.catalogUpdatedAt = asISO(TEST_NOW - 20_000);
  await assert.rejects(readBillsPolicy({ getAll: async () => data, now: TEST_NOW }), { code: 'BILLS_MONITOR_CATALOG_MISMATCH' });
});

test('the last successful check can be seven days old but cannot silently grow stale', async () => {
  const data = fixture();
  const time = TEST_NOW - MAX_MONITOR_AGE_MS;
  data.bills_catalog.updatedAt = asISO(time - 1000);
  data.bills_catalog.bills[0].evidence.observedAt = asISO(time - 1000);
  data.bills_monitor.catalogUpdatedAt = data.bills_catalog.updatedAt;
  data.bills_monitor.checkedAt = asISO(time);
  assert.equal((await readBillsPolicy({ getAll: async () => data, now: TEST_NOW })).forecast.targetCents, 150000);
  await assert.rejects(readBillsPolicy({ getAll: async () => data, now: TEST_NOW + 1 }), { code: 'BILLS_MONITOR_STALE' });
});

test('failed, absent, future-dated and mismatched monitoring states block new funding', async t => {
  const cases = [
    ['missing', data => { delete data.bills_monitor; }, 'BILLS_MONITOR_INVALID'],
    ['failed status', data => { data.bills_monitor.status = 'failed'; }, 'BILLS_MONITOR_INVALID'],
    ['wrong source', data => { data.bills_monitor.source = 'untrusted'; }, 'BILLS_MONITOR_INVALID'],
    ['future', data => { data.bills_monitor.checkedAt = asISO(TEST_NOW + 300001); }, 'BILLS_MONITOR_TIME_INVALID'],
    ['before catalog', data => { data.bills_monitor.checkedAt = asISO(TEST_NOW - 20000); }, 'BILLS_MONITOR_TIME_INVALID'],
    ['bad date', data => { data.bills_monitor.checkedAt = '2030-02-31T12:00:00Z'; }, 'BILLS_MONITOR_TIME_INVALID'],
    ['bad review code', data => { data.bills_monitor.reviewCodes = ['private arbitrary text']; }, 'BILLS_MONITOR_INVALID'],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const data = fixture(); mutate(data);
    await assert.rejects(readBillsPolicy({ getAll: async () => data, now: TEST_NOW }), { code });
  });
});

test('reading again sees a changed cap without a deployment or reused application cache', async () => {
  const data = fixture(), getAll = async () => data;
  assert.equal((await readBillsPolicy({ getAll, now: TEST_NOW })).forecast.targetCents, 150000);
  data.bills_catalog.bills[0].amountCents = 150001;
  data.bills_catalog.updatedAt = asISO(TEST_NOW);
  data.bills_monitor.catalogUpdatedAt = asISO(TEST_NOW);
  assert.equal((await readBillsPolicy({ getAll, now: TEST_NOW })).forecast.targetCents, 200000);
});

test('oversized or invalid configuration is rejected with bounded, nonsensitive codes', async () => {
  const data = fixture(); data.unrelated = 'x'.repeat(1_000_001);
  await assert.rejects(readBillsPolicy({ getAll: async () => data, now: TEST_NOW }), { code: 'BILLS_SOURCE_TOO_LARGE' });
  for (const options of [{ getAll: 'bad' }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { now: NaN }]) {
    await assert.rejects(readBillsPolicy({ getAll: async () => fixture(), now: TEST_NOW, ...options }), { code: 'BILLS_SOURCE_CONFIGURATION_INVALID' });
  }
});

test('resolved configuration uses the computed target for both Bills funding and Income protection', async () => {
  const result = await resolveBillsConfiguration(makeConfig(), { getAll: async () => fixture(), now: TEST_NOW });
  assert.equal(result.config.allocations[0].id, 'bills');
  assert.equal(result.config.allocations[0].targetCents, 150000);
  assert.equal(result.config.billsBufferCents, 150000);
});
