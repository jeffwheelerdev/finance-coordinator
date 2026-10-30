import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRothLimitUpdate, rothEnvelopeHash } from '../lib/roth-monitor.mjs';
import { forecastRoth } from '../lib/roth.mjs';
import { rothEnvelopeFixture, ROTH_TEST_NOW } from './roth-policy-fixture.mjs';

const input = (overrides = {}) => ({ envelope: rothEnvelopeFixture(), verifiedOfficialSources: true,
  limits: [], now: new Date(ROTH_TEST_NOW).toISOString(), ...overrides });
// This next-year amount is a SYNTHETIC test value, not a published IRS limit.
const future = (overrides = {}) => ({ year: 2027, baseLimitCents: 800000, catchUpLimitCents: 120000,
  verifiedAt: new Date(ROTH_TEST_NOW).toISOString(), sourceUrls: ['https://www.irs.gov/newsroom/synthetic-offline-test'], ...overrides });

test('a new official year changes only statutory policy and an unverified annual placeholder', () => {
  const source = input({ limits: [future()] }), untouched = structuredClone(source);
  const result = prepareRothLimitUpdate(source);
  assert.equal(result.requiresWrite, true);
  assert.equal(result.shouldNotify, true);
  assert.deepEqual(source, untouched);
  assert.deepEqual(result.patch.evidence, source.envelope.evidence);
  assert.deepEqual(result.patch.policy.years[0], source.envelope.policy.years[0]);
  assert.deepEqual(result.patch.policy.statutoryLimits[0], source.envelope.policy.statutoryLimits[0]);
  assert.equal(result.patch.policy.years[1].eligibility.status, 'unverified');
  assert.equal(result.patch.policy.years[1].exclusiveCoordinator.confirmed, false);
  const forecast = forecastRoth(result.patch.policy, { now: Date.parse('2027-01-01T15:00:00Z') });
  assert.equal(forecast.monthlyAmountCents, 66666);
  assert.equal(forecast.installments.reduce((total, month) => total + month.amountCents, 0), 800000);
  assert.equal(forecast.amountInCents, 0);
});

test('same amounts and no newly published year produce no configuration heartbeat writes', () => {
  const source = input();
  assert.equal(prepareRothLimitUpdate(source).requiresWrite, false);
  source.limits = [{ ...source.envelope.policy.statutoryLimits[0], verifiedAt: source.now }];
  const result = prepareRothLimitUpdate(source);
  assert.equal(result.requiresWrite, false);
  assert.equal(result.shouldNotify, false);
  assert.equal(result.patch, null);
});

test('published-year conflicts require review without overwriting the baseline', () => {
  const source = input({ limits: [future({ year: 2026 })] }), before = structuredClone(source);
  assert.throws(() => prepareRothLimitUpdate(source), { code: 'ROTH_PUBLISHED_LIMIT_CONFLICT' });
  assert.deepEqual(source, before);
});

test('new statutory evidence never overwrites already verified next-year personal facts', () => {
  const source = input({ limits: [future()] });
  const proof = 'Synthetic offline review';
  const personal = { year: 2027, catchUpEligible: false,
    eligibility: { status: 'verified', annualRothLimitCents: 500000, annualCombinedLimitCents: 500000, verifiedAt: source.envelope.policy.updatedAt, reference: proof },
    outsideContributions: { status: 'verified', traditionalCents: 10000, rothCents: 20000, verifiedAt: source.envelope.policy.updatedAt, reference: proof },
    exclusiveCoordinator: { confirmed: true, confirmedAt: source.envelope.policy.updatedAt, reference: proof },
    otherSchedule: { status: 'none', verifiedAt: source.envelope.policy.updatedAt, reference: proof } };
  source.envelope.policy.years.push(personal);
  const result = prepareRothLimitUpdate(source);
  assert.deepEqual(result.patch.policy.years[1], personal);
});

test('source assertions, IRS URLs, dates and year window are required', () => {
  assert.throws(() => prepareRothLimitUpdate(input({ verifiedOfficialSources: false })), { code: 'ROTH_MONITOR_INPUT_INVALID' });
  assert.throws(() => prepareRothLimitUpdate(input({ limits: [future({ sourceUrls: ['https://irs.gov.example.test/cap'] })] })), { code: 'ROTH_IRS_SOURCE_INVALID' });
  assert.throws(() => prepareRothLimitUpdate(input({ limits: [future({ year: 2028 })] })), { code: 'ROTH_MONITOR_YEAR_OUTSIDE_WINDOW' });
  assert.throws(() => prepareRothLimitUpdate(input({ limits: [future({ verifiedAt: '2026-10-27T12:00:00Z' })] })), { code: 'ROTH_MONITOR_SOURCE_NOT_CURRENT' });
  assert.throws(() => prepareRothLimitUpdate(input({ limits: [future(), future()] })), { code: 'ROTH_MONITOR_DUPLICATE_YEAR' });
});

test('monitor timestamps reject normalized calendar errors and accept exact UTC fractions', () => {
  for (const now of ['2027-02-30T12:00:00Z', '2027-02-29T12:00:00Z', '2026-10-29T24:00:00Z']) {
    assert.throws(() => prepareRothLimitUpdate(input({ now })), { code: 'ROTH_MONITOR_TIME_INVALID' });
  }
  for (const now of ['2026-10-29T20:00:00Z', '2026-10-29T20:00:00.1Z', '2026-10-29T20:00:00.12Z', '2026-10-29T20:00:00.123Z']) {
    assert.equal(prepareRothLimitUpdate(input({ now })).requiresWrite, false);
  }
});

test('snapshot hashes detect a concurrent personal or route evidence change', () => {
  const source = input({ limits: [future()] }), prepared = prepareRothLimitUpdate(source);
  assert.equal(prepared.expectedEnvelopeHash, rothEnvelopeHash(source.envelope));
  source.envelope.policy.years[0].catchUpEligible = false;
  assert.notEqual(prepared.expectedEnvelopeHash, rothEnvelopeHash(source.envelope));
  const reordered = Object.fromEntries(Object.entries(source.envelope).reverse());
  assert.equal(rothEnvelopeHash(source.envelope), rothEnvelopeHash(reordered));
});
