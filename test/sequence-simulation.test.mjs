import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, withCalculatedBillsTarget } from '../lib/config.mjs';
import { runSequenceSimulation, assertSequenceSimulationAllowed, SequenceSimulationError } from '../lib/sequence-simulation.mjs';
import { verifySequenceSimulation } from '../scripts/simulate-sequence.mjs';
import { ID, TEST_NOW, makeRothPolicy, asISO } from './fixtures.mjs';

const ENDPOINT = 'https://api.getsequence.io/platform/v1/transfers';
const KEY = 'synthetic-private-provider-key';
const envFor = (change = {}) => ({
  APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', RUN_SEQUENCE_SIMULATION: 'true', SEQUENCE_API_KEY: KEY,
  FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ income: ID(1), pod: ID(2), general: ID(3), bills: ID(4) }),
  FINANCE_RULE_IDS_JSON: JSON.stringify({ payout: ID(11), funding: ID(12), legacyGeneral: ID(13) }),
  GENERAL_SPENDING_MONTHLY_BUDGET: '750', GENERAL_SPENDING_RESERVE_MONTHS: '3', INCOME_RESERVE: '0',
  FINANCE_ALLOCATIONS_JSON: '[]', MONTHLY_PRIORITY_ENABLED: 'true', ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: ID(30),
  EMERGENCY_ACCOUNT_ID: ID(5), PROJECT_ACCOUNT_ID: ID(6), PERSONAL_INVESTMENT_ACCOUNT_ID: ID(7),
  EMERGENCY_EXCESS_RULE_ID: ID(14), ...change,
});
function configFor(env = envFor()) {
  return withCalculatedBillsTarget(loadConfig(env), { targetCents: 350000, catalogHash: 'a'.repeat(64),
    year: 2030, effectiveDate: '2030-01-02', catalogUpdatedAt: asISO(TEST_NOW - 1000), peakMonthCents: 340000 });
}
const json = (data, status = 201, headers = {}) => new Response(JSON.stringify({ data }), { status,
  headers: { 'Content-Type': 'application/json', ...headers } });
function responseFor(body, index = 1, changes = {}) {
  return json({ id: ID(100 + index), source: { id: body.sourceAccountId }, destination: { id: body.destinationAccountId },
    amountInCents: body.amountInCents, executionMode: 'SIMULATION', status: 'COMPLETE',
    completedAt: asISO(TEST_NOW), errorCode: null, ...changes });
}
function setup(overrides = {}) {
  const env = envFor(), config = configFor(env), calls = [];
  let sequence = 200;
  const options = { env, config, rothPolicy: makeRothPolicy(), now: () => TEST_NOW, uuid: () => ID(++sequence),
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      calls.push({ url, request, body });
      return responseFor(body, calls.length);
    }, ...overrides };
  return { options, calls };
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof SequenceSimulationError && error.code === code);
const lastCode = receipt => receipt.results.at(-1).code;

test('seven exact configured pairs use hardcoded simulation and synthetic cash with no public identifiers', async () => {
  const s = setup(), receipt = await runSequenceSimulation(s.options);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.requestCount, 7);
  assert.deepEqual(s.calls.map(row => row.body.amountInCents), [350000, 225000, 1000000, 62500, 25000, 400000, 2500]);
  assert.deepEqual(s.calls.map(row => [row.body.sourceAccountId, row.body.destinationAccountId]),
    [[1, 4], [1, 3], [1, 5], [1, 30], [1, 6], [1, 7], [5, 1]].map(pair => pair.map(ID)));
  for (const { url, request, body } of s.calls) {
    assert.equal(url, ENDPOINT); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.equal(body.simulation, true); assert.equal(body.simulatedSourceBalance, body.amountInCents);
    assert.deepEqual(Object.keys(body).sort(), ['amountInCents', 'description', 'destinationAccountId', 'simulatedSourceBalance', 'simulation', 'sourceAccountId']);
    assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
    assert.match(request.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
    assert.equal(body.description, 'SIM TEST');
  }
  assert.equal(new Set(s.calls.map(row => row.request.headers['idempotency-key'])).size, 7);
  assert.ok(receipt.results.every(row => row.executionMode === 'SIMULATION' && row.providerStatus === 'COMPLETE'));
  assert.equal(receipt.realTransferRequested, false);
  assert.equal(receipt.limitations.unattendedApprovalProven, false);
  assert.equal(receipt.limitations.unlimitedAuthorityProven, false);
  assert.equal(receipt.limitations.bankingRailsTested, false);
  assert.equal(receipt.limitations.applicationLedgerModified, false);
  const serialized = JSON.stringify(receipt);
  for (const privateValue of [KEY, ID(1), ID(30), ID(101), ID(201)]) assert.ok(!serialized.includes(privateValue));
});

