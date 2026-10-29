import { createHash } from 'node:crypto';

/**
 * A private catalog of obligations, not a transaction feed. Project current
 * commitments into a whole local calendar year; this is not historical spend.
 * Payment observations must already be matched to an exact catalog ID by the
 * authenticated caller. No merchant-name or amount/date identity inference.
 */
export const BILLS_TIME_ZONE = 'America/New_York';
export const BILLS_ROUNDING_CENTS = 50_000;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BILLS = 250;
const DAY_MS = 86_400_000;
const ID = /^[a-z][a-z0-9_-]{0,95}$/;
const FREQUENCIES = new Set(['monthly', 'annual', 'quarterly', 'semiannual', 'weekly', 'biweekly', 'semimonthly']);
const STATUSES = new Set(['active', 'uncertain', 'canceled']);
const KINDS = new Set(['expense', 'card_payment', 'internal_transfer']);
const EVIDENCE_TYPES = new Set(['user_confirmation', 'invoice', 'posted_transaction', 'provider_schedule', 'budget_allowance']);
const STRONG_EVIDENCE = new Set(['user_confirmation', 'invoice', 'provider_schedule']);

export class BillsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BillsError';
    this.code = code;
  }
}

function invalid(code, message) { throw new BillsError(code, message); }

function shape(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid('INVALID_BILLS_CATALOG', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    invalid('INVALID_BILLS_CATALOG', `${label} has missing or unsupported fields`);
  }
}

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('INVALID_BILLS_CATALOG', `${label} must be nonempty bounded text`);
  }
  return value.trim();
}

function billId(value) {
  if (typeof value !== 'string' || !ID.test(value) || Object.hasOwn(Object.prototype, value)) {
    invalid('INVALID_BILL_ID', 'Bill ID must be a stable lowercase identifier');
  }
  return value;
}

function cents(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid('INVALID_BILL_AMOUNT', 'Bill amounts must be positive safe integer cents');
  }
  return value;
}

function safe(value) {
  if (value < 0n || value > MAX_SAFE) invalid('BILLS_AMOUNT_OVERFLOW', 'Bill projection exceeds safe integer cents');
  return Number(value);
}

function add(a, b) { return safe(BigInt(a) + BigInt(b)); }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function dateOnly(value, label = 'date') {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) invalid('INVALID_BILL_DATE', `${label} must be YYYY-MM-DD`);
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    invalid('INVALID_BILL_DATE', `${label} must be a valid calendar date`);
  }
  return { value, year, month, day, time: Date.UTC(year, month - 1, day) };
}

function timestamp(value, label) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) invalid('INVALID_BILL_TIMESTAMP', `${label} must be a timezone-qualified ISO datetime`);
  dateOnly(match[1], label);
  const [, , h, m, s, zone] = match;
  if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    invalid('INVALID_BILL_TIMESTAMP', `${label} must be a valid datetime`);
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) invalid('INVALID_BILL_TIMESTAMP', `${label} must be a valid datetime`);
  return new Date(result).toISOString();
}

function evidence(value) {
  shape(value, ['type', 'reference', 'observedAt'], [], 'evidence');
  if (!EVIDENCE_TYPES.has(value.type)) invalid('INVALID_BILL_EVIDENCE', 'Unsupported evidence type');
  return {
    type: value.type,
    reference: text(value.reference, 1000, 'Evidence reference'),
    observedAt: timestamp(value.observedAt, 'Evidence observedAt'),
  };
}

function cancellation(value) {
  shape(value, ['confirmed', 'effectiveOn', 'reference'], [], 'cancellation');
  if (value.confirmed !== true) invalid('UNCONFIRMED_BILL_CANCELLATION', 'Cancellation needs explicit confirmation');
  return {
    confirmed: true,
    effectiveOn: dateOnly(value.effectiveOn, 'Cancellation effectiveOn').value,
    reference: text(value.reference, 1000, 'Cancellation reference'),
  };
}

