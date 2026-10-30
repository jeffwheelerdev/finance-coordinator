import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, VERSION, loadConfig, parseMoney, summarizeConfig, withCalculatedBillsTarget } from '../lib/config.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const accounts = { income: uuid(1), pod: uuid(2), general: uuid(3), bills: uuid(4) };
const rules = { payout: uuid(11), funding: uuid(12), legacyGeneral: uuid(13) };
const env = overrides => ({
  APP_MODE: 'observe', FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(accounts),
  FINANCE_RULE_IDS_JSON: JSON.stringify(rules),
  GENERAL_SPENDING_MONTHLY_BUDGET: '1234.56', GENERAL_SPENDING_RESERVE_MONTHS: '3',
  BILLS_BUFFER_TARGET: '4567.89', INCOME_RESERVE: '321.09', ...overrides,
});
const extra = overrides => ({
  id: 'future-savings', destinationAccountId: uuid(20), monthlyBudget: '98.76',
  reserveMonths: 2, priority: 1, ...overrides,
});
const general = (config) => config.allocations.find((allocation) => allocation.id === 'general-spending');
const forecast = (overrides = {}) => ({ targetCents: 500000, peakMonthCents: 470123,
  catalogHash: 'a'.repeat(64), catalogUpdatedAt: '2029-12-31T00:00:00.000Z', year: 2030, effectiveDate: '2030-01-02', ...overrides });
function rejects(fn, code) {
  assert.throws(fn, error => error instanceof ConfigError && (!code || error.code === code));
}

