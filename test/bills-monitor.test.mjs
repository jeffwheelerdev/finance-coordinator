import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { prepareBillsUpdate, BillsMonitorError, BILL_MONITOR_HEARTBEAT_MS, BILL_MONITOR_WRITE_WINDOW_MS } from '../lib/bills-monitor.mjs';
import { forecastBills } from '../lib/bills.mjs';
import { main as prepareCli } from '../scripts/prepare-bills-update.mjs';

// Synthetic private catalog and evidence. No production service names or IDs.
const CATALOG_AT = '2030-05-01T12:00:00.000Z';
const CHECKED_AT = '2030-05-02T12:00:00.000Z';
const NOW = '2030-05-02T18:00:00.000Z';
const proof = (type = 'invoice', observedAt = CATALOG_AT) => ({ type, observedAt, reference: 'synthetic recurring invoice' });
const bill = (id = 'example-bill', overrides = {}) => ({
  id, name: 'Example recurring obligation', kind: 'expense', status: 'active', amountCents: 60000,
  frequency: 'monthly', evidence: proof(), ...overrides,
});
const fixture = (overrides = {}) => ({
  catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: CATALOG_AT, bills: [bill()] },
  monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: CHECKED_AT, catalogUpdatedAt: CATALOG_AT, reviewCodes: [] },
  verifiedCoverage: true, now: NOW, ...overrides,
});
const obs = (changes, type = 'invoice', billId = 'example-bill', observedAt = NOW) => ({ billId, ...changes, evidence: proof(type, observedAt) });
const code = expected => caught => caught instanceof Error && caught.code === expected;
const canceled = { confirmed: true, effectiveOn: '2030-05-02', reference: 'explicit synthetic cancellation' };

test('no change before 24 hours preserves both records exactly and requests no write or notification', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = prepareBillsUpdate(input);
  assert.equal(result.requiresWrite, false);
  assert.equal(result.shouldNotify, false);
  assert.equal(result.blocked, false);
  assert.equal(result.patch, null);
  assert.deepEqual(result.catalog, input.catalog);
  assert.deepEqual(result.monitor, input.monitor);
  assert.deepEqual(input, before);
  assert.equal(result.expectedMonitorCheckedAt, CHECKED_AT);
  assert.equal(result.expectedCatalogHash, forecastBills(input.catalog, { now: NOW }).catalogHash);
});

test('matching posted amount does not churn evidence, updatedAt or catalog hash', () => {
  const input = fixture({ observations: [obs({ amountCents: 60000 }, 'posted_transaction')] });
  const result = prepareBillsUpdate(input);
  assert.equal(result.requiresWrite, false);
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.catalog, input.catalog);
  assert.equal(result.catalog.bills[0].evidence.type, 'invoice');
});

test('24-hour heartbeat writes only the monitor, retains catalog, and stays silent', () => {
  const input = fixture({ now: Date.parse(CHECKED_AT) + BILL_MONITOR_HEARTBEAT_MS });
  const result = prepareBillsUpdate(input);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.shouldNotify, false);
  assert.deepEqual(result.catalog, input.catalog);
  assert.equal(result.monitor.catalogUpdatedAt, CATALOG_AT);
  assert.equal(result.monitor.checkedAt, '2030-05-03T12:00:00.000Z');
  assert.deepEqual(result.monitor.writeHistory, [CATALOG_AT, '2030-05-03T12:00:00.000Z']);
  assert.deepEqual(Object.keys(result.patch), ['bills_catalog', 'bills_monitor']);
  assert.equal(prepareBillsUpdate(fixture({ now: Date.parse(CHECKED_AT) + BILL_MONITOR_HEARTBEAT_MS - 1 })).requiresWrite, false);
});

test('a posted increase updates the exact bill, target bucket and one atomic patch', () => {
  const input = fixture({ observations: [obs({ amountCents: 110001 }, 'posted_transaction')] });
  const result = prepareBillsUpdate(input);
  assert.equal(result.previousTargetCents, 100000);
  assert.equal(result.targetCents, 150000);
  assert.equal(result.peakMonthCents, 110001);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.shouldNotify, true);
  assert.equal(result.catalog.updatedAt, NOW);
  assert.equal(result.monitor.catalogUpdatedAt, NOW);
  assert.equal(result.catalog.bills[0].amountCents, 110001);
  assert.equal(result.patch.bills_catalog, result.catalog);
  assert.equal(result.patch.bills_monitor, result.monitor);
  assert.equal(input.catalog.bills[0].amountCents, 60000);
});

