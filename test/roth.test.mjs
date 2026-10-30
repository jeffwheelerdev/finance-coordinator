import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRothPolicy, forecastRoth, RothPolicyError, ROTH_TIME_ZONE, ROTH_POLICY_ID, ROTH_DUE_HOUR_UTC } from '../lib/roth.mjs';

// Synthetic tax-year facts only; these fixtures are not IRS limits for 2030.
const NOW = '2030-11-01T15:00:00.000Z';
const PROOF_AT = '2025-12-01T12:00:00.000Z';
const REVISION = '2025-12-02T12:00:00.000Z';
const IRS = 'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits';
const reference = 'Synthetic reviewed tax-year evidence';
const copy = value => structuredClone(value);
const code = expected => error => error instanceof RothPolicyError && error.code === expected;

function statutory(year = 2030, overrides = {}) {
  return { year, baseLimitCents: 750000, catchUpLimitCents: 110000, verifiedAt: PROOF_AT, sourceUrls: [IRS], ...overrides };
}
function unknownYear(year = 2030) {
  return {
    year, catchUpEligible: null, eligibility: { status: 'unverified' },
    outsideContributions: { status: 'unverified' }, exclusiveCoordinator: { confirmed: false }, otherSchedule: { status: 'unverified' },
  };
}
function verifiedYear(year = 2030, overrides = {}) {
  return {
    year, catchUpEligible: false,
    eligibility: { status: 'verified', annualRothLimitCents: 750000, annualCombinedLimitCents: 750000, verifiedAt: PROOF_AT, reference },
    outsideContributions: { status: 'verified', traditionalCents: 0, rothCents: 0, verifiedAt: PROOF_AT, reference },
    exclusiveCoordinator: { confirmed: true, confirmedAt: PROOF_AT, reference },
    otherSchedule: { status: 'none', verifiedAt: PROOF_AT, reference },
    ...overrides,
  };
}
function policy(overrides = {}) {
  return { schemaVersion: 1, id: ROTH_POLICY_ID, timeZone: ROTH_TIME_ZONE, updatedAt: REVISION,
    statutoryLimits: [statutory()], years: [verifiedYear()], ...overrides };
}
const forecast = (input = policy(), options = {}) => forecastRoth(input, {
  now: NOW, activationAt: '2030-01-01T00:00:00Z', ownReservedCents: 0, ...options,
});

test('a verified full annual budget produces twelve $625 installments and an eligible current request', () => {
  const result = forecast();
  assert.equal(result.monthlyAmountCents, 62500);
  assert.equal(result.amountInCents, 62500);
  assert.equal(result.remainingAnnualCents, 750000);
  assert.equal(result.installments.length, 12);
  assert.ok(result.installments.every(item => item.amountCents === 62500));
  assert.equal(result.installments.reduce((sum, item) => sum + item.amountCents, 0), 750000);
  assert.equal(result.reason, 'READY');
  assert.equal(result.eligible, true);
  assert.deepEqual(result.blockers, []);
});

test('unknown personal evidence previews the base limit without authorizing a contribution', () => {
  const result = forecast(policy({ statutoryLimits: [statutory(2026)], years: [unknownYear(2026)] }), {
    now: '2026-11-01T15:00:00Z', activationAt: null,
  });
  assert.equal(result.monthlyAmountCents, 62500);
  assert.equal(result.previewAnnualLimitCents, 750000);
  assert.equal(result.statutoryLimitCents, null);
  assert.equal(result.remainingAnnualCents, null);
  assert.equal(result.annualRothLimitCents, null);
  assert.equal(result.outsideRothCents, null);
  assert.equal(result.amountInCents, 0);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers, [
    'ROTH_CATCH_UP_ELIGIBILITY_UNVERIFIED', 'ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED',
    'ROTH_OUTSIDE_CONTRIBUTIONS_UNVERIFIED', 'ROTH_EXCLUSIVE_COORDINATOR_UNCONFIRMED',
    'ROTH_OTHER_SCHEDULE_UNVERIFIED', 'ROTH_ACTIVATION_REQUIRED',
  ]);
});