test('explicit opt-in and both inactive environment settings are required before any network call', async t => {
  for (const [field, values, code] of [
    ['RUN_SEQUENCE_SIMULATION', [undefined, '', 'false', 'TRUE', true, 1], 'SIMULATION_OPT_IN_REQUIRED'],
    ['APP_MODE', [undefined, '', 'live', 'OBSERVE'], 'SIMULATION_INACTIVE_MODE_REQUIRED'],
    ['LIVE_TRANSFERS_ENABLED', [undefined, '', 'true', false, 0], 'SIMULATION_INACTIVE_MODE_REQUIRED'],
  ]) for (const value of values) await t.test(`${field}:${String(value)}`, async () => {
    const s = setup(); s.options.env[field] = value;
    await rejects(runSequenceSimulation(s.options), code);
    assert.equal(s.calls.length, 0);
  });
  for (const change of [{ mode: 'live' }, { liveEnabled: true }, { liveEnabled: undefined }]) {
    const s = setup(); Object.assign(s.options.config, change);
    await rejects(runSequenceSimulation(s.options), 'SIMULATION_INACTIVE_MODE_REQUIRED');
    assert.equal(s.calls.length, 0);
  }
});

test('a caller cannot supply or omit a live/simulation request-body override', async t => {
  for (const change of [{ simulation: false }, { simulation: true }, { simulation: undefined },
    { simulatedSourceBalance: 0 }, { request: {} }, { endpoint: 'https://example.invalid' },
    { sourceAccountId: ID(90) }, { allowedPairs: [] }, { maxRequests: 8 }]) await t.test(Object.keys(change)[0], async () => {
    const s = setup(); await rejects(runSequenceSimulation({ ...s.options, ...change }), 'SIMULATION_INPUT_INVALID');
    assert.equal(s.calls.length, 0);
  });
  const s = setup(); let getterCalled = false;
  Object.defineProperty(s.options, 'simulation', { get: () => { getterCalled = true; return false; } });
  await rejects(runSequenceSimulation(s.options), 'SIMULATION_INPUT_INVALID');
  assert.equal(getterCalled, false); assert.equal(s.calls.length, 0);
});

test('synthetic amounts follow arbitrary configured targets and the verified statutory preview', async () => {
  const s = setup(); s.options.config.allocations[1].targetCents = 98765 * 3;
  s.options.config.monthly.emergencyTargetCents = 1234567;
  s.options.rothPolicy = makeRothPolicy(2030, { annualCents: 800000 });
  s.options.rothPolicy.years[0].eligibility = { status: 'unverified' };
  s.options.rothPolicy.years[0].outsideContributions = { status: 'unverified' };
  const receipt = await runSequenceSimulation(s.options);
  assert.equal(receipt.status, 'passed');
  assert.equal(s.calls[1].body.amountInCents, 296295);
  assert.equal(s.calls[2].body.amountInCents, 1234567);
  assert.equal(s.calls[3].body.amountInCents, 66666);
  assert.equal(receipt.limitations.rothEligibilityProven, false);
  const zero = setup(); zero.options.config.allocations[1].targetCents = 0;
  await runSequenceSimulation(zero.options); assert.equal(zero.calls[1].body.amountInCents, 100);
});

test('missing current statutory evidence never silently defaults to a 625-dollar probe', async () => {
  for (const policy of [null, { ...makeRothPolicy(), statutoryLimits: [] }, makeRothPolicy(2031)]) {
    const s = setup({ rothPolicy: policy });
    await rejects(runSequenceSimulation(s.options), 'SIMULATION_ROTH_POLICY_UNVERIFIED');
    assert.equal(s.calls.length, 0);
  }
});