test('lower posted amount creates a deduplicated review issue without changing the catalog', () => {
  const input = fixture({ observations: [obs({ amountCents: 20000 }, 'posted_transaction')] });
  const first = prepareBillsUpdate(input);
  assert.deepEqual(first.catalog, input.catalog);
  assert.equal(first.targetCents, 100000);
  assert.equal(first.shouldNotify, true);
  assert.equal(first.requiresWrite, true);
  assert.deepEqual(first.monitor.reviewCodes, ['BILL_CHANGE_REQUIRES_CONFIRMATION']);
  assert.equal(first.monitor.reviewIssues.length, 1);
  assert.match(first.monitor.reviewIssues[0].fingerprint, /^[a-f0-9]{64}$/);
  const again = prepareBillsUpdate({
    ...input, catalog: first.catalog, monitor: first.monitor, now: '2030-05-02T19:00:00Z',
    observations: [obs({ amountCents: 20000 }, 'posted_transaction', 'example-bill', '2030-05-02T19:00:00Z')],
  });
  assert.equal(again.requiresWrite, false);
  assert.equal(again.shouldNotify, false);
});

test('the same review code on a different exact bill is a new issue', () => {
  const input = fixture();
  input.catalog.bills.push(bill('other-bill', { amountCents: 10000 }));
  const first = prepareBillsUpdate({ ...input, observations: [obs({ amountCents: 20000 }, 'posted_transaction')] });
  const second = prepareBillsUpdate({ ...input, catalog: first.catalog, monitor: first.monitor,
    now: '2030-05-02T19:00:00Z', observations: [obs({ amountCents: 5000 }, 'posted_transaction', 'other-bill', '2030-05-02T19:00:00Z')] });
  assert.equal(second.shouldNotify, true);
  assert.equal(second.monitor.reviewIssues.length, 2);
});

test('a verified recurring invoice can lower the target and resolve an explicit review code', () => {
  const input = fixture({ observations: [obs({ amountCents: 40000 })], reviewCodes: [] });
  input.monitor.reviewCodes = ['OLD_REVIEW'];
  const result = prepareBillsUpdate(input);
  assert.equal(result.targetCents, 50000);
  assert.equal(result.shouldNotify, true);
  assert.deepEqual(result.monitor.reviewCodes, []);
});

test('confirmed cancellation retains the bill ID and removes its future recurring cost', () => {
  const input = fixture({ observations: [obs({ status: 'canceled', cancellation: canceled }, 'user_confirmation')] });
  input.catalog.bills.push(bill('kept-bill', { amountCents: 20000 }));
  const result = prepareBillsUpdate(input);
  assert.deepEqual(result.catalog.bills.map(x => x.id), ['example-bill','kept-bill']);
  assert.equal(result.catalog.bills.find(x => x.id === 'example-bill').status, 'canceled');
  assert.equal(result.peakMonthCents, 20000);
  assert.equal(result.targetCents, 50000);
  assert.equal(result.shouldNotify, true);
  assert.throws(() => prepareBillsUpdate(fixture({ observations: [obs({ status: 'canceled', cancellation: canceled }, 'posted_transaction')] })), code('UNCONFIRMED_BILL_CANCELLATION'));
  assert.throws(() => prepareBillsUpdate(fixture({ observations: [obs({ status: 'canceled' })] })), code('UNCONFIRMED_BILL_CANCELLATION'));
});

test('verified new recurring expense is added once without removing existing IDs', () => {
  const newBill = bill('new-service', { amountCents: 45000, evidence: proof('provider_schedule', NOW) });
  const input = fixture({ additions: [newBill] });
  const result = prepareBillsUpdate(input);
  assert.equal(result.targetCents, 150000);
  assert.equal(result.shouldNotify, true);
  assert.deepEqual(result.catalog.bills.map(x => x.id), ['example-bill','new-service']);
  assert.deepEqual(result.changes, [{ billId: 'new-service', fields: ['added'] }]);
  assert.throws(() => prepareBillsUpdate(fixture({ additions: [bill()] })), code('BILLS_ADDITION_ID_EXISTS'));
  assert.throws(() => prepareBillsUpdate(fixture({ additions: [newBill, newBill] })), code('BILLS_ADDITION_ID_EXISTS'));
});

test('unverified additions, repayments, transfers, zero prices and unknown IDs cannot become expenses', async t => {
  for (const patch of [
    { evidence: proof('posted_transaction', NOW) }, { evidence: proof('budget_allowance', NOW) },
    { status: 'uncertain' }, { kind: 'card_payment' }, { kind: 'internal_transfer' },
  ]) await t.test(JSON.stringify(patch), () => {
    assert.throws(() => prepareBillsUpdate(fixture({ additions: [bill('new-service', patch)] })), code('BILLS_NEW_OBLIGATION_UNVERIFIED'));
  });
  assert.throws(() => prepareBillsUpdate(fixture({ additions: [bill('new-service', { amountCents: 0 })] })), code('INVALID_BILL_AMOUNT'));
  assert.throws(() => prepareBillsUpdate(fixture({ observations: [obs({ amountCents: 10000 }, 'invoice', 'unknown')] })), code('UNKNOWN_BILL_ID'));
});

