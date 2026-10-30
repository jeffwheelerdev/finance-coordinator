import { createHash } from 'node:crypto';

export const ROTH_TIME_ZONE = 'America/New_York';
export const ROTH_POLICY_ID = 'roth-ira';
export const ROTH_DUE_HOUR_UTC = 15;
const MAX_BYTES = 256_000;
const MAX_YEARS = 100;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class RothPolicyError extends Error {
  constructor(code) { super(code); this.name = 'RothPolicyError'; this.code = code; }
}
const invalid = code => { throw new RothPolicyError(code); };

function shape(value, required, optional, code = 'ROTH_POLICY_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid(code);
}

function cents(value, code = 'ROTH_AMOUNT_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
  return value;
}

function safeSum(...values) {
  const total = values.reduce((sum, value) => sum + BigInt(cents(value)), 0n);
  if (total > MAX_SAFE) invalid('ROTH_AMOUNT_OVERFLOW');
  return Number(total);
}

function yearNumber(value) {
  if (!Number.isSafeInteger(value) || value < 2000 || value > 9998) invalid('ROTH_YEAR_INVALID');
  return value;
}

function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('ROTH_EVIDENCE_INVALID');
  }
  return value.trim();
}

function timestamp(value, code = 'ROTH_TIMESTAMP_INVALID') {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) invalid(code);
  const [, y, m, d, h, minute, second, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(h) > 23 ||
      Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) invalid(code);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) invalid(code);
  return new Date(millis).toISOString();
}

function irsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) invalid('ROTH_IRS_SOURCE_INVALID');
  let url;
  try { url = new URL(value); } catch { invalid('ROTH_IRS_SOURCE_INVALID'); }
  if (url.protocol !== 'https:' || !['www.irs.gov', 'irs.gov'].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    invalid('ROTH_IRS_SOURCE_INVALID');
  }
  return url.href;
}

function proof(value, amountFields, label) {
  if (value?.status === 'unverified') {
    shape(value, ['status'], [], label);
    return { status: 'unverified' };
  }
  shape(value, ['status', ...amountFields, 'verifiedAt', 'reference'], [], label);
  if (value.status !== 'verified') invalid(label);
  return {
    status: 'verified',
    ...Object.fromEntries(amountFields.map(key => [key, cents(value[key])])),
    verifiedAt: timestamp(value.verifiedAt), reference: text(value.reference),
  };
}

function personalYear(value) {
  shape(value, ['year', 'catchUpEligible', 'eligibility', 'outsideContributions', 'exclusiveCoordinator', 'otherSchedule'], []);
  if (value.catchUpEligible !== null && typeof value.catchUpEligible !== 'boolean') invalid('ROTH_CATCH_UP_INVALID');
  const eligibility = proof(value.eligibility, ['annualRothLimitCents', 'annualCombinedLimitCents'], 'ROTH_ELIGIBILITY_INVALID');
  if (eligibility.status === 'verified' && eligibility.annualRothLimitCents > eligibility.annualCombinedLimitCents) {
    invalid('ROTH_PERSONAL_LIMIT_INCONSISTENT');
  }
  const outsideContributions = proof(value.outsideContributions, ['traditionalCents', 'rothCents'], 'ROTH_OUTSIDE_CONTRIBUTIONS_INVALID');
  if (outsideContributions.status === 'verified') safeSum(outsideContributions.traditionalCents, outsideContributions.rothCents);
  let exclusiveCoordinator;
  if (value.exclusiveCoordinator?.confirmed === false) {
    shape(value.exclusiveCoordinator, ['confirmed'], [], 'ROTH_EXCLUSIVITY_INVALID');
    exclusiveCoordinator = { confirmed: false };
  } else {
    shape(value.exclusiveCoordinator, ['confirmed', 'confirmedAt', 'reference'], [], 'ROTH_EXCLUSIVITY_INVALID');
    if (value.exclusiveCoordinator.confirmed !== true) invalid('ROTH_EXCLUSIVITY_INVALID');
    exclusiveCoordinator = { confirmed: true, confirmedAt: timestamp(value.exclusiveCoordinator.confirmedAt), reference: text(value.exclusiveCoordinator.reference) };
  }
  let otherSchedule;
  if (value.otherSchedule?.status === 'unverified') {
    shape(value.otherSchedule, ['status'], [], 'ROTH_OTHER_SCHEDULE_INVALID');
    otherSchedule = { status: 'unverified' };
  } else {
    shape(value.otherSchedule, ['status', 'verifiedAt', 'reference'], [], 'ROTH_OTHER_SCHEDULE_INVALID');
    if (value.otherSchedule.status !== 'none') invalid('ROTH_OTHER_SCHEDULE_INVALID');
    otherSchedule = { status: 'none', verifiedAt: timestamp(value.otherSchedule.verifiedAt), reference: text(value.otherSchedule.reference) };
  }
  return { year: yearNumber(value.year), catchUpEligible: value.catchUpEligible, eligibility, outsideContributions, exclusiveCoordinator, otherSchedule };
}