test('invalid or overlapping configured pairs and unsafe amounts fail before the first POST', async t => {
  const cases = [
    c => { c.accounts.income = 'invalid'; }, c => { c.monthly.projectAccountId = c.accounts.pod; },
    c => { c.monthly.personalAccountId = c.roth.accountId; }, c => { c.monthly.enabled = false; },
    c => { c.allocations[0].destinationAccountId = ID(90); }, c => { c.allocations[1].enabled = false; },
    c => { c.allocations[0].targetCents = 350001; }, c => { c.calculatedBillsTarget.targetCents = 400000; },
    c => { c.allocations[1].targetCents = -1; }, c => { c.monthly.emergencyTargetCents = 1.5; },
    c => { c.allocations[1].targetCents = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const [index, change] of cases.entries()) await t.test(String(index), async () => {
    const s = setup(); change(s.options.config);
    await rejects(runSequenceSimulation(s.options), 'SIMULATION_CONFIGURATION_INVALID');
    assert.equal(s.calls.length, 0);
  });
});

test('inconsistent provider mode, identity, amount, status, and completion cannot count as successful probes', async t => {
  const cases = [
    [{ executionMode: 'LIVE' }, 'SIMULATION_MODE_MISMATCH'],
    [{ executionMode: undefined }, 'SIMULATION_MODE_MISMATCH'],
    [{ id: 'not-an-id' }, 'SIMULATION_IDENTITY_MISMATCH'],
    [{ source: { id: ID(99) } }, 'SIMULATION_IDENTITY_MISMATCH'],
    [{ destination: { id: ID(99) } }, 'SIMULATION_IDENTITY_MISMATCH'],
    [{ amountInCents: 100 }, 'SIMULATION_IDENTITY_MISMATCH'],
    [{ status: 'APPROVAL_PENDING' }, 'SIMULATION_STATUS_INVALID'],
    [{ status: 'PROCESSING' }, 'SIMULATION_STATUS_INVALID'],
    [{ completedAt: null }, 'SIMULATION_RESPONSE_INVALID'],
    [{ completedAt: '2030-02-31T12:00:00Z' }, 'SIMULATION_RESPONSE_INVALID'],
    [{ errorCode: 'UNEXPECTED_ERROR' }, 'SIMULATION_RESPONSE_INVALID'],
  ];
  for (const [changes, code] of cases) await t.test(code + JSON.stringify(changes), async () => {
    let calls = 0; const s = setup({ fetchImpl: async (_url, request) => {
      calls += 1; return responseFor(JSON.parse(request.body), calls, changes);
    } });
    const receipt = await runSequenceSimulation(s.options);
    assert.equal(receipt.status, 'failed'); assert.equal(lastCode(receipt), code);
    assert.equal(calls, 1); assert.equal(receipt.notAttemptedCount, 6);
    assert.ok(!JSON.stringify(receipt).includes(ID(99)));
  });
});

test('terminal simulation failures stop the sequence without retry or reporting success', async () => {
  for (const status of ['INCOMPLETE', 'ERROR']) {
    const s = setup({ fetchImpl: async (_url, request) => responseFor(JSON.parse(request.body), 1,
      { status, completedAt: null, errorCode: 'INSUFFICIENT_FUNDS' }) });
    const receipt = await runSequenceSimulation(s.options);
    assert.equal(receipt.requestCount, 1); assert.equal(lastCode(receipt), 'SIMULATION_TRANSFER_FAILED');
    assert.equal(receipt.results[0].providerCode, 'INSUFFICIENT_FUNDS');
  }
});

test('provider errors disclose only allowlisted codes and never credentials, account IDs, or response text', async t => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'ACCESS_DENIED'], [403, 'MAXIMUM_AMOUNT_EXCEEDED'],
    [429, 'RATE_LIMIT_EXCEEDED'], [500, 'UNEXPECTED_ERROR'], [400, KEY], [400, ID(1)]]) await t.test(String(status) + code, async () => {
    let count = 0;
    const s = setup({ fetchImpl: async (_url, request) => {
      count += 1;
      return count < 3 ? responseFor(JSON.parse(request.body), count) : new Response(JSON.stringify({
        error: { code, message: `Do not expose ${KEY} ${ID(1)}` }, raw: 'PRIVATE RESPONSE',
      }), { status });
    } });
    const receipt = await runSequenceSimulation(s.options);
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.requestCount, 3);
    assert.equal(lastCode(receipt), 'SIMULATION_PROVIDER_REJECTED');
    assert.equal(receipt.results.filter(row => row.status === 'passed').length, 2);
    assert.equal(count, 3);
    for (const text of [KEY, ID(1), 'PRIVATE RESPONSE']) assert.ok(!JSON.stringify(receipt).includes(text));
  });
});