test('each missing personal gate independently blocks an otherwise valid request', async t => {
  const changes = [
    [{ catchUpEligible: null }, 'ROTH_CATCH_UP_ELIGIBILITY_UNVERIFIED'],
    [{ eligibility: { status: 'unverified' } }, 'ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED'],
    [{ outsideContributions: { status: 'unverified' } }, 'ROTH_OUTSIDE_CONTRIBUTIONS_UNVERIFIED'],
    [{ exclusiveCoordinator: { confirmed: false } }, 'ROTH_EXCLUSIVE_COORDINATOR_UNCONFIRMED'],
    [{ otherSchedule: { status: 'unverified' } }, 'ROTH_OTHER_SCHEDULE_UNVERIFIED'],
  ];
  for (const [change, blocker] of changes) await t.test(blocker, () => {
    const result = forecast(policy({ years: [verifiedYear(2030, change)] }));
    assert.deepEqual(result.blockers, [blocker]);
    assert.equal(result.amountInCents, 0);
    assert.equal(result.monthlyAmountCents, 62500);
  });
});

test('separate Roth and combined ceilings avoid subtracting Traditional contributions from the MAGI ceiling twice', () => {
  const item = verifiedYear();
  item.eligibility.annualRothLimitCents = 375000;
  item.outsideContributions.traditionalCents = 100000;
  const result = forecast(policy({ years: [item] }));
  assert.equal(result.remainingRothCents, 375000);
  assert.equal(result.remainingCombinedCents, 650000);
  assert.equal(result.remainingAnnualCents, 375000);
  assert.equal(result.monthlyAmountCents, 31250);
  assert.equal(result.amountInCents, 31250);
});

test('outside Roth, Traditional and own reserved amounts constrain the applicable ceilings exactly once', () => {
  const item = verifiedYear();
  item.outsideContributions.traditionalCents = 300000;
  item.outsideContributions.rothCents = 100000;
  const result = forecast(policy({ years: [item] }), { ownReservedCents: 340000 });
  assert.equal(result.remainingRothCents, 310000);
  assert.equal(result.remainingCombinedCents, 10000);
  assert.equal(result.remainingAnnualCents, 10000);
  assert.equal(result.amountInCents, 10000);
});

test('pending or settled own reservations use the same annual cap and exact-limit zero is a valid no-op', () => {
  const almost = forecast(policy(), { ownReservedCents: 749999 });
  assert.equal(almost.amountInCents, 1);
  const full = forecast(policy(), { ownReservedCents: 750000 });
  assert.equal(full.amountInCents, 0);
  assert.equal(full.eligible, true);
  assert.equal(full.reason, 'ROTH_ANNUAL_LIMIT_REACHED');
  const exceeded = forecast(policy(), { ownReservedCents: 750001 });
  assert.equal(exceeded.amountInCents, 0);
  assert.deepEqual(exceeded.blockers, ['ROTH_ANNUAL_LIMIT_EXCEEDED']);
});

test('outside contributions above either verified ceiling block without creating negative room', () => {
  const item = verifiedYear();
  item.eligibility.annualRothLimitCents = 100000;
  item.outsideContributions.rothCents = 100001;
  const result = forecast(policy({ years: [item] }));
  assert.equal(result.remainingRothCents, 0);
  assert.equal(result.remainingCombinedCents, 649999);
  assert.equal(result.amountInCents, 0);
  assert.ok(result.blockers.includes('ROTH_ANNUAL_LIMIT_EXCEEDED'));
});

test('verified legal zero is distinct from unknown eligibility and produces no contribution', () => {
  const item = verifiedYear();
  item.eligibility.annualRothLimitCents = 0;
  const result = forecast(policy({ years: [item] }));
  assert.equal(result.previewAnnualLimitCents, 0);
  assert.equal(result.monthlyAmountCents, 0);
  assert.equal(result.amountInCents, 0);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.blockers, []);
});

test('catch-up eligibility selects the extra allowance and cent remainders sum exactly', () => {
  const item = verifiedYear();
  item.catchUpEligible = true;
  item.eligibility.annualRothLimitCents = 860000;
  item.eligibility.annualCombinedLimitCents = 860000;
  const result = forecast(policy({ years: [item] }));
  assert.equal(result.statutoryLimitCents, 860000);
  assert.deepEqual(result.installments.map(item => item.amountCents), [71666,71667,71667,71666,71667,71667,71666,71667,71667,71666,71667,71667]);
  assert.equal(result.installments.reduce((sum, item) => sum + item.amountCents, 0), 860000);
});

