import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyUpstreamFunding } from '../lib/upstream.mjs';
import { SequenceClient } from '../lib/sequence.mjs';
import { EvidenceError } from '../lib/evidence.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RULE = id(1), NOW = Date.parse('2030-01-03T00:00:00Z'), START = '2030-01-01T00:00:00Z';
const config = { rules: { funding: RULE } };
const summary = overrides => ({ id: id(2), ruleId: RULE, status: 'EXECUTED', executionMode: 'LIVE',
  createdAt: '2030-01-02T12:00:00Z', ...overrides });
const detail = overrides => ({ ...summary(), triggerDetails: { type: 'SCHEDULED' }, stepIndexMatched: 0,
  conditionsNotMet: false, transfersAttempted: 2, transfersCompleted: 2, transfersFailed: 0,
  transfersPending: 0, transferIds: [id(10), id(11)], errorMessage: null, nextAttemptAt: null, ...overrides });
const options = { now: NOW, activationAt: START };
function fake({ items = [summary()], full = detail(), complete = true } = {}) {
  const calls = { list: [], detail: [] };
  return { calls,
    async listRuleExecutions(query) { calls.list.push(query); return { items, complete }; },
    async getRuleExecution(ruleId, executionId) { calls.detail.push([ruleId, executionId]); return full; },
  };
}
const evidenceCode = (code, review) => error => error instanceof EvidenceError && error.code === code &&
  (review === undefined || error.review === review);