test('network exceptions and timeouts are sanitized, bounded, and never retried', async () => {
  let count = 0;
  const s = setup({ fetchImpl: async () => { count += 1; throw new Error(KEY + ID(1)); } });
  const receipt = await runSequenceSimulation(s.options);
  assert.equal(lastCode(receipt), 'SIMULATION_NETWORK_ERROR'); assert.equal(count, 1);
  assert.equal(receipt.results[0].uncertain, true); assert.ok(!JSON.stringify(receipt).includes(KEY));
  let signal;
  const timeout = setup({ timeoutMs: 5, fetchImpl: async (_url, request) => { signal = request.signal; return new Promise(() => {}); } });
  const timed = await runSequenceSimulation(timeout.options);
  assert.equal(lastCode(timed), 'SIMULATION_REQUEST_TIMEOUT'); assert.equal(timed.requestCount, 1);
  assert.equal(signal.aborted, true);
});

test('idempotency keys are valid, unique, prepared once, and no caller retry path is accepted', async () => {
  for (const uuid of [() => 'not-a-uuid', () => ID(1), () => '00000000-0000-1000-8000-000000000001', () => { throw new Error(KEY); }]) {
    const s = setup({ uuid });
    await rejects(runSequenceSimulation(s.options), 'SIMULATION_IDEMPOTENCY_INVALID');
    assert.equal(s.calls.length, 0);
  }
  let count = 0;
  const s = setup({ fetchImpl: async (_url, request) => { count += 1; return responseFor(JSON.parse(request.body), 1); } });
  const receipt = await runSequenceSimulation(s.options);
  assert.equal(lastCode(receipt), 'SIMULATION_IDENTITY_MISMATCH'); assert.equal(count, 2);
});

test('redirects and responses from any other endpoint are rejected before another probe', async t => {
  for (const kind of ['redirect', 'other-origin', 'other-path']) await t.test(kind, async () => {
    const s = setup({ fetchImpl: async (_url, request) => {
      if (kind === 'redirect') return new Response('', { status: 302 });
      const response = responseFor(JSON.parse(request.body));
      Object.defineProperty(response, 'url', { value: kind === 'other-origin' ? 'https://example.invalid' : ENDPOINT + '/other' });
      return response;
    } });
    const receipt = await runSequenceSimulation(s.options);
    assert.equal(lastCode(receipt), 'SIMULATION_REDIRECT_REJECTED'); assert.equal(receipt.requestCount, 1);
  });
});

test('oversized, malformed and invalid UTF-8 response bodies cannot leak or trigger another probe', async t => {
  const bodies = [
    () => new Response('{}', { status: 201, headers: { 'Content-Length': '65537' } }),
    () => new Response('x'.repeat(65537), { status: 201 }),
    () => new Response(KEY, { status: 201 }),
    () => new Response(new Uint8Array([255]), { status: 201 }),
  ];
  for (const [index, response] of bodies.entries()) await t.test(String(index), async () => {
    const s = setup({ fetchImpl: async () => response() }); const receipt = await runSequenceSimulation(s.options);
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.requestCount, 1);
    assert.ok(!JSON.stringify(receipt).includes(KEY));
  });
});

test('account bindings and amounts are frozen but revoked opt-in prevents subsequent requests', async () => {
  const s = setup(); const original = s.options.fetchImpl;
  s.options.fetchImpl = async (...args) => {
    s.options.config.monthly.projectAccountId = ID(90);
    s.options.config.allocations[1].targetCents = 999999;
    return original(...args);
  };
  assert.equal((await runSequenceSimulation(s.options)).status, 'passed');
  assert.equal(s.calls[1].body.amountInCents, 225000); assert.equal(s.calls[4].body.destinationAccountId, ID(6));
  const revoked = setup(); const success = revoked.options.fetchImpl;
  revoked.options.fetchImpl = async (...args) => { revoked.options.env.RUN_SEQUENCE_SIMULATION = 'false'; return success(...args); };
  const receipt = await runSequenceSimulation(revoked.options);
  assert.equal(lastCode(receipt), 'SIMULATION_OPT_IN_REQUIRED'); assert.equal(receipt.requestCount, 1);
});