function parseBill(value) {
  shape(value, ['id', 'name', 'kind', 'status', 'amountCents', 'frequency', 'evidence'],
    ['anchorDate', 'dueDays', 'cancellation'], 'bill');
  if (!KINDS.has(value.kind)) invalid('INVALID_BILL_KIND', 'Unsupported obligation kind');
  if (!STATUSES.has(value.status)) invalid('INVALID_BILL_STATUS', 'Unsupported bill status');
  if (!FREQUENCIES.has(value.frequency)) invalid('INVALID_BILL_FREQUENCY', 'Unsupported bill frequency');
  const result = {
    id: billId(value.id), name: text(value.name, 160, 'Bill name'),
    kind: value.kind, status: value.status, amountCents: cents(value.amountCents),
    frequency: value.frequency, evidence: evidence(value.evidence),
  };
  if (value.anchorDate !== undefined) result.anchorDate = dateOnly(value.anchorDate, 'Bill anchorDate').value;
  if (['quarterly', 'semiannual', 'weekly', 'biweekly'].includes(value.frequency) && !result.anchorDate) {
    invalid('MISSING_BILL_ANCHOR', 'This frequency requires an exact calendar anchor');
  }
  if (value.frequency === 'semimonthly') {
    if (!Array.isArray(value.dueDays) || value.dueDays.length !== 2 ||
        value.dueDays.some(day => !Number.isInteger(day) || day < 1 || day > 31) || value.dueDays[0] === value.dueDays[1]) {
      invalid('INVALID_BILL_DUE_DAYS', 'Semimonthly bills require two distinct days of month');
    }
    result.dueDays = [...value.dueDays].sort((a, b) => a - b);
  } else if (value.dueDays !== undefined) {
    invalid('INVALID_BILL_DUE_DAYS', 'dueDays applies only to semimonthly bills');
  }
  if (value.status === 'canceled') {
    if (!value.cancellation || !STRONG_EVIDENCE.has(result.evidence.type)) {
      invalid('UNCONFIRMED_BILL_CANCELLATION', 'Canceled bills require explicit user or provider evidence');
    }
    result.cancellation = cancellation(value.cancellation);
  } else if (value.cancellation !== undefined) {
    invalid('INVALID_BILL_STATUS', 'Cancellation evidence conflicts with the selected bill status');
  }
  return result;
}

/** Parse private configuration. Numeric dollars, missing/zero amounts, guessed
 * status, duplicate IDs and unsupported fields are errors, never defaults. */
export function parseBillCatalog(input) {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > 1_000_000) invalid('BILLS_CATALOG_TOO_LARGE');
    try { value = JSON.parse(input); } catch { invalid('INVALID_BILLS_JSON', 'Bill catalog must contain valid JSON'); }
  }
  shape(value, ['schemaVersion', 'timeZone', 'updatedAt', 'bills'], [], 'catalog');
  if (value.schemaVersion !== 1) invalid('INVALID_BILLS_VERSION', 'Unsupported bill catalog schema');
  if (value.timeZone !== BILLS_TIME_ZONE) invalid('INVALID_BILLS_TIME_ZONE', 'Bill calendar must use America/New_York');
  if (!Array.isArray(value.bills) || value.bills.length === 0 || value.bills.length > MAX_BILLS) {
    invalid('INVALID_BILLS_COUNT', 'Bill catalog must contain between one and 250 entries');
  }
  const updatedAt = timestamp(value.updatedAt, 'Catalog updatedAt');
  const bills = value.bills.map(parseBill).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (new Set(bills.map(bill => bill.id)).size !== bills.length) invalid('DUPLICATE_BILL_ID', 'Bill IDs must be unique');
  if (bills.some(bill => Date.parse(bill.evidence.observedAt) > Date.parse(updatedAt))) {
    invalid('INCONSISTENT_BILL_TIMESTAMP', 'Evidence cannot be newer than its catalog revision');
  }
  return { schemaVersion: 1, timeZone: BILLS_TIME_ZONE, updatedAt, bills };
}

function localClock(now) {
  let millis;
  if (typeof now === 'string') millis = Date.parse(timestamp(now, 'Forecast now'));
  else if (now instanceof Date) millis = now.getTime();
  else millis = now;
  if (typeof millis !== 'number' || !Number.isFinite(millis)) invalid('INVALID_BILLS_NOW', 'Forecast now must be a valid instant');
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) invalid('INVALID_BILLS_NOW', 'Forecast now must be a valid instant');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BILLS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const part = name => parts.find(item => item.type === name)?.value;
  return { year: Number(part('year')), date: `${part('year')}-${part('month')}-${part('day')}`, iso: date.toISOString() };
}