test('money parsing is exact for arbitrary dollar values and safe integer boundary', () => {
  for (const [input, expected] of [['0', 0], ['0.01', 1], ['1.2', 120], ['1234.56', 123456],
    ['0001.05', 105], ['90071992547409.91', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(parseMoney(input, 'test amount'), expected);
  }
  rejects(() => parseMoney('90071992547409.92'), 'INVALID_MONEY');
});

test('money rejects approximation, coercion, signs, precision loss, and ambiguous syntax', () => {
  for (const value of ['1e3', '-1', '-0', '+1', 'NaN', 'Infinity', '1.234', '.50', '1.', '',
    ' 1', '1 ', '$1.00', '1,000', 1, null, undefined, true]) {
    rejects(() => parseMoney(value), 'INVALID_MONEY');
  }
});

test('required configuration has no financial or account defaults', () => {
  for (const key of ['APP_MODE', 'FINANCE_ACCOUNT_IDS_JSON', 'FINANCE_RULE_IDS_JSON',
    'GENERAL_SPENDING_MONTHLY_BUDGET', 'GENERAL_SPENDING_RESERVE_MONTHS', 'INCOME_RESERVE']) {
    const input = env(); delete input[key];
    rejects(() => loadConfig(input), 'MISSING_CONFIG');
  }
});

test('target derives from configurable budget and reserve months, without a fixed target', () => {
  const config = loadConfig(env());
  assert.equal(VERSION, '0.6.2');
  assert.equal(general(config).monthlyBudgetCents, 123456);
  assert.equal(general(config).targetCents, 370368);
  assert.equal(config.allocations[0].id, 'bills');
  assert.equal(config.allocations[0].priority, 0);
  assert.equal(general(config).priority, 1);
  assert.equal(config.billsBufferCents, null);
  assert.equal(config.incomeReserveCents, 32109);
  assert.equal(config.maxBalanceAgeMs, 26 * 3_600_000);
  assert.equal(config.activationAt, null);
  assert.equal(config.liveEnabled, false);
  const edited = loadConfig(env({ GENERAL_SPENDING_MONTHLY_BUDGET: '1434.56' }));
  assert.equal(general(edited).targetCents, 430368);
  assert.notEqual(edited.configHash, config.configHash);
});

test('zero budget is valid while invalid reserve-month counts and target overflow fail', () => {
  assert.equal(general(loadConfig(env({ GENERAL_SPENDING_MONTHLY_BUDGET: '0' }))).targetCents, 0);
  for (const value of ['0', '-1', '1.5', '2e1', 'NaN', '9007199254740992']) {
    rejects(() => loadConfig(env({ GENERAL_SPENDING_RESERVE_MONTHS: value })), 'INVALID_INTEGER');
  }
  rejects(() => loadConfig(env({ GENERAL_SPENDING_MONTHLY_BUDGET: '90071992547409.91',
    GENERAL_SPENDING_RESERVE_MONTHS: '2' })), 'INVALID_TARGET');
});

test('live mode requires explicit activation and two independent switches', () => {
  const activated = { AUTOMATION_START_AT: '2030-01-01T05:00:00-05:00' };
  assert.equal(loadConfig(env({ LIVE_TRANSFERS_ENABLED: 'true' })).liveEnabled, false);
  assert.equal(loadConfig(env({ APP_MODE: 'live', ...activated })).liveEnabled, false);
  const live = loadConfig(env({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true', ...activated }));
  assert.equal(live.liveEnabled, true);
  assert.equal(live.activationAt, '2030-01-01T10:00:00.000Z');
  rejects(() => loadConfig(env({ APP_MODE: 'live' })), 'MISSING_ACTIVATION');
  rejects(() => loadConfig(env({ APP_MODE: 'live', AUTOMATION_START_AT: '' })), 'MISSING_ACTIVATION');
});

test('mode and live flag do not accept typos or truthy coercion', () => {
  for (const mode of ['LIVE', 'dry-run', ' observe']) rejects(() => loadConfig(env({ APP_MODE: mode })), 'INVALID_MODE');
  for (const flag of ['TRUE', '1', '', true, false, null]) {
    rejects(() => loadConfig(env({ LIVE_TRANSFERS_ENABLED: flag })), 'INVALID_BOOLEAN');
  }
});

test('timestamps require real calendar dates, timezone, and unambiguous time', () => {
  for (const value of ['2030-01-01', '2030-01-01T00:00:00', '2030-02-29T00:00:00Z',
    '2030-04-31T00:00:00Z', '2030-01-01T24:00:00Z', '2030-01-01T00:00:60Z',
    '2030-01-01T00:00:00+24:00', '2030-01-01T00:00:00+00:60']) {
    rejects(() => loadConfig(env({ AUTOMATION_START_AT: value })), 'INVALID_TIMESTAMP');
  }
  assert.equal(loadConfig(env({ AUTOMATION_START_AT: '2032-02-29T00:00:00.01Z' })).activationAt, '2032-02-29T00:00:00.010Z');
});

test('balance age can be stricter but cannot exceed the supported upper bound', () => {
  assert.equal(loadConfig(env({ MAX_BALANCE_AGE_HOURS: '0.5' })).maxBalanceAgeMs, 1_800_000);
  for (const value of ['0', '-1', '26.01', '27', 'Infinity', '1e1', '', '0.0000001']) {
    rejects(() => loadConfig(env({ MAX_BALANCE_AGE_HOURS: value })), 'INVALID_BALANCE_AGE');
  }
});

test('account and rule mappings validate UUIDs, uniqueness, missing and unknown fields', () => {
  rejects(() => loadConfig(env({ FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ ...accounts, income: 'income' }) })), 'INVALID_UUID');
  rejects(() => loadConfig(env({ FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ ...accounts, general: accounts.income }) })), 'DUPLICATE_ID');
  rejects(() => loadConfig(env({ FINANCE_RULE_IDS_JSON: JSON.stringify({ ...rules, payout: rules.funding }) })), 'DUPLICATE_ID');
  const { bills, ...missing } = accounts;
  rejects(() => loadConfig(env({ FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(missing) })), 'INVALID_CONFIG');
  rejects(() => loadConfig(env({ FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ ...accounts, typo: uuid(5) }) })), 'INVALID_CONFIG');
  rejects(() => loadConfig(env({ FINANCE_RULE_IDS_JSON: '[]' })), 'INVALID_CONFIG');
});

test('malformed JSON errors do not echo private payloads', () => {
  const marker = 'private-marker-do-not-echo';
  assert.throws(() => loadConfig(env({ FINANCE_ACCOUNT_IDS_JSON: `{"income":"${marker}"` })), error => {
    assert.equal(error.code, 'INVALID_JSON');
    assert.equal(error.message.includes(marker), false);
    return true;
  });
});