/** A private policy records reviewed tax-year facts, not inferred bank balances.
 * Unverified values are distinct from verified zero. Annual personal evidence
 * does not carry into another tax year, even if the published limit is unchanged.
 * Route/custodian classification and cash-flow checks belong to the executor.
 */
export function parseRothPolicy(input) {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) invalid('ROTH_POLICY_TOO_LARGE');
    try { value = JSON.parse(value); } catch { invalid('ROTH_POLICY_JSON_INVALID'); }
  }
  shape(value, ['schemaVersion', 'id', 'timeZone', 'updatedAt', 'statutoryLimits', 'years'], []);
  if (value.schemaVersion !== 1 || value.id !== ROTH_POLICY_ID || value.timeZone !== ROTH_TIME_ZONE) invalid('ROTH_POLICY_IDENTITY_INVALID');
  if (!Array.isArray(value.statutoryLimits) || !Array.isArray(value.years) ||
      value.statutoryLimits.length > MAX_YEARS || value.years.length > MAX_YEARS) invalid('ROTH_POLICY_YEARS_INVALID');
  const updatedAt = timestamp(value.updatedAt);
  const statutoryLimits = value.statutoryLimits.map(item => {
    shape(item, ['year', 'baseLimitCents', 'catchUpLimitCents', 'verifiedAt', 'sourceUrls'], []);
    if (!Array.isArray(item.sourceUrls) || item.sourceUrls.length < 1 || item.sourceUrls.length > 10) invalid('ROTH_IRS_SOURCE_INVALID');
    const sourceUrls = item.sourceUrls.map(irsUrl).sort();
    if (new Set(sourceUrls).size !== sourceUrls.length) invalid('ROTH_IRS_SOURCE_INVALID');
    const baseLimitCents = cents(item.baseLimitCents), catchUpLimitCents = cents(item.catchUpLimitCents);
    safeSum(baseLimitCents, catchUpLimitCents);
    return { year: yearNumber(item.year), baseLimitCents, catchUpLimitCents, verifiedAt: timestamp(item.verifiedAt), sourceUrls };
  }).sort((a, b) => a.year - b.year);
  const years = value.years.map(personalYear).sort((a, b) => a.year - b.year);
  if (new Set(statutoryLimits.map(item => item.year)).size !== statutoryLimits.length ||
      new Set(years.map(item => item.year)).size !== years.length) invalid('ROTH_DUPLICATE_YEAR');
  const times = statutoryLimits.map(item => item.verifiedAt);
  for (const item of years) {
    if (item.eligibility.status === 'verified') times.push(item.eligibility.verifiedAt);
    if (item.outsideContributions.status === 'verified') times.push(item.outsideContributions.verifiedAt);
    if (item.exclusiveCoordinator.confirmed) times.push(item.exclusiveCoordinator.confirmedAt);
    if (item.otherSchedule.status === 'none') times.push(item.otherSchedule.verifiedAt);
    const limit = statutoryLimits.find(entry => entry.year === item.year);
    if (limit && item.eligibility.status === 'verified' && item.catchUpEligible !== null) {
      const applicable = safeSum(limit.baseLimitCents, item.catchUpEligible ? limit.catchUpLimitCents : 0);
      if (item.eligibility.annualCombinedLimitCents > applicable) invalid('ROTH_PERSONAL_LIMIT_EXCEEDS_STATUTORY');
    }
  }
  if (times.some(time => Date.parse(time) > Date.parse(updatedAt))) invalid('ROTH_EVIDENCE_NEWER_THAN_POLICY');
  return { schemaVersion: 1, id: ROTH_POLICY_ID, timeZone: ROTH_TIME_ZONE, updatedAt, statutoryLimits, years };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function localClock(value) {
  const millis = typeof value === 'string' ? Date.parse(timestamp(value, 'ROTH_NOW_INVALID')) : value instanceof Date ? value.getTime() : value;
  if (typeof millis !== 'number' || !Number.isFinite(millis) || !Number.isFinite(new Date(millis).getTime())) invalid('ROTH_NOW_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ROTH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(millis);
  const part = type => parts.find(item => item.type === type)?.value;
  return { millis, iso: new Date(millis).toISOString(), year: yearNumber(Number(part('year'))), month: Number(part('month')), effectiveDate: `${part('year')}-${part('month')}-${part('day')}` };
}

function installment(annualCents, month) {
  const total = BigInt(annualCents);
  return Number(total * BigInt(month) / 12n - total * BigInt(month - 1) / 12n);
}

/** Current-month contribution only. The caller supplies the total of all own
 * immutable requests for this tax year, including unresolved and settled ones.
 * On retry it excludes that same request before rechecking the frozen amount.
 * The executor separately enforces one intent per month and provider cash rules.
 */
export function forecastRoth(input, options = {}) {
  shape(options, [], ['now', 'activationAt', 'ownReservedCents'], 'ROTH_FORECAST_OPTIONS_INVALID');
  const policy = parseRothPolicy(input);
  const clock = localClock(Object.hasOwn(options, 'now') ? options.now : Date.now());
  if (Date.parse(policy.updatedAt) > clock.millis) invalid('ROTH_POLICY_FROM_FUTURE');
  const ownReservedCents = Object.hasOwn(options, 'ownReservedCents') ? cents(options.ownReservedCents) : 0;
  const statutory = policy.statutoryLimits.find(item => item.year === clock.year);
  const personal = policy.years.find(item => item.year === clock.year);
  const blockers = [];
  if (!statutory) blockers.push('ROTH_STATUTORY_LIMIT_UNVERIFIED');
  if (!personal) blockers.push('ROTH_YEAR_POLICY_MISSING');
  const catchUpEligible = personal?.catchUpEligible ?? null;
  if (catchUpEligible === null) blockers.push('ROTH_CATCH_UP_ELIGIBILITY_UNVERIFIED');
  const statutoryLimitCents = statutory && catchUpEligible !== null
    ? safeSum(statutory.baseLimitCents, catchUpEligible ? statutory.catchUpLimitCents : 0) : null;
  const eligibility = personal?.eligibility;
  const annualRothLimitCents = eligibility?.status === 'verified' ? eligibility.annualRothLimitCents : null;
  const annualCombinedLimitCents = eligibility?.status === 'verified' ? eligibility.annualCombinedLimitCents : null;
  if (eligibility?.status !== 'verified') blockers.push('ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED');
  const outside = personal?.outsideContributions;
  if (outside?.status !== 'verified') blockers.push('ROTH_OUTSIDE_CONTRIBUTIONS_UNVERIFIED');
  if (personal?.exclusiveCoordinator.confirmed !== true) blockers.push('ROTH_EXCLUSIVE_COORDINATOR_UNCONFIRMED');
  if (personal?.otherSchedule.status !== 'none') blockers.push('ROTH_OTHER_SCHEDULE_UNVERIFIED');

  const dueAt = new Date(Date.UTC(clock.year, clock.month - 1, 1, ROTH_DUE_HOUR_UTC)).toISOString();
  if (clock.millis < Date.parse(dueAt)) blockers.push('ROTH_MONTH_NOT_DUE');
  let activationAt = null;
  if (options.activationAt === undefined || options.activationAt === null) blockers.push('ROTH_ACTIVATION_REQUIRED');
  else {
    activationAt = timestamp(options.activationAt, 'ROTH_ACTIVATION_INVALID');
    if (Date.parse(activationAt) > clock.millis) blockers.push('ROTH_ACTIVATION_NOT_STARTED');
    if (Date.parse(dueAt) < Date.parse(activationAt)) blockers.push('ROTH_MONTH_PREDATES_ACTIVATION');
  }

  // An unverified catch-up election never increases even the indicative amount.
  const previewStatutory = statutory ? safeSum(statutory.baseLimitCents, catchUpEligible === true ? statutory.catchUpLimitCents : 0) : null;
  const previewAnnualLimitCents = previewStatutory === null ? null
    : annualRothLimitCents === null ? previewStatutory : Math.min(annualRothLimitCents, previewStatutory);
  const monthlyAmountCents = previewAnnualLimitCents === null ? null : installment(previewAnnualLimitCents, clock.month);
  const installments = previewAnnualLimitCents === null ? [] : Array.from({ length: 12 }, (_, index) => ({
    month: index + 1, monthKey: `${clock.year}-${String(index + 1).padStart(2, '0')}`,
    dueAt: new Date(Date.UTC(clock.year, index, 1, ROTH_DUE_HOUR_UTC)).toISOString(),
    amountCents: installment(previewAnnualLimitCents, index + 1),
  }));

  let remainingRothCents = null, remainingCombinedCents = null, remainingAnnualCents = null;
  if (annualRothLimitCents !== null && outside?.status === 'verified') {
    const rothUsed = safeSum(outside.rothCents, ownReservedCents);
    const combinedUsed = safeSum(outside.traditionalCents, outside.rothCents, ownReservedCents);
    remainingRothCents = Math.max(0, annualRothLimitCents - rothUsed);
    remainingCombinedCents = Math.max(0, annualCombinedLimitCents - combinedUsed);
    remainingAnnualCents = Math.min(remainingRothCents, remainingCombinedCents);
    if (rothUsed > annualRothLimitCents || combinedUsed > annualCombinedLimitCents) blockers.push('ROTH_ANNUAL_LIMIT_EXCEEDED');
  }
  const eligible = blockers.length === 0;
  const amountInCents = eligible ? Math.min(monthlyAmountCents, remainingAnnualCents) : 0;
  return {
    policyId: policy.id, policyHash: createHash('sha256').update(JSON.stringify(canonical(policy))).digest('hex'),
    policyUpdatedAt: policy.updatedAt, year: clock.year, month: clock.month,
    monthKey: `${clock.year}-${String(clock.month).padStart(2, '0')}`, effectiveDate: clock.effectiveDate,
    timeZone: ROTH_TIME_ZONE, calculatedAt: clock.iso, dueAt, activationAt,
    statutoryBaseLimitCents: statutory?.baseLimitCents ?? null,
    statutoryCatchUpLimitCents: statutory?.catchUpLimitCents ?? null,
    statutoryVerifiedAt: statutory?.verifiedAt ?? null, statutorySourceUrls: statutory?.sourceUrls ?? [],
    catchUpEligible, statutoryLimitCents, annualRothLimitCents, annualCombinedLimitCents,
    outsideTraditionalCents: outside?.status === 'verified' ? outside.traditionalCents : null,
    outsideRothCents: outside?.status === 'verified' ? outside.rothCents : null,
    ownReservedCents, remainingRothCents, remainingCombinedCents, remainingAnnualCents,
    previewAnnualLimitCents, monthlyAmountCents, installments, amountInCents, eligible, blockers,
    reason: !eligible ? blockers[0] : amountInCents > 0 ? 'READY' : remainingAnnualCents === 0 ? 'ROTH_ANNUAL_LIMIT_REACHED' : 'ROTH_MONTHLY_INSTALLMENT_ZERO',
  };
}