function occurrenceCounts(bill, year) {
  const counts = Array(12).fill(0);
  const anchor = bill.anchorDate ? dateOnly(bill.anchorDate) : null;
  if (bill.frequency === 'monthly') return counts.fill(1);
  if (bill.frequency === 'semimonthly') return counts.fill(2);
  if (bill.frequency === 'annual') {
    if (anchor) counts[anchor.month - 1] = 1;
    return counts;
  }
  if (bill.frequency === 'quarterly' || bill.frequency === 'semiannual') {
    const period = bill.frequency === 'quarterly' ? 3 : 6;
    for (let month = 1; month <= 12; month += 1) {
      if (((year * 12 + month) - (anchor.year * 12 + anchor.month)) % period === 0) counts[month - 1] = 1;
    }
    return counts;
  }
  const step = (bill.frequency === 'weekly' ? 7 : 14) * DAY_MS;
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  // Calendar-only arithmetic deliberately avoids daylight-saving hour shifts.
  let due = anchor.time + Math.ceil((start - anchor.time) / step) * step;
  for (; due < end; due += step) counts[new Date(due).getUTCMonth()] += 1;
  return counts;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

/**
 * Highest projected calendar month at today's catalog rates. Unknown annual
 * renewals are packed into the already-highest month, rather than averaged.
 * A confirmed future cancellation remains included until its effective date;
 * this errs toward retaining an obligation, never prematurely removing it.
 * Annual February 29 renewals remain in February in non-leap years.
 */
export function forecastBills(input, options = {}) {
  shape(options, [], ['now', 'year'], 'forecast options');
  const catalog = parseBillCatalog(input);
  const clock = localClock(Object.hasOwn(options, 'now') ? options.now : Date.now());
  const year = Object.hasOwn(options, 'year') ? options.year : clock.year;
  if (!Number.isInteger(year) || year < 2000 || year > 9998) invalid('INVALID_BILLS_YEAR', 'Forecast year must be an integer from 2000 through 9998');
  const months = Array.from({ length: 12 }, (_, index) => ({ month: `${year}-${String(index + 1).padStart(2, '0')}`, totalCents: 0 }));
  const warnings = [];
  let unknownAnnualCents = 0, includedBillCount = 0;
  for (const bill of catalog.bills) {
    if (bill.kind !== 'expense') {
      warnings.push({ code: 'NON_EXPENSE_EXCLUDED', billId: bill.id });
      continue;
    }
    if (bill.status === 'canceled' && bill.cancellation.effectiveOn <= clock.date) continue;
    includedBillCount += 1;
    if (bill.status === 'canceled') warnings.push({ code: 'FUTURE_CANCELLATION_RETAINED', billId: bill.id });
    if (bill.status === 'uncertain') warnings.push({ code: 'UNCERTAIN_BILL_INCLUDED', billId: bill.id });
    if (bill.evidence.type === 'budget_allowance') warnings.push({ code: 'BUDGET_ALLOWANCE_USED', billId: bill.id });
    if (bill.frequency === 'annual' && !bill.anchorDate) {
      unknownAnnualCents = add(unknownAnnualCents, bill.amountCents);
      warnings.push({ code: 'ANNUAL_DATE_UNKNOWN', billId: bill.id });
      continue;
    }
    const counts = occurrenceCounts(bill, year);
    for (let i = 0; i < 12; i += 1) months[i].totalCents = add(months[i].totalCents, safe(BigInt(bill.amountCents) * BigInt(counts[i])));
  }
  if (includedBillCount === 0) invalid('NO_ACTIVE_BILLS', 'No eligible expense remains; review the catalog instead of using a zero target');
  let peakIndex = 0;
  for (let i = 1; i < 12; i += 1) if (months[i].totalCents > months[peakIndex].totalCents) peakIndex = i;
  months[peakIndex].totalCents = add(months[peakIndex].totalCents, unknownAnnualCents);
  const peakMonthCents = months[peakIndex].totalCents;
  if (peakMonthCents <= 0) invalid('NO_ACTIVE_BILLS', 'Projection has no positive expense; review the catalog');
  const targetCents = safe(((BigInt(peakMonthCents) + BigInt(BILLS_ROUNDING_CENTS) - 1n) / BigInt(BILLS_ROUNDING_CENTS)) * BigInt(BILLS_ROUNDING_CENTS));
  const annualTotalCents = months.reduce((total, month) => add(total, month.totalCents), 0);
  return {
    targetCents, capCents: targetCents, peakMonthCents, peakMonth: months[peakIndex].month,
    months, annualTotalCents, unknownAnnualCents, includedBillCount, year,
    timeZone: BILLS_TIME_ZONE, calculatedAt: clock.iso, effectiveDate: clock.date, catalogUpdatedAt: catalog.updatedAt,
    catalogHash: createHash('sha256').update(JSON.stringify(canonical(catalog))).digest('hex'),
    warnings,
  };
}

export const calculateBillsTarget = forecastBills;

/**
 * Apply exact-ID observations to a catalog snapshot. User/provider confirmation
 * can change an obligation; a posted debit alone can conservatively increase an
 * amount, but cannot lower, cancel, reactivate or reclassify one. New obligations
 * require a deliberate complete catalog addition, not inferred matching.
 * Every malformed batch fails atomically. Review-required updates preserve the
 * previous record and return a warning rather than silently shrinking a target.
 */
export function applyBillObservations(input, observations, options) {
  const catalog = parseBillCatalog(input);
  shape(options, ['updatedAt'], [], 'observation options');
  const updatedAt = timestamp(options.updatedAt, 'Observation updatedAt');
  if (Date.parse(updatedAt) < Date.parse(catalog.updatedAt)) invalid('STALE_BILLS_REVISION', 'Catalog revision cannot move backward');
  if (!Array.isArray(observations) || observations.length === 0 || observations.length > MAX_BILLS) {
    invalid('INVALID_BILL_OBSERVATIONS', 'Provide between one and 250 observations');
  }
  const byId = new Map(catalog.bills.map(bill => [bill.id, bill]));
  const seen = new Set(), changes = [], warnings = [];
  for (const item of observations) {
    shape(item, ['billId', 'evidence'], ['amountCents', 'status', 'frequency', 'anchorDate', 'dueDays', 'cancellation'], 'observation');
    const id = billId(item.billId), proof = evidence(item.evidence);
    if (seen.has(id)) invalid('DUPLICATE_BILL_OBSERVATION', 'Use one observation per bill in a batch');
    seen.add(id);
    const previous = byId.get(id);
    if (!previous) invalid('UNKNOWN_BILL_ID', 'Observation does not match an existing bill ID');
    if (Date.parse(proof.observedAt) > Date.parse(updatedAt)) invalid('INCONSISTENT_BILL_TIMESTAMP', 'Observation is newer than its catalog revision');
    const supplied = Object.keys(item).filter(key => !['billId', 'evidence'].includes(key));
    if (supplied.length === 0) invalid('EMPTY_BILL_OBSERVATION', 'Observation must supply an amount or schedule/status change');
    const candidate = { ...previous, evidence: proof };
    for (const key of supplied) candidate[key] = item[key];
    if (Object.hasOwn(item, 'cancellation') && candidate.status !== 'canceled') {
      invalid('INVALID_BILL_STATUS', 'Cancellation evidence conflicts with the selected bill status');
    }
    if (Object.hasOwn(item, 'dueDays') && candidate.frequency !== 'semimonthly') {
      invalid('INVALID_BILL_DUE_DAYS', 'dueDays applies only to semimonthly bills');
    }
    if (candidate.status !== 'canceled') delete candidate.cancellation;
    if (candidate.frequency !== 'semimonthly') delete candidate.dueDays;
    // Validate before stale/review handling; bad data must never look accepted.
    const parsed = parseBill(candidate);
    const changedFields = ['amountCents', 'status', 'frequency', 'anchorDate', 'dueDays', 'cancellation']
      .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(parsed[key]));
    if (Date.parse(proof.observedAt) < Date.parse(previous.evidence.observedAt)) {
      warnings.push({ code: 'STALE_BILL_OBSERVATION', billId: id });
      continue;
    }
    if (Date.parse(proof.observedAt) === Date.parse(previous.evidence.observedAt) && changedFields.length > 0) {
      warnings.push({ code: 'CONFLICTING_BILL_OBSERVATION', billId: id });
      continue;
    }
    const strong = STRONG_EVIDENCE.has(proof.type);
    const postedIncrease = proof.type === 'posted_transaction' && previous.status !== 'canceled' &&
      parsed.amountCents >= previous.amountCents && changedFields.every(key => key === 'amountCents');
    if (!strong && !postedIncrease && changedFields.length > 0) {
      warnings.push({ code: 'BILL_CHANGE_REQUIRES_CONFIRMATION', billId: id });
      continue;
    }
    byId.set(id, parsed);
    if (changedFields.length > 0) changes.push({ billId: id, fields: changedFields });
  }
  return {
    catalog: parseBillCatalog({ ...catalog, updatedAt, bills: [...byId.values()] }),
    changes, warnings,
  };
}