test('additional allocations have computed targets, deterministic ordering, and future start dates', () => {
  const extras = [extra({ id: 'z-fund', priority: 2, destinationAccountId: uuid(21) }),
    extra({ id: 'b-fund', priority: 1, startsAt: '2031-01-01T00:00:00-05:00' }),
    extra({ id: 'a-fund', priority: 1, destinationAccountId: uuid(22), enabled: false })];
  const config = loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify(extras) }));
  assert.deepEqual(config.allocations.map(item => item.id), ['bills', 'general-spending', 'a-fund', 'b-fund', 'z-fund']);
  assert.deepEqual(config.allocations.map(item => item.priority), [0, 1, 2, 2, 3]);
  assert.equal(config.allocations[2].enabled, false);
  assert.equal(config.allocations[3].enabled, true);
  assert.equal(config.allocations[3].targetCents, 19752);
  assert.equal(config.allocations[3].startsAt, '2031-01-01T05:00:00.000Z');
});

test('additional allocations reject duplicate identities and unsafe destination roles', () => {
  for (const item of [extra({ id: 'general-spending' }), extra({ id: 'bills' }),
    extra({ destinationAccountId: accounts.general }), extra({ destinationAccountId: accounts.bills })]) {
    rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([item]) })), 'DUPLICATE_ALLOCATION');
  }
  for (const destinationAccountId of [accounts.income, accounts.pod]) {
    rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([extra({ destinationAccountId })]) })), 'INVALID_DESTINATION');
  }
  rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([extra(), extra({ id: 'other' })]) })), 'DUPLICATE_ALLOCATION');
});

test('additional allocation schema is strict and never coerces financial fields', () => {
  for (const item of [extra({ unknown: true }), extra({ id: 'Mutable Name' }), extra({ id: 'constructor' }), extra({ monthlyBudget: 10 }),
    extra({ reserveMonths: '2' }), extra({ reserveMonths: 0 }), extra({ priority: -1 }), extra({ priority: 0 }),
    extra({ enabled: 'false' }), extra({ startsAt: '2030-02-30T00:00:00Z' }), null]) {
    rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([item]) })));
  }
  const { priority, ...missing } = extra();
  rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([missing]) })), 'INVALID_CONFIG');
});

test('nine existing optional recipients remain supported after adding mandatory Bills', () => {
  const extras = Array.from({ length: 9 }, (_, i) => extra({ id: `fund-${i}`, destinationAccountId: uuid(100 + i) }));
  assert.equal(loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify(extras) })).allocations.length, 11);
  extras.push(extra({ id: 'fund-over-limit', destinationAccountId: uuid(200) }));
  rejects(() => loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify(extras) })), 'INVALID_ALLOCATIONS');
});

test('configuration hash is stable across JSON ordering, allocation ordering, mode, and credentials', () => {
  const extras = [extra(), extra({ id: 'another-fund', destinationAccountId: uuid(21), priority: 3 })];
  const baseline = env({ AUTOMATION_START_AT: '2030-01-01T00:00:00Z', FINANCE_ALLOCATIONS_JSON: JSON.stringify(extras) });
  const reorderedAccounts = Object.fromEntries(Object.entries(accounts).reverse());
  const a = loadConfig(baseline);
  const b = loadConfig({ ...baseline, APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true',
    SEQUENCE_API_KEY: 'test-only-ignored-credential', FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(reorderedAccounts),
    FINANCE_ALLOCATIONS_JSON: JSON.stringify(extras.slice().reverse()) });
  assert.equal(a.configHash, b.configHash);
  assert.match(a.configHash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.configHash, loadConfig({ ...baseline, INCOME_RESERVE: '321.10' }).configHash);
});

test('administration summary contains no provider identifiers or credential fields', () => {
  const config = loadConfig(env({ FINANCE_ALLOCATIONS_JSON: JSON.stringify([extra()]) }));
  const summary = summarizeConfig(config), text = JSON.stringify(summary);
  for (const id of [...Object.values(accounts), ...Object.values(rules), uuid(20)]) assert.equal(text.includes(id), false);
  assert.equal(text.includes('destinationAccountId'), false);
  assert.equal(summary.allocations[1].targetCents, 370368);
  assert.equal(summary.version, VERSION);
});