test('arbitrary nonnegative cent budgets distribute exactly with no floating-point drift', () => {
  for (const amount of [0,1,11,12,13,19999,700000,750001,Number.MAX_SAFE_INTEGER]) {
    const item = verifiedYear();
    item.eligibility.annualRothLimitCents = amount;
    item.eligibility.annualCombinedLimitCents = amount;
    const result = forecast(policy({ statutoryLimits: [statutory(2030, { baseLimitCents: amount, catchUpLimitCents: 0 })], years: [item] }));
    assert.equal(result.installments.reduce((sum, item) => sum + BigInt(item.amountCents), 0n), BigInt(amount));
    assert.ok(result.installments.every(item => Number.isSafeInteger(item.amountCents) && item.amountCents >= 0));
    assert.ok(Math.max(...result.installments.map(item => item.amountCents)) - Math.min(...result.installments.map(item => item.amountCents)) <= 1);
  }
});

test('each monthly slot is due on the first at15UTC and does not depend on a Pod refund', () => {
  const result = forecast();
  assert.equal(ROTH_DUE_HOUR_UTC, 15);
  assert.equal(result.dueAt, '2030-11-01T15:00:00.000Z');
  assert.equal(result.monthKey, '2030-11');
  assert.equal(result.effectiveDate, '2030-11-01');
  assert.equal(result.installments[0].dueAt, '2030-01-01T15:00:00.000Z');
  assert.equal(result.installments[6].dueAt, '2030-07-01T15:00:00.000Z');
  const early = forecast(policy(), { now: '2030-11-01T14:59:59.999Z' });
  assert.deepEqual(early.blockers, ['ROTH_MONTH_NOT_DUE']);
  assert.equal(early.amountInCents, 0);
});

test('activation is prospective and never creates a larger late-year catch-up installment', () => {
  const first = forecast(policy(), { activationAt: '2030-11-01T15:00:00Z' });
  assert.equal(first.amountInCents, 62500);
  const late = forecast(policy(), { now: '2030-11-02T16:00:00Z', activationAt: '2030-11-01T15:00:00.001Z' });
  assert.deepEqual(late.blockers, ['ROTH_MONTH_PREDATES_ACTIVATION']);
  assert.equal(late.amountInCents, 0);
  const december = forecast(policy(), { now: '2030-12-01T15:00:00Z', activationAt: '2030-11-01T15:00:00.001Z' });
  assert.equal(december.amountInCents, 62500);
  const future = forecast(policy(), { activationAt: '2030-12-01T15:00:00Z' });
  assert.ok(future.blockers.includes('ROTH_ACTIVATION_NOT_STARTED'));
  assert.equal(future.amountInCents, 0);
});

test('missing activation blocks execution while preserving the useful monthly preview', () => {
  const result = forecastRoth(policy(), { now: NOW });
  assert.deepEqual(result.blockers, ['ROTH_ACTIVATION_REQUIRED']);
  assert.equal(result.monthlyAmountCents, 62500);
  assert.equal(result.amountInCents, 0);
});

test('New York determines the tax year at UTC New Year and no unverified year limit carries forward', () => {
  const before = forecast(policy(), { now: '2031-01-01T04:59:59Z' });
  assert.equal(before.year, 2030);
  assert.equal(before.monthKey, '2030-12');
  const after = forecast(policy(), { now: '2031-01-01T05:00:00Z' });
  assert.equal(after.year, 2031);
  assert.equal(after.monthKey, '2031-01');
  assert.equal(after.monthlyAmountCents, null);
  assert.deepEqual(after.installments, []);
  assert.equal(after.amountInCents, 0);
  assert.ok(after.blockers.includes('ROTH_STATUTORY_LIMIT_UNVERIFIED'));
  assert.ok(after.blockers.includes('ROTH_YEAR_POLICY_MISSING'));
});

