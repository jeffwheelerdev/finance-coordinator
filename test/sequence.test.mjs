import test from 'node:test';
import assert from 'node:assert/strict';
import { SequenceClient, SequenceError } from '../lib/sequence.mjs';

// Every identity, amount and credential in this file is a synthetic fixture.
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = ID(1);
const DESTINATION = ID(2);
const RULE = ID(3);
const EXECUTION = ID(4);
const KEY = ID(5);
const NOW = Date.parse('2030-01-02T12:00:00.000Z');
const API_KEY = 'test-only-sequence-adapter-credential';
const endpoint = 'https://api.getsequence.io/platform/v1';

function json(data, status = 200, headers = {}) {
  return Response.json({ data, requestId: 'test-request' }, { status, headers });
}

function errorResponse(code, status, headers = {}) {
  return Response.json({ error: { code, message: `Untrusted provider message ${API_KEY}` } }, { status, headers });
}

function transfer(overrides = {}) {
  return {
    id: ID(10), amountInCents: 296_295, executionMode: 'LIVE',
    status: 'PENDING', source: { id: SOURCE }, destination: { id: DESTINATION },
    completedAt: null, ...overrides,
  };
}

function externalTransaction(overrides = {}) {
  return { id: ID(30), accountId: SOURCE, amountInCents: 12345, direction: 'MONEY_IN', status: 'COMPLETE',
    description: 'Synthetic deposit', merchantName: null, category: 'Income',
    transactionDate: '2030-01-01T12:00:00.000Z', ...overrides };
}

function intent(overrides = {}) {
  return {
    idempotencyKey: KEY,
    request: {
      sourceAccountId: SOURCE, destinationAccountId: DESTINATION,
      amountInCents: 98_765 * 3, description: 'TOPUP',
      reasonForApproval: 'Synthetic funding intent after a settled refund.',
    },
    firstAttemptAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function client(fetchImpl, overrides = {}) {
  return new SequenceClient({ apiKey: API_KEY, fetchImpl, now: () => NOW, ...overrides });
}

function liveClient(fetchImpl, overrides = {}) {
  return client(fetchImpl, { liveEnabled: true,
    allowedPairs: [{ sourceAccountId: SOURCE, destinationAccountId: DESTINATION }], ...overrides });
}

function page(items, number, hasNextPage, extra = {}) {
  return { items, pagination: { page: number, pageSize: 100, hasNextPage }, ...extra };
}

function hasCode(code, uncertain) {
  return (error) => error instanceof SequenceError && error.code === code &&
    (uncertain === undefined || error.uncertain === uncertain);
}

test('GET contracts use fixed paths, bearer authorization and data envelopes', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith(`/rules/${RULE}/executions/${EXECUTION}`)) return json({ id: EXECUTION, ruleId: RULE });
    return json({ id: new URL(url).pathname.split('/').at(-1) });
  };
  const api = client(fetchImpl);
  assert.equal((await api.getAccount(SOURCE)).id, SOURCE);
  assert.equal((await api.getTransfer(ID(10))).id, ID(10));
  assert.equal((await api.getRule(RULE)).id, RULE);
  assert.equal((await api.getRuleExecution(RULE, EXECUTION)).ruleId, RULE);
  assert.deepEqual(calls.map((call) => call.url), [
    `${endpoint}/accounts/${SOURCE}`, `${endpoint}/transfers/${ID(10)}`,
    `${endpoint}/rules/${RULE}`, `${endpoint}/rules/${RULE}/executions/${EXECUTION}`,
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(JSON.stringify(api), '{}');
});

test('invalid resource paths and credentials fail without fetching', () => {
  let calls = 0;
  const api = client(async () => { calls += 1; });
  for (const id of ['../../transfers', 'https://example.invalid', '', null]) {
    assert.throws(() => api.getAccount(id), hasCode('INVALID_INPUT'));
  }
  assert.throws(() => new SequenceClient({ apiKey: '' }), hasCode('CONFIGURATION_REQUIRED'));
  assert.throws(() => new SequenceClient({ apiKey: 'test\r\nInjected: yes' }), hasCode('CONFIGURATION_REQUIRED'));
  assert.equal(calls, 0);
});

test('resource identity and parent execution identity must match', async () => {
  await assert.rejects(client(async () => json({ id: ID(99) })).getAccount(SOURCE), hasCode('INVALID_RESPONSE'));
  await assert.rejects(client(async () => json({ id: EXECUTION, ruleId: ID(99) })).getRuleExecution(RULE, EXECUTION), hasCode('INVALID_RESPONSE'));
});

test('transfer pagination consumes every explicit page and preserves fixed filters', async () => {
  const urls = [];
  const api = client(async (url) => {
    urls.push(new URL(url));
    const number = Number(new URL(url).searchParams.get('page'));
    return json(page([transfer({ id: ID(20 + number) })], number, number === 1));
  });
  const result = await api.listTransfers({ accountIds: [SOURCE, DESTINATION],
    from: '2030-01-01T00:00:00.000Z', ruleExecutionId: EXECUTION, status: 'PENDING' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.id), [ID(21), ID(22)]);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.origin, 'https://api.getsequence.io');
    assert.equal(url.pathname, '/platform/v1/transfers');
    assert.deepEqual(url.searchParams.getAll('accountIds[]'), [SOURCE, DESTINATION]);
    assert.equal(url.searchParams.get('pageSize'), '100');
    assert.equal(url.searchParams.get('executionMode'), 'LIVE');
    assert.equal(url.searchParams.get('ruleExecutionId'), EXECUTION);
    assert.equal(url.searchParams.get('status'), 'PENDING');
    assert.equal(url.searchParams.get('to'), new Date(NOW).toISOString());
  }
});