test('review codes are preserved by default, new issues notify, clearing alone stays silent', () => {
  const input = fixture();
  input.monitor.reviewCodes = ['EXISTING_REVIEW'];
  assert.deepEqual(prepareBillsUpdate(input).monitor.reviewCodes, ['EXISTING_REVIEW']);
  const added = prepareBillsUpdate({ ...input, reviewCodes: ['EXISTING_REVIEW','NEW_REVIEW'] });
  assert.equal(added.requiresWrite, true);
  assert.equal(added.shouldNotify, true);
  const cleared = prepareBillsUpdate({ ...input, reviewCodes: [] });
  assert.equal(cleared.requiresWrite, true);
  assert.equal(cleared.shouldNotify, false);
  assert.deepEqual(cleared.monitor.reviewCodes, []);
});

test('year rollover refreshes projection metadata without a notification when the cap is unchanged', () => {
  const input = fixture({ now: '2031-01-01T05:01:00Z' });
  input.monitor.checkedAt = '2031-01-01T04:59:00Z';
  const result = prepareBillsUpdate(input);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.shouldNotify, false);
  assert.deepEqual(result.catalog, input.catalog);
});

test('a future-effective cancellation changes the cap when its local effective date arrives', () => {
  const input = fixture({ now: '2030-05-03T04:01:00Z' });
  input.catalog.bills = [bill('ending', { status: 'canceled', cancellation: { ...canceled, effectiveOn: '2030-05-03' } }), bill('kept', { amountCents: 10000 })];
  input.monitor.checkedAt = '2030-05-03T03:59:00Z';
  const result = prepareBillsUpdate(input);
  assert.equal(result.previousTargetCents, 100000);
  assert.equal(result.targetCents, 50000);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.shouldNotify, true);
  assert.deepEqual(result.catalog, input.catalog);
});

test('rolling 30-day quota blocks the 91st write and never advances the heartbeat', () => {
  const now = Date.parse('2030-05-30T13:00:00Z');
  const input = fixture({ now, observations: [obs({ amountCents: 110000 }, 'invoice', 'example-bill', new Date(now).toISOString())] });
  input.monitor.checkedAt = new Date(now - 3600000).toISOString();
  input.monitor.writeHistory = Array.from({ length: 90 }, (_, i) => new Date(now - (90 - i) * 3600000).toISOString());
  const result = prepareBillsUpdate(input);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'BILLS_MONITOR_WRITE_QUOTA_REACHED');
  assert.equal(result.requiresWrite, false);
  assert.equal(result.shouldNotify, true);
  assert.equal(result.patch, null);
  assert.deepEqual(result.catalog, input.catalog);
  assert.deepEqual(result.monitor, input.monitor);
  assert.equal(result.targetCents, 100000);
  assert.equal(result.proposedTargetCents, 150000);
});

test('quota retains rolling history and permits a new write exactly after an old entry expires', () => {
  const now = Date.parse('2030-05-30T13:00:00Z');
  const input = fixture({ now, reviewCodes: ['NEW_REVIEW'] });
  input.monitor.checkedAt = new Date(now - 3600000).toISOString();
  input.monitor.writeHistory = [new Date(now - BILL_MONITOR_WRITE_WINDOW_MS).toISOString(),
    ...Array.from({ length: 89 }, (_, i) => new Date(now - (89 - i) * 3600000).toISOString())];
  const result = prepareBillsUpdate(input);
  assert.equal(result.blocked, false);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.monitor.writeHistory.length, 90);
  assert.equal(result.monitor.writeHistory.at(-1), new Date(now).toISOString());
  assert.ok(!result.monitor.writeHistory.includes(input.monitor.writeHistory[0]));
});