test('an officially recorded new limit does not carry personal eligibility or outside baseline into the new year', () => {
  const input = policy({ statutoryLimits: [statutory(), statutory(2031, { baseLimitCents: 800000 })] });
  const result = forecast(input, { now: '2031-01-01T15:00:00Z' });
  assert.equal(result.monthlyAmountCents, 66666);
  assert.equal(result.installments.reduce((sum, item) => sum + item.amountCents, 0), 800000);
  assert.equal(result.annualRothLimitCents, null);
  assert.equal(result.outsideTraditionalCents, null);
  assert.equal(result.amountInCents, 0);
  assert.ok(!result.blockers.includes('ROTH_STATUTORY_LIMIT_UNVERIFIED'));
  assert.ok(result.blockers.includes('ROTH_YEAR_POLICY_MISSING'));
});

test('canonical policy hashes ignore property and year order but change with evidence/revision changes', () => {
  const input = policy({ statutoryLimits: [statutory(2031), statutory()], years: [verifiedYear(2031), verifiedYear()] });
  const original = copy(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.statutoryLimits.reverse(); reordered.years.reverse();
  const a = forecast(input), b = forecast(JSON.stringify(reordered));
  assert.equal(a.policyHash, b.policyHash);
  assert.match(a.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(a.policyId, 'roth-ira');
  const changed = copy(original); changed.updatedAt = '2025-12-03T12:00:00Z';
  assert.notEqual(forecast(changed).policyHash, a.policyHash);
  const parsed = parseRothPolicy(JSON.stringify(original));
  parsed.years[0].eligibility.annualRothLimitCents = 0;
  assert.equal(original.years[1].eligibility.annualRothLimitCents, 750000);
});

test('strict parsing rejects money coercion, duplicate years, unsupported fields and invented certainty', async t => {
  const cases = [
    ['negative cents', p => { p.statutoryLimits[0].baseLimitCents = -1; }, 'ROTH_AMOUNT_INVALID'],
    ['decimal cents', p => { p.statutoryLimits[0].baseLimitCents = 750000.5; }, 'ROTH_AMOUNT_INVALID'],
    ['string cents', p => { p.years[0].outsideContributions.rothCents = '0'; }, 'ROTH_AMOUNT_INVALID'],
    ['unsafe cents', p => { p.statutoryLimits[0].baseLimitCents = Number.MAX_SAFE_INTEGER + 1; }, 'ROTH_AMOUNT_INVALID'],
    ['duplicate statutory year', p => { p.statutoryLimits.push(copy(p.statutoryLimits[0])); }, 'ROTH_DUPLICATE_YEAR'],
    ['duplicate personal year', p => { p.years.push(copy(p.years[0])); }, 'ROTH_DUPLICATE_YEAR'],
    ['wrong timezone', p => { p.timeZone = 'UTC'; }, 'ROTH_POLICY_IDENTITY_INVALID'],
    ['changed stable id', p => { p.id = 'roth-ira-new'; }, 'ROTH_POLICY_IDENTITY_INVALID'],
    ['wrong schema', p => { p.schemaVersion = 2; }, 'ROTH_POLICY_IDENTITY_INVALID'],
    ['unknown root field', p => { p.destinationAccountId = 'guessed'; }, 'ROTH_POLICY_INVALID'],
    ['unverified amount', p => { p.years[0].outsideContributions = { status: 'unverified', rothCents: 0 }; }, 'ROTH_OUTSIDE_CONTRIBUTIONS_INVALID'],
    ['missing verified baseline', p => { delete p.years[0].outsideContributions.traditionalCents; }, 'ROTH_OUTSIDE_CONTRIBUTIONS_INVALID'],
    ['unknown catch-up', p => { p.years[0].catchUpEligible = 'false'; }, 'ROTH_CATCH_UP_INVALID'],
    ['proof-free exclusivity', p => { p.years[0].exclusiveCoordinator = { confirmed: true }; }, 'ROTH_EXCLUSIVITY_INVALID'],
    ['unknown schedule status', p => { p.years[0].otherSchedule.status = 'probably_none'; }, 'ROTH_OTHER_SCHEDULE_INVALID'],
  ];
  for (const [label, mutate, expected] of cases) await t.test(label, () => {
    const input = policy(); mutate(input);
    assert.throws(() => parseRothPolicy(input), code(expected));
  });
});

test('non-IRS, insecure, credential-bearing and ambiguous source URLs are rejected', async t => {
  for (const value of [
    'http://www.irs.gov/retirement-plans', 'https://irs.gov.example.com/limits', 'https://example.com/irs.gov',
    'https://news.irs.gov/limits', 'https://user:password@www.irs.gov/limits', 'https://www.irs.gov:444/limits',
    'https://www.irs.gov/', 'https://www.irs.gov/search?q=limits', 'https://www.irs.gov/limits#draft', 'not-a-url',
  ]) await t.test(value, () => {
    const input = policy(); input.statutoryLimits[0].sourceUrls = [value];
    assert.throws(() => parseRothPolicy(input), code('ROTH_IRS_SOURCE_INVALID'));
  });
  const plain = policy(); plain.statutoryLimits[0].sourceUrls = ['https://irs.gov/retirement-plans'];
  assert.equal(parseRothPolicy(plain).statutoryLimits[0].sourceUrls[0], 'https://irs.gov/retirement-plans');
});

test('verified personal ceilings must be internally consistent and within the applicable published limit', () => {
  const input = policy(); input.years[0].eligibility.annualCombinedLimitCents = 749999;
  assert.throws(() => parseRothPolicy(input), code('ROTH_PERSONAL_LIMIT_INCONSISTENT'));
  input.years[0].eligibility.annualCombinedLimitCents = 750001;
  assert.throws(() => parseRothPolicy(input), code('ROTH_PERSONAL_LIMIT_EXCEEDS_STATUTORY'));
  input.years[0].catchUpEligible = true;
  assert.equal(parseRothPolicy(input).years[0].eligibility.annualCombinedLimitCents, 750001);
});

test('invalid or future timestamps never become trusted evidence', () => {
  const badDate = policy(); badDate.updatedAt = '2030-02-30T12:00:00Z';
  assert.throws(() => parseRothPolicy(badDate), code('ROTH_TIMESTAMP_INVALID'));
  const futureProof = policy(); futureProof.years[0].eligibility.verifiedAt = '2025-12-03T12:00:00Z';
  assert.throws(() => parseRothPolicy(futureProof), code('ROTH_EVIDENCE_NEWER_THAN_POLICY'));
  const futurePolicy = policy({ updatedAt: '2030-11-02T12:00:00Z' });
  assert.throws(() => forecast(futurePolicy), code('ROTH_POLICY_FROM_FUTURE'));
  assert.throws(() => forecast(policy(), { activationAt: '2030-11-31T00:00:00Z' }), code('ROTH_ACTIVATION_INVALID'));
  const offset = policy({ updatedAt: '2025-12-02T07:00:00-05:00' });
  assert.equal(parseRothPolicy(offset).updatedAt, REVISION);
});

test('invalid forecast time, unknown options and unknown own reservations fail instead of defaulting to zero', async t => {
  for (const now of [undefined, null, NaN, Infinity, new Date('bad'), '2030-11-01']) {
    await t.test(`now ${String(now)}`, () => assert.throws(() => forecast(policy(), { now }), code('ROTH_NOW_INVALID')));
  }
  for (const amount of [undefined, null, -1, '0', 0.5, Infinity]) {
    await t.test(`reserved ${String(amount)}`, () => assert.throws(() => forecast(policy(), { ownReservedCents: amount }), code('ROTH_AMOUNT_INVALID')));
  }
  assert.throws(() => forecast(policy(), { year: 2029 }), code('ROTH_FORECAST_OPTIONS_INVALID'));
  assert.equal(forecast(policy(), { now: new Date(NOW) }).year, 2030);
});

test('integer overflow and oversized input cannot authorize an amount', () => {
  const tooLarge = policy(); tooLarge.statutoryLimits[0].baseLimitCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => parseRothPolicy(tooLarge), code('ROTH_AMOUNT_OVERFLOW'));
  const outside = policy(); outside.years[0].outsideContributions.traditionalCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => forecast(outside, { ownReservedCents: 1 }), code('ROTH_AMOUNT_OVERFLOW'));
  assert.throws(() => parseRothPolicy(' '.repeat(256001)), code('ROTH_POLICY_TOO_LARGE'));
  assert.throws(() => parseRothPolicy('{'), code('ROTH_POLICY_JSON_INVALID'));
});