test('pagination requires explicit boolean hasNextPage and consistent page metadata', async (t) => {
  const cases = [
    { items: [], pagination: { page: 1, pageSize: 100 } },
    { items: [], pagination: { page: 1, pageSize: 100, hasNextPage: 'false' } },
    page([], 2, false),
    page([], 1, true),
    { items: [], pagination: { page: 1, pageSize: 101, hasNextPage: false } },
  ];
  for (const [index, data] of cases.entries()) {
    await t.test(`invalid pagination ${index}`, async () => {
      await assert.rejects(client(async () => json(data)).listTransfers({ accountIds: [SOURCE] }), hasCode('INVALID_RESPONSE'));
    });
  }
});

test('repeated IDs and simulation rows in a live result fail closed', async () => {
  let number = 0;
  const api = client(async () => json(page([transfer()], ++number, number === 1)));
  await assert.rejects(api.listTransfers({ accountIds: [SOURCE] }), hasCode('PAGINATION_UNSTABLE'));
  await assert.rejects(client(async () => json(page([transfer({ executionMode: 'SIMULATION' })], 1, false)))
    .listTransfers({ accountIds: [SOURCE] }), hasCode('INVALID_RESPONSE'));
});

test('explicit ALL mode can read both modes without initiating simulations', async () => {
  let method;
  const api = client(async (url, options) => {
    method = options.method;
    assert.equal(new URL(url).searchParams.get('executionMode'), 'ALL');
    return json(page([transfer(), transfer({ id: ID(11), executionMode: 'SIMULATION' })], 1, false));
  });
  assert.equal((await api.listTransfers({ accountIds: [SOURCE], executionMode: 'ALL' })).items.length, 2);
  assert.equal(method, 'GET');
});

test('pagination has a hard page ceiling and never returns partial success', async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return json(page([transfer({ id: ID(1000 + calls) })], calls, true));
  }, { maxRequests: 101 });
  await assert.rejects(api.listTransfers({ accountIds: [SOURCE] }), hasCode('PAGINATION_LIMIT'));
  assert.equal(calls, 100);
});

test('external transactions preserve complete window metadata', async () => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: false };
  let calls = 0;
  const api = client(async (url) => {
    calls += 1;
    const params = new URL(url).searchParams;
    assert.equal(params.get('executionMode'), null);
    assert.equal(params.get('direction'), 'MONEY_IN');
    return json(page([externalTransaction({ id: ID(30 + calls) })], calls, calls === 1, { window }));
  });
  const result = await api.listExternalTransactions({ accountIds: [SOURCE], from: window.from,
    to: window.to, direction: 'MONEY_IN', status: 'COMPLETE' });
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.window, window);
});