test('request deadlines, invalid credentials, and unsupported timeouts stop before more calls', async () => {
  for (const change of [{ timeoutMs: 0 }, { timeoutMs: 8001 }, { timeoutMs: '8000' }, { now: '2030' }]) {
    const s = setup(change); await rejects(runSequenceSimulation(s.options), 'SIMULATION_INPUT_INVALID');
    assert.equal(s.calls.length, 0);
  }
  for (const key of ['', undefined, 'token\r\nInjected: value']) {
    const s = setup(); s.options.env.SEQUENCE_API_KEY = key;
    await rejects(runSequenceSimulation(s.options), 'SIMULATION_CREDENTIAL_REQUIRED'); assert.equal(s.calls.length, 0);
  }
  let calls = 0;
  const s = setup({ now: () => TEST_NOW + (calls++ ? 60000 : 0) });
  const receipt = await runSequenceSimulation(s.options);
  assert.equal(lastCode(receipt), 'SIMULATION_DEADLINE_EXCEEDED'); assert.equal(s.calls.length, 0);
  assert.equal(receipt.requestCount, 0);
});

function sourceFixtures() {
  const updatedAt = asISO(TEST_NOW - 1000);
  return {
    bills: { bills_catalog: { schemaVersion: 1, timeZone: 'America/New_York', updatedAt, bills: [{
      id: 'synthetic-bill', name: 'Synthetic bill', kind: 'expense', status: 'active', amountCents: 340000,
      frequency: 'monthly', evidence: { type: 'user_confirmation', reference: 'Synthetic evidence', observedAt: updatedAt },
    }] }, bills_monitor: { schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: asISO(TEST_NOW),
      catalogUpdatedAt: updatedAt, reviewCodes: [] } },
    roth: { roth_policy: { schemaVersion: 1, policy: makeRothPolicy(), evidence: {
      schemaVersion: 1, updatedAt, route: { status: 'unverified' }, upstream: { status: 'unverified' },
    } } },
  };
}

test('standalone/build entry uses existing private policy readers and returns a safe complete receipt', async () => {
  const sources = sourceFixtures(), reads = [], s = setup();
  const receipt = await verifySequenceSimulation(s.options.env, {
    now: s.options.now, uuid: s.options.uuid, fetchImpl: s.options.fetchImpl,
    billsReader: async keys => { reads.push(keys); return sources.bills; },
    rothReader: async keys => { reads.push(keys); return sources.roth; },
  });
  assert.deepEqual(reads, [['bills_catalog', 'bills_monitor'], ['roth_policy']]);
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.requestCount, 7);
  assert.equal(s.calls[0].body.amountInCents, 350000);
  assert.ok(!JSON.stringify(receipt).includes(KEY));
});

test('standalone/build entry rejects inactive gates before even private policy reads', async () => {
  let reads = 0;
  const reader = async () => { reads += 1; throw new Error('should not read'); };
  for (const change of [{ RUN_SEQUENCE_SIMULATION: 'false' }, { APP_MODE: 'live' }, { LIVE_TRANSFERS_ENABLED: 'true' }]) {
    await assert.rejects(verifySequenceSimulation(envFor(change), { billsReader: reader, rothReader: reader }),
      error => error instanceof SequenceSimulationError);
  }
  assert.equal(reads, 0);
  assert.throws(() => assertSequenceSimulationAllowed(envFor({ RUN_SEQUENCE_SIMULATION: '' })), { code: 'SIMULATION_OPT_IN_REQUIRED' });
});

test('standalone/build entry rejects source failures or emits a sanitized failed receipt without retry', async () => {
  const sources = sourceFixtures(), s = setup();
  const options = { now: s.options.now, uuid: s.options.uuid, fetchImpl: s.options.fetchImpl,
    billsReader: async () => sources.bills, rothReader: async () => sources.roth };
  await rejects(verifySequenceSimulation(s.options.env, { ...options,
    billsReader: async () => { throw new Error(KEY); } }), 'SIMULATION_BILLS_POLICY_UNAVAILABLE');
  await rejects(verifySequenceSimulation(s.options.env, { ...options,
    rothReader: async () => { throw new Error(KEY); } }), 'SIMULATION_ROTH_POLICY_UNVERIFIED');
  assert.equal(s.calls.length, 0);
  await assert.rejects(verifySequenceSimulation(s.options.env, { ...options,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'ACCESS_DENIED', message: KEY } }), { status: 403 }) }),
  error => error.code === 'SIMULATION_FAILED' && error.receipt.requestCount === 1 &&
    !JSON.stringify(error).includes(KEY));
});