test('unverified coverage, malformed heartbeat, future evidence and stale versions cannot refresh monitoring', () => {
  assert.throws(() => prepareBillsUpdate(fixture({ verifiedCoverage: false })), code('BILLS_FINANCE_COVERAGE_UNVERIFIED'));
  assert.throws(() => prepareBillsUpdate(fixture({ verifiedCoverage: 'true' })), code('BILLS_FINANCE_COVERAGE_UNVERIFIED'));
  const missing = fixture(); delete missing.verifiedCoverage;
  assert.throws(() => prepareBillsUpdate(missing), code('BILLS_FINANCE_COVERAGE_UNVERIFIED'));
  const mismatch = fixture(); mismatch.monitor.catalogUpdatedAt = '2030-05-01T11:00:00Z';
  assert.throws(() => prepareBillsUpdate(mismatch), code('BILLS_MONITOR_CATALOG_MISMATCH'));
  const future = fixture(); future.monitor.checkedAt = '2030-05-03T00:00:00Z';
  assert.throws(() => prepareBillsUpdate(future), code('BILLS_MONITOR_TIME_INVALID'));
  const malformed = fixture(); malformed.monitor.checkedAt = '2030-02-30T00:00:00Z';
  assert.throws(() => prepareBillsUpdate(malformed), code('BILLS_MONITOR_TIME_INVALID'));
  assert.throws(() => prepareBillsUpdate(fixture({ observations: [obs({ amountCents: 70000 }, 'invoice', 'example-bill', '2030-05-03T12:00:00Z')] })), code('INCONSISTENT_BILL_TIMESTAMP'));
  assert.throws(() => prepareBillsUpdate(fixture({ observations: null })), code('BILLS_MONITOR_BATCH_INVALID'));
  assert.throws(() => prepareBillsUpdate(fixture({ reviewCodes: ['not a code'] })), code('BILLS_MONITOR_REVIEW_CODES_INVALID'));
});

test('invalid write history and review fingerprints are rejected before any patch', () => {
  const input = fixture();
  input.monitor.writeHistory = [CHECKED_AT, CHECKED_AT];
  assert.throws(() => prepareBillsUpdate(input), code('BILLS_MONITOR_WRITE_HISTORY_INVALID'));
  input.monitor.writeHistory = ['2030-05-02T13:00:00Z'];
  assert.throws(() => prepareBillsUpdate(input), code('BILLS_MONITOR_WRITE_HISTORY_INVALID'));
  delete input.monitor.writeHistory;
  input.monitor.reviewIssues = [{ code: 'MISSING_IN_CODES', fingerprint: 'a'.repeat(64) }];
  assert.throws(() => prepareBillsUpdate(input), code('BILLS_MONITOR_REVIEW_ISSUES_INVALID'));
  assert.ok(new BillsMonitorError('EXAMPLE').code === 'EXAMPLE');
});

test('CLI reads stdin, writes a private full patch file, and prints only a sanitized summary', async t => {
  const directory = await fs.mkdtemp('/tmp/bills-monitor-test-');
  try {
    const output = `${directory}/prepared.json`;
    const input = fixture({ observations: [obs({ amountCents: 110000 }, 'posted_transaction')] });
    const log = t.mock.method(console, 'log', () => {});
    const stdin = (async function* () { yield Buffer.from(JSON.stringify(input)); })();
    await prepareCli(['--output', output], { stdin });
    const stdout = log.mock.calls.map(call => call.arguments[0]).join('\n');
    const summary = JSON.parse(stdout);
    assert.equal(summary.requiresWrite, true);
    assert.equal(summary.targetCents, 150000);
    assert.equal(stdout.includes('Example recurring obligation'), false);
    assert.equal(stdout.includes('synthetic recurring invoice'), false);
    assert.equal(summary.catalog, undefined);
    const saved = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(saved.patch.bills_catalog.bills[0].amountCents, 110000);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI input file and --now override work without publishing bill rows in summary', async t => {
  const directory = await fs.mkdtemp('/tmp/bills-monitor-test-');
  try {
    const inputPath = `${directory}/input.json`, outputPath = `${directory}/output.json`;
    await fs.writeFile(inputPath, JSON.stringify(fixture()));
    const log = t.mock.method(console, 'log', () => {});
    await prepareCli(['--input', inputPath, '--output', outputPath, '--now', '2030-05-03T12:00:00Z']);
    assert.equal(JSON.parse(log.mock.calls[0].arguments[0]).requiresWrite, true);
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).monitor.checkedAt, '2030-05-03T12:00:00.000Z');
    await assert.rejects(() => prepareCli(['--input', inputPath, '--output', inputPath]), code('BILLS_MONITOR_OUTPUT_REPLACES_INPUT'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI fails without coverage and does not echo malformed private input', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const invalid = (async function* () { yield Buffer.from('{PRIVATE_INPUT'); })();
  await assert.rejects(() => prepareCli([], { stdin: invalid }), caught =>
    caught.code === 'BILLS_MONITOR_INPUT_JSON_INVALID' && !caught.message.includes('PRIVATE_INPUT'));
  assert.equal(log.mock.calls.length, 0);
  const missing = fixture(); delete missing.verifiedCoverage;
  const stdin = (async function* () { yield Buffer.from(JSON.stringify(missing)); })();
  await assert.rejects(() => prepareCli([], { stdin }), code('BILLS_FINANCE_COVERAGE_UNVERIFIED'));
  assert.equal(log.mock.calls.length, 0);
});