test('external date-window truncation or missing metadata cannot masquerade as complete', async () => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: true };
  await assert.rejects(client(async () => json(page([], 1, false, { window })))
    .listExternalTransactions({ accountIds: [SOURCE] }), hasCode('TRUNCATED_WINDOW'));
  await assert.rejects(client(async () => json(page([], 1, false)))
    .listExternalTransactions({ accountIds: [SOURCE] }), hasCode('INVALID_RESPONSE'));
  await assert.rejects(client(async () => json(page([], 1, false, { window: { ...window, truncated: false } })))
    .listExternalTransactions({ accountIds: [SOURCE], from: '2029-12-31T00:00:00.000Z' }), hasCode('INVALID_RESPONSE'));
});

test('external transactions must belong to the frozen requested accounts, filters and date window', async t => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: false };
  for (const change of [
    { accountId: ID(99) }, { accountId: 'invalid' }, { direction: 'MONEY_OUT' }, { status: 'PENDING' },
    { transactionDate: '2029-12-31T23:59:59.000Z' }, { transactionDate: '2030-01-02T12:00:00.001Z' },
    { transactionDate: '2030-02-31T00:00:00.000Z' }, { transactionDate: '2030-01-01' },
    { amountInCents: -1 }, { amountInCents: 1.5 }, { amountInCents: Number.MAX_SAFE_INTEGER + 1 },
    { description: undefined }, { merchantName: [] }, { category: {} },
  ]) await t.test(JSON.stringify(change), async () => {
    const api = client(async () => json(page([externalTransaction(change)], 1, false, { window })));
    await assert.rejects(api.listExternalTransactions({ accountIds: [SOURCE], from: window.from,
      to: window.to, direction: 'MONEY_IN', status: 'COMPLETE' }), hasCode('INVALID_RESPONSE'));
  });
});

test('external history preserves explicit null metadata and integer-zero rows without classifying income', async () => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: false };
  const item = externalTransaction({ amountInCents: 0, description: null, merchantName: null, category: null });
  const api = client(async () => json(page([item], 1, false, { window })));
  assert.deepEqual((await api.listExternalTransactions({ accountIds: [SOURCE], from: window.from })).items, [item]);
});

test('external pagination rejects repeated or changed identities and reversed ordering', async t => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: false };
  for (const [name, second, code] of [
    ['repeated', externalTransaction(), 'PAGINATION_UNSTABLE'],
    ['changed amount', externalTransaction({ amountInCents: 54321 }), 'PAGINATION_UNSTABLE'],
    ['newer later page', externalTransaction({ id: ID(31), transactionDate: '2030-01-02T00:00:00.000Z' }), 'INVALID_RESPONSE'],
  ]) await t.test(name, async () => {
    let calls = 0;
    const api = client(async () => json(page([++calls === 1 ? externalTransaction() : second], calls, calls === 1, { window })));
    await assert.rejects(api.listExternalTransactions({ accountIds: [SOURCE], from: window.from }), hasCode(code));
  });
});

test('external request filters and provider bounds cannot change between pages', async t => {
  const window = { from: '2030-01-01T00:00:00.000Z', to: new Date(NOW).toISOString(), truncated: false };
  await t.test('frozen caller input', async () => {
    const options = { accountIds: [SOURCE], from: window.from, to: window.to };
    let calls = 0;
    const api = client(async url => {
      calls += 1;
      assert.deepEqual(new URL(url).searchParams.getAll('accountIds[]'), [SOURCE]);
      assert.equal(new URL(url).searchParams.get('from'), window.from);
      assert.equal(new URL(url).searchParams.get('to'), window.to);
      options.accountIds.push(DESTINATION); options.from = '2029-01-01T00:00:00.000Z';
      return json(page([externalTransaction({ id: ID(30 + calls) })], calls, calls === 1, { window }));
    });
    assert.equal((await api.listExternalTransactions(options)).items.length, 2);
  });
  await t.test('provider narrowing', async () => {
    let calls = 0;
    const api = client(async () => {
      calls += 1;
      return json(page([externalTransaction({ id: ID(30 + calls) })], calls, calls === 1,
        { window: { ...window, from: calls === 1 ? window.from : '2030-01-01T01:00:00.000Z' } }));
    });
    await assert.rejects(api.listExternalTransactions({ accountIds: [SOURCE], from: window.from }), hasCode('INVALID_RESPONSE'));
  });
});