const apiCode = code => error => error.code === code;
const json = data => new Response(JSON.stringify({ data, requestId: 'synthetic-test-request' }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const page = (items, pageNumber, hasNextPage) => ({ items,
  pagination: { page: pageNumber, pageSize: 100, hasNextPage } });
const api = (fetchImpl, overrides = {}) => new SequenceClient({ apiKey: 'test-only-not-a-real-key',
  fetchImpl, now: () => NOW, ...overrides });

test('global guard enumerates every summary but reads only the latest success detail', async () => {
  const older = summary({ id: id(3), createdAt: START });
  const client = fake({ items: [older, summary()] });
  assert.deepEqual(await verifyUpstreamFunding(client, config, options), { checked: 2 });
  assert.deepEqual(client.calls.list, [{ ruleId: RULE, executionMode: 'LIVE', from: START, to: new Date(NOW).toISOString() }]);
  assert.deepEqual(client.calls.detail, [[RULE, id(2)]]);
});

test('empty complete history does not fabricate a funding-payout linkage', async () => {
  const client = fake({ items: [] });
  assert.deepEqual(await verifyUpstreamFunding(client, config, options), { checked: 0 });
  assert.equal(client.calls.detail.length, 0);
});

test('observation without activation scans all available history with a fixed end', async () => {
  const client = fake();
  await verifyUpstreamFunding(client, config, { now: NOW, activationAt: null });
  assert.equal(Object.hasOwn(client.calls.list[0], 'from'), false);
  assert.equal(client.calls.list[0].to, new Date(NOW).toISOString());
});

test('an older failed, partial, or denied run blocks despite a newer success', async () => {
  for (const status of ['FAILED', 'PARTIAL', 'APPROVAL_DENIED']) {
    const client = fake({ items: [summary(), summary({ id: id(3), createdAt: START, status })] });
    await assert.rejects(verifyUpstreamFunding(client, config, options), evidenceCode('UPSTREAM_FUNDING_REQUIRES_REVIEW', true));
    assert.equal(client.calls.detail.length, 0);
  }
});

test('unfinished or approval-pending funding waits, while failure takes precedence', async () => {
  for (const status of ['IN_PROGRESS', 'APPROVAL_PENDING']) {
    await assert.rejects(verifyUpstreamFunding(fake({ items: [summary({ status })] }), config, options),
      evidenceCode('UPSTREAM_FUNDING_PENDING', false));
  }
  await assert.rejects(verifyUpstreamFunding(fake({ items: [summary({ status: 'IN_PROGRESS' }),
    summary({ id: id(3), status: 'FAILED' })] }), config, options), evidenceCode('UPSTREAM_FUNDING_REQUIRES_REVIEW', true));
});

test('latest detail accepts both no matched conditions and zero calculated transfers', async () => {
  for (const full of [
    detail({ conditionsNotMet: true, stepIndexMatched: null, transfersAttempted: 0, transfersCompleted: 0, transferIds: [] }),
    detail({ transfersAttempted: 3, transfersCompleted: 0, transferIds: [] }),
    detail({ transfersAttempted: 5 }),
  ]) assert.deepEqual(await verifyUpstreamFunding(fake({ full }), config, options), { checked: 1 });
});

test('latest detail cannot hide failed transfers or a provider error', async () => {
  for (const full of [detail({ transfersFailed: 1 }), detail({ errorMessage: 'synthetic upstream failure' }), detail({ status: 'PARTIAL' })]) {
    await assert.rejects(verifyUpstreamFunding(fake({ full }), config, options), evidenceCode('UPSTREAM_FUNDING_REQUIRES_REVIEW', true));
  }
});

test('latest detail with unsettled transfers or a scheduled retry waits', async () => {
  for (const full of [detail({ transfersPending: 1 }), detail({ nextAttemptAt: '2030-01-04T00:00:00Z' }), detail({ status: 'IN_PROGRESS' })]) {
    await assert.rejects(verifyUpstreamFunding(fake({ full }), config, options), evidenceCode('UPSTREAM_FUNDING_PENDING', false));
  }
});

test('latest detail validates counts, transfer IDs, and legitimate no-op consistency', async () => {
  for (const change of [
    { transfersAttempted: 1 }, { transfersCompleted: -1 }, { transfersPending: '0' },
    { transferIds: [id(10), id(10)] }, { transferIds: [id(10)] }, { transferIds: ['invalid', id(11)] },
    { conditionsNotMet: true }, { conditionsNotMet: 'false' }, { stepIndexMatched: null },
    { nextAttemptAt: undefined }, { errorMessage: undefined }, { transfersFailed: Number.NaN },
  ]) {
    await assert.rejects(verifyUpstreamFunding(fake({ full: detail(change) }), config, options),
      evidenceCode('UPSTREAM_COUNTS_INCONSISTENT', true));
  }
});

test('summary identity, execution mode, and window must match the requested funding rule', async () => {
  for (const change of [{ id: 'bad' }, { ruleId: id(99) }, { executionMode: 'SIMULATION' }]) {
    await assert.rejects(verifyUpstreamFunding(fake({ items: [summary(change)] }), config, options),
      evidenceCode('UPSTREAM_EXECUTION_IDENTITY_INVALID', true));
  }
  for (const createdAt of ['2029-12-31T23:59:59Z', '2030-01-04T00:00:00Z', '2030-02-30T00:00:00Z', '2030-01-02']) {
    await assert.rejects(verifyUpstreamFunding(fake({ items: [summary({ createdAt })] }), config, options),
      evidenceCode('UPSTREAM_EXECUTION_TIME_INVALID', true));
  }
  await assert.rejects(verifyUpstreamFunding(fake({ items: [summary({ status: 'UNKNOWN' })] }), config, options),
    evidenceCode('UPSTREAM_EXECUTION_STATUS_UNKNOWN', true));
});

test('missing, partial, and duplicate history never means no unresolved funding', async () => {
  for (const result of [{ complete: false, items: [] }, { items: [] }, { complete: true }]) {
    await assert.rejects(verifyUpstreamFunding({ async listRuleExecutions() { return result; } }, config, options),
      evidenceCode('INCOMPLETE_FUNDING_HISTORY', false));
  }
  await assert.rejects(verifyUpstreamFunding(fake({ items: [summary(), summary()] }), config, options),
    evidenceCode('UPSTREAM_HISTORY_CHANGED', false));
});

test('latest detail must identify the same execution and creation time as its summary', async () => {
  for (const full of [detail({ id: id(3) }), detail({ createdAt: START })]) {
    await assert.rejects(verifyUpstreamFunding(fake({ full }), config, options), evidenceCode('UPSTREAM_EXECUTION_CHANGED', true));
  }
});

test('many historical successful runs require just one additional detail request', async () => {
  const items = Array.from({ length: 100 }, (_, n) => summary({ id: id(100 + n), createdAt: new Date(NOW - n * 1000).toISOString() }));
  const client = fake({ items, full: detail({ ...items[0] }) });
  assert.deepEqual(await verifyUpstreamFunding(client, config, options), { checked: 100 });
  assert.equal(client.calls.detail.length, 1);
});

test('adapter exhausts execution pages with fixed rule, mode, and time filters', async () => {
  const calls = [];
  const client = api(async (url, init) => {
    const parsed = new URL(url), n = Number(parsed.searchParams.get('page'));
    calls.push({ url: parsed, init });
    return json(page([summary({ id: id(n + 1), createdAt: n === 1 ? '2030-01-02T00:00:00Z' : START })], n, n === 1));
  });
  const result = await client.listRuleExecutions({ ruleId: RULE, from: START });
  assert.equal(result.complete, true); assert.equal(result.items.length, 2);
  for (const { url, init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(url.pathname, `/platform/v1/rules/${RULE}/executions`);
    assert.equal(url.searchParams.get('from'), START);
    assert.equal(url.searchParams.get('to'), new Date(NOW).toISOString());
    assert.equal(url.searchParams.get('executionMode'), 'LIVE');
    assert.equal(url.searchParams.get('pageSize'), '100');
  }
});

test('adapter rejects wrong rule, unexpected mode, malformed timestamps and unordered summaries', async () => {
  for (const row of [summary({ ruleId: id(99) }), summary({ executionMode: 'SIMULATION' }),
    summary({ createdAt: '2030-02-30T00:00:00Z' }), summary({ createdAt: '2031-01-01T00:00:00Z' }),
    summary({ status: 'UNKNOWN' })]) {
    await assert.rejects(api(async () => json(page([row], 1, false))).listRuleExecutions({ ruleId: RULE }), apiCode('INVALID_RESPONSE'));
  }
  await assert.rejects(api(async () => json(page([summary({ id: id(3), createdAt: START }), summary()], 1, false)))
    .listRuleExecutions({ ruleId: RULE }), apiCode('INVALID_RESPONSE'));
});

test('adapter requires explicit pagination and fails on repeated execution IDs', async () => {
  for (const bad of [{ items: [] }, { items: [], pagination: { page: 1, pageSize: 100 } }, page([], 1, true), page([], 2, false)]) {
    await assert.rejects(api(async () => json(bad)).listRuleExecutions({ ruleId: RULE }), apiCode('INVALID_RESPONSE'));
  }
  let count = 0;
  await assert.rejects(api(async () => json(page([summary()], ++count, count === 1)))
    .listRuleExecutions({ ruleId: RULE }), apiCode('PAGINATION_UNSTABLE'));
});

test('adapter enforces page and request ceilings instead of returning partial history', async () => {
  let count = 0;
  const client = api(async () => {
    count += 1;
    return json(page([summary({ id: id(100 + count), createdAt: new Date(NOW - count).toISOString() })], count, true));
  }, { maxRequests: 101 });
  await assert.rejects(client.listRuleExecutions({ ruleId: RULE }), apiCode('PAGINATION_LIMIT'));
  assert.equal(count, 100);
  const limited = api(async () => json(page([summary()], 1, false)), { maxRequests: 1 });
  await assert.rejects(verifyUpstreamFunding(limited, config, options), apiCode('REQUEST_BUDGET_EXCEEDED'));
});

test('invalid execution queries are rejected before any request', async () => {
  let count = 0;
  const client = api(async () => { count += 1; });
  for (const query of [{ ruleId: 'bad' }, { ruleId: RULE, from: '2031-01-01T00:00:00Z' },
    { ruleId: RULE, executionMode: 'invalid' }, { ruleId: RULE, url: 'https://example.invalid' }]) {
    await assert.rejects(client.listRuleExecutions(query), apiCode('INVALID_INPUT'));
  }
  assert.equal(count, 0);
});