test('runtime Bills forecast replaces the obsolete fixed buffer without changing other targets', () => {
  const base = loadConfig(env());
  const resolved = withCalculatedBillsTarget(base, forecast());
  assert.equal(base.billsBufferCents, null);
  assert.equal(resolved.billsBufferCents, 500000);
  assert.equal(resolved.allocations[0].targetCents, 500000);
  assert.equal(general(resolved).targetCents, 370368);
  assert.equal(resolved.calculatedBillsTarget.catalogUpdatedAt, '2029-12-31T00:00:00.000Z');
  assert.notEqual(resolved.configHash, base.configHash);
  const absentLegacy = env(); delete absentLegacy.BILLS_BUFFER_TARGET;
  assert.equal(loadConfig(absentLegacy).configHash, base.configHash);
  assert.equal(loadConfig(env({ BILLS_BUFFER_TARGET: '9999.99' })).configHash, base.configHash);
  assert.notEqual(withCalculatedBillsTarget(base, forecast({ targetCents: 550000 })).configHash, resolved.configHash);
});

test('Bills target resolution rejects incomplete or inconsistent forecast evidence', () => {
  const base = loadConfig(env());
  for (const value of [null, {}, forecast({ targetCents: 499999 }), forecast({ targetCents: 0 }),
    forecast({ targetCents: Number.MAX_SAFE_INTEGER + 1 }), forecast({ catalogHash: 'missing' }),
    forecast({ catalogUpdatedAt: '2030-02-30T00:00:00Z' }), forecast({ catalogUpdatedAt: undefined }),
    forecast({ effectiveDate: '2030-02-30' }), forecast({ effectiveDate: undefined }),
    forecast({ year: 2030.5 })]) rejects(() => withCalculatedBillsTarget(base, value));
  assert.throws(() => withCalculatedBillsTarget({ ...base, allocations: base.allocations.slice(1) }, forecast()),
    { code: 'BILLS_TARGET_UNAVAILABLE' });
});

test('runtime summaries expose aggregate Bills policy and omit private catalog rows', () => {
  const result = withCalculatedBillsTarget(loadConfig(env()), forecast({ bills: [{ name: 'private-test-payee' }] }));
  const summary = summarizeConfig(result);
  assert.equal(summary.calculatedBillsTarget.targetCents, 500000);
  assert.equal(JSON.stringify(summary).includes('private-test-payee'), false);
  assert.equal(JSON.stringify(result).includes('private-test-payee'), false);
});

test('Roth is an independently configured investment destination, never a refund target', () => {
  const baseline = loadConfig(env());
  assert.deepEqual(baseline.roth, { enabled: false, accountId: null });
  const configured = loadConfig(env({ ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: uuid(30) }));
  assert.deepEqual(configured.roth, { enabled: true, accountId: uuid(30) });
  assert.equal(configured.allocations.length, baseline.allocations.length);
  assert.equal(configured.liveEnabled, false);
  assert.notEqual(configured.configHash, baseline.configHash);
  const summary = summarizeConfig(configured);
  assert.equal(summary.roth.schedule, 'first_of_month');
  assert.equal(summary.roth.checkHourUTC, 15);
  assert.equal(JSON.stringify(summary).includes(uuid(30)), false);
});

test('Roth rejects missing, ambiguous, and overlapping account bindings', () => {
  for (const value of ['TRUE', '', true, 1]) rejects(() => loadConfig(env({ ROTH_ENABLED: value })), 'INVALID_BOOLEAN');
  rejects(() => loadConfig(env({ ROTH_ENABLED: 'true' })), 'MISSING_ROTH_ACCOUNT');
  rejects(() => loadConfig(env({ ROTH_ACCOUNT_ID: 'Roth IRA' })), 'INVALID_UUID');
  for (const value of Object.values(accounts)) {
    rejects(() => loadConfig(env({ ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: value })), 'INVALID_ROTH_DESTINATION');
  }
  rejects(() => loadConfig(env({ ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: uuid(20),
    FINANCE_ALLOCATIONS_JSON: JSON.stringify([extra()]) })), 'INVALID_ROTH_DESTINATION');
});