test('invalid list filters do not reach the network', async (t) => {
  let calls = 0;
  const api = client(async () => { calls += 1; });
  for (const options of [
    { accountIds: [] }, { accountIds: ['bad'] },
    { accountIds: [SOURCE], url: 'https://example.invalid' },
    { accountIds: [SOURCE], status: 'UNKNOWN' },
    { accountIds: [SOURCE], executionMode: 'anything' },
    { accountIds: [SOURCE], from: '2030-02-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
  ]) {
    await t.test('reject unsupported or invalid filter', async () => {
      await assert.rejects(api.listTransfers(options), hasCode('INVALID_INPUT'));
    });
  }
  assert.equal(calls, 0);
});

test('writes are disabled by default and pair authorization is directional', async () => {
  let calls = 0;
  const fake = async () => { calls += 1; return json(transfer(), 201); };
  await assert.rejects(client(fake).createTransfer(intent()), hasCode('LIVE_DISABLED', false));
  await assert.rejects(liveClient(fake, { allowedPairs: [[DESTINATION, SOURCE]] }).createTransfer(intent()), hasCode('PAIR_NOT_ALLOWED', false));
  await assert.rejects(liveClient(fake, { allowedPairs: [] }).createTransfer(intent()), hasCode('PAIR_NOT_ALLOWED', false));
  assert.equal(calls, 0);
});

test('constructor snapshots allowed pairs against later caller mutation', async () => {
  const pairs = [{ sourceAccountId: SOURCE, destinationAccountId: DESTINATION }];
  const api = liveClient(async () => json(transfer(), 201), { allowedPairs: pairs });
  pairs[0].destinationAccountId = ID(99);
  pairs.push({ sourceAccountId: SOURCE, destinationAccountId: ID(98) });
  assert.equal((await api.createTransfer(intent())).id, ID(10));
  const other = intent();
  other.request.destinationAccountId = ID(98);
  await assert.rejects(api.createTransfer(other), hasCode('PAIR_NOT_ALLOWED'));
});

test('exact-amount POST supports an arbitrary configured target and sends only documented fields', async () => {
  const calls = [];
  const api = liveClient(async (url, options) => {
    calls.push({ url, options });
    return json(transfer(), 201);
  });
  const input = intent();
  const result = await api.createTransfer(input);
  assert.equal(result.amountInCents, 98_765 * 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${endpoint}/transfers`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['idempotency-key'], KEY);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), input.request);
  assert.equal(JSON.parse(calls[0].options.body).simulation, undefined);
});

test('request body is snapshotted and canonically ordered before the fetch await', async () => {
  const input = intent();
  const original = structuredClone(input.request);
  const bodies = [];
  const api = liveClient(async (_url, options) => {
    bodies.push(options.body);
    input.request.amountInCents = 999;
    input.idempotencyKey = ID(99);
    return json(transfer(), 201);
  });
  await api.createTransfer(input);
  assert.deepEqual(JSON.parse(bodies[0]), original);
  const reordered = intent({ request: Object.fromEntries(Object.entries(original).reverse()) });
  await api.createTransfer(reordered);
  assert.equal(bodies[0], bodies[1]);
});

test('approval-pending is a normal resource, not a reason to resend', async () => {
  let calls = 0;
  const api = liveClient(async () => {
    calls += 1;
    return json(transfer({ status: 'APPROVAL_PENDING', approvalUrl: 'https://app.getsequence.io/?approvalTransferId=test' }), 201);
  });
  assert.equal((await api.createTransfer(intent())).status, 'APPROVAL_PENDING');
  assert.equal(calls, 1);
});

test('invalid amounts, unsafe fields, labels and accessor fields are blocked before POST', async (t) => {
  let calls = 0;
  const api = liveClient(async () => { calls += 1; });
  const changes = [
    { amountInCents: 99 }, { amountInCents: 100.5 }, { amountInCents: Infinity },
    { amountInCents: Number.MAX_SAFE_INTEGER + 1 }, { amountInCents: '100' },
    { sourceAccountId: DESTINATION }, { description: 'LABEL_TOO_LONG' },
    { description: 'NO/DOTS' }, { simulation: true }, { simulatedSourceBalance: 999999 },
    { endpoint: 'https://example.invalid' }, { reasonForApproval: {} },
  ];
  for (const change of changes) {
    await t.test(`reject ${Object.keys(change)[0]}`, async () => {
      const input = intent();
      Object.assign(input.request, change);
      await assert.rejects(api.createTransfer(input), hasCode('INVALID_INPUT'));
    });
  }
  const input = intent();
  Object.defineProperty(input.request, 'amountInCents', { get: () => 100 });
  await assert.rejects(api.createTransfer(input), hasCode('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('idempotency key must be UUIDv4 and retry age must be less than 23 hours', async (t) => {
  let calls = 0;
  const api = liveClient(async () => { calls += 1; return json(transfer(), 201); });
  for (const [name, overrides, code] of [
    ['non-UUID', { idempotencyKey: 'do-not-use-a-new-key' }, 'INVALID_INPUT'],
    ['wrong UUID version', { idempotencyKey: '00000000-0000-1000-8000-000000000005' }, 'INVALID_INPUT'],
    ['old key', { firstAttemptAt: new Date(NOW - 23 * 3600000).toISOString() }, 'IDEMPOTENCY_WINDOW_EXPIRED'],
    ['future intent', { firstAttemptAt: new Date(NOW + 1).toISOString() }, 'INVALID_INPUT'],
    ['missing timezone', { firstAttemptAt: '2030-01-02' }, 'INVALID_INPUT'],
    ['invalid calendar date', { firstAttemptAt: '2029-02-30T12:00:00Z' }, 'INVALID_INPUT'],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(api.createTransfer(intent(overrides)), hasCode(code, false));
    });
  }
  assert.equal(calls, 0);
  await api.createTransfer(intent({ firstAttemptAt: new Date(NOW - 23 * 3600000 + 1).toISOString() }));
  assert.equal(calls, 1);
});

test('network errors are redacted and uncertain writes are never automatically retried', async () => {
  let calls = 0;
  const api = liveClient(async () => { calls += 1; throw new Error(`Connection failed: ${API_KEY}`); });
  await assert.rejects(api.createTransfer(intent()), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.uncertain, true);
    assert.ok(!String(error).includes(API_KEY));
    assert.ok(!JSON.stringify(error).includes(API_KEY));
    return true;
  });
  assert.equal(calls, 1);
});

test('coordinator-controlled retries retain the original key and frozen body', async () => {
  const calls = [];
  const api = liveClient(async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) throw new Error('synthetic timeout outcome');
    return json(transfer(), 201);
  });
  const saved = intent();
  await assert.rejects(api.createTransfer(saved), hasCode('NETWORK_ERROR', true));
  assert.equal(calls.length, 1);
  await api.createTransfer(saved);
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
  assert.equal(calls[0].body, calls[1].body);
});

test('HTTP errors preserve stable codes and distinguish uncertain from rejected writes', async (t) => {
  for (const [status, code, uncertain] of [
    [400, 'IDEMPOTENCY_KEY_MISMATCH', false], [401, 'UNAUTHORIZED', false],
    [403, 'ACCESS_DENIED', false], [404, 'TRANSFER_NOT_FOUND', false],
    [409, 'TRANSFER_IN_PROGRESS', true], [500, 'UNEXPECTED_ERROR', true],
    [503, 'UNEXPECTED_ERROR', true], [429, 'RATE_LIMIT_EXCEEDED', false],
  ]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const api = liveClient(async () => { calls += 1; return errorResponse(code, status, { 'retry-after': '7' }); });
      await assert.rejects(api.createTransfer(intent()), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.uncertain, uncertain);
        assert.equal(error.retryAfter, 7);
        assert.ok(!String(error).includes(API_KEY));
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test('HTTP-date Retry-After is returned in seconds without sleeping or retrying', async () => {
  const api = client(async () => errorResponse('RATE_LIMIT_EXCEEDED', 429, {
    'retry-after': new Date(NOW + 120000).toUTCString(),
  }));
  await assert.rejects(api.getAccount(SOURCE), (error) => error.retryAfter === 120 && error.uncertain === false);
});

test('malformed or credential-bearing provider errors do not leak response text', async () => {
  await assert.rejects(client(async () => new Response(API_KEY, { status: 500 })).getAccount(SOURCE), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.ok(!String(error).includes(API_KEY));
    return true;
  });
  const key = 'SYNTHETICSECRET';
  await assert.rejects(client(async () => errorResponse(key, 400), { apiKey: key }).getAccount(SOURCE), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
});

test('redirect responses and unexpected response origins are rejected', async () => {
  const redirect = liveClient(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('', { status: 302, headers: { Location: 'https://example.invalid' } });
  });
  await assert.rejects(redirect.createTransfer(intent()), hasCode('REDIRECT_REJECTED', true));
  const wrongOrigin = client(async () => {
    const response = json({ id: SOURCE });
    Object.defineProperty(response, 'url', { value: 'https://example.invalid/accounts' });
    return response;
  });
  await assert.rejects(wrongOrigin.getAccount(SOURCE), hasCode('REDIRECT_REJECTED', false));
});

test('response body limits apply to both declared length and streamed bytes', async () => {
  const declared = client(async () => json({ id: SOURCE }, 200, { 'content-length': '2000001' }));
  await assert.rejects(declared.getAccount(SOURCE), hasCode('RESPONSE_TOO_LARGE', false));
  const streamed = liveClient(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1_000_000));
      controller.enqueue(new Uint8Array(1_000_001));
      controller.close();
    },
  }), { status: 201 }));
  await assert.rejects(streamed.createTransfer(intent()), hasCode('RESPONSE_TOO_LARGE', true));
});

test('successful malformed or mismatched write responses remain uncertain', async (t) => {
  for (const record of [
    {}, transfer({ amountInCents: 100 }), transfer({ source: { id: ID(99) } }),
    transfer({ destination: { id: ID(99) } }), transfer({ executionMode: 'SIMULATION' }),
    transfer({ status: 'COMPLETE', completedAt: null }), transfer({ status: 'NEW_UNKNOWN_STATE' }),
    transfer({ status: 'COMPLETE', completedAt: '1' }),
  ]) {
    await t.test('refuse an unverifiable write outcome', async () => {
      await assert.rejects(liveClient(async () => json(record, 201)).createTransfer(intent()), hasCode('INVALID_RESPONSE', true));
    });
  }
  await assert.rejects(liveClient(async () => new Response('not json', { status: 201 }))
    .createTransfer(intent()), hasCode('INVALID_RESPONSE', true));
});

test('request budgets and pre-request deadlines block before a write', async () => {
  let calls = 0;
  const api = liveClient(async () => { calls += 1; return json({ id: SOURCE }); }, { maxRequests: 1 });
  await api.getAccount(SOURCE);
  await assert.rejects(api.createTransfer(intent()), hasCode('REQUEST_BUDGET_EXCEEDED', false));
  assert.equal(calls, 1);
  const expired = liveClient(async () => { calls += 1; }, { deadlineAt: NOW });
  await assert.rejects(expired.createTransfer(intent()), hasCode('DEADLINE_EXCEEDED', false));
  assert.equal(calls, 1);
});

test('timeout is bounded even when injected fetch ignores AbortSignal', async () => {
  let calls = 0;
  const api = liveClient(async () => { calls += 1; return new Promise(() => {}); }, { timeoutMs: 5 });
  await assert.rejects(api.createTransfer(intent()), hasCode('REQUEST_TIMEOUT', true));
  assert.equal(calls, 1);
});
