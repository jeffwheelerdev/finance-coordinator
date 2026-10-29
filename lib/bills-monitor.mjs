import { createHash } from 'node:crypto';
import { parseBillCatalog, applyBillObservations, forecastBills } from './bills.mjs';

export const BILL_MONITOR_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
export const BILL_MONITOR_WRITE_WINDOW_MS = 30 * BILL_MONITOR_HEARTBEAT_MS;
export const BILL_MONITOR_MAX_WRITES = 90;
const MAX_ITEMS = 250;
const STRONG_EVIDENCE = new Set(['user_confirmation', 'invoice', 'provider_schedule']);
const REVIEW_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

export class BillsMonitorError extends Error {
  constructor(code) { super(code); this.name = 'BillsMonitorError'; this.code = code; }
}
const invalid = code => { throw new BillsMonitorError(code); };
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function shape(value, required, optional, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid(code);
}

function instant(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) invalid(code);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid(code);
  return { millis, iso: new Date(millis).toISOString() };
}

function currentInstant(value) {
  if (typeof value === 'string') return instant(value, 'BILLS_MONITOR_NOW_INVALID');
  const millis = value instanceof Date ? value.getTime() : value;
  if (typeof millis !== 'number' || !Number.isFinite(millis) || !Number.isFinite(new Date(millis).getTime())) invalid('BILLS_MONITOR_NOW_INVALID');
  return { millis, iso: new Date(millis).toISOString() };
}

function reviewCodes(value) {
  if (!Array.isArray(value) || value.length > 50 || value.some(code => typeof code !== 'string' || !REVIEW_CODE.test(code))) {
    invalid('BILLS_MONITOR_REVIEW_CODES_INVALID');
  }
  return [...new Set(value)].sort();
}

function reviewIssues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid('BILLS_MONITOR_REVIEW_ISSUES_INVALID');
  const parsed = value.map(issue => {
    shape(issue, ['code', 'fingerprint'], [], 'BILLS_MONITOR_REVIEW_ISSUES_INVALID');
    if (!REVIEW_CODE.test(issue.code) || typeof issue.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(issue.fingerprint)) invalid('BILLS_MONITOR_REVIEW_ISSUES_INVALID');
    return { code: issue.code, fingerprint: issue.fingerprint };
  });
  if (new Set(parsed.map(issue => issue.fingerprint)).size !== parsed.length) invalid('BILLS_MONITOR_REVIEW_ISSUES_INVALID');
  return parsed.sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
}

function parseMonitor(value, catalog, now) {
  shape(value, ['schemaVersion', 'source', 'status', 'checkedAt', 'catalogUpdatedAt', 'reviewCodes'],
    ['writeHistory', 'reviewIssues'], 'BILLS_MONITOR_INVALID');
  if (value.schemaVersion !== 1 || value.source !== 'chatgpt_finances' || value.status !== 'ok') invalid('BILLS_MONITOR_INVALID');
  const checked = instant(value.checkedAt, 'BILLS_MONITOR_TIME_INVALID');
  const version = instant(value.catalogUpdatedAt, 'BILLS_MONITOR_TIME_INVALID');
  if (version.iso !== catalog.updatedAt) invalid('BILLS_MONITOR_CATALOG_MISMATCH');
  if (checked.millis < version.millis || checked.millis > now.millis || version.millis > now.millis) invalid('BILLS_MONITOR_TIME_INVALID');
  const codes = reviewCodes(value.reviewCodes), issues = reviewIssues(value.reviewIssues);
  if (issues.some(issue => !codes.includes(issue.code))) invalid('BILLS_MONITOR_REVIEW_ISSUES_INVALID');
  const history = value.writeHistory === undefined ? [catalog.updatedAt] : value.writeHistory;
  if (!Array.isArray(history) || history.length === 0 || history.length > BILL_MONITOR_MAX_WRITES) invalid('BILLS_MONITOR_WRITE_HISTORY_INVALID');
  const times = history.map(value => instant(value, 'BILLS_MONITOR_WRITE_HISTORY_INVALID'));
  if (times.some((time, index) => time.millis > checked.millis || (index > 0 && time.millis <= times[index - 1].millis))) {
    invalid('BILLS_MONITOR_WRITE_HISTORY_INVALID');
  }
  return { checked, codes, issues, history: times };
}

function issueFor(warning) {
  return {
    code: warning.code,
    fingerprint: createHash('sha256').update(JSON.stringify([warning.code, warning.billId ?? null])).digest('hex'),
  };
}

/**
 * Pure preparation for ONE atomic private configuration patch. The caller must
 * fetch fresh Finance records, verify coverage, and compare both expected values
 * again immediately before writing. This helper has no network or write access.
 * Missing payments never delete bills. A lower transaction becomes a review
 * issue; a new recurring obligation needs exact identity and strong evidence.
 */
export function prepareBillsUpdate(input) {
  shape(input, ['catalog', 'monitor'], ['verifiedCoverage', 'observations', 'additions', 'reviewCodes', 'now'], 'BILLS_MONITOR_INPUT_INVALID');
  if (input.verifiedCoverage !== true) invalid('BILLS_FINANCE_COVERAGE_UNVERIFIED');
  const now = currentInstant(Object.hasOwn(input, 'now') ? input.now : Date.now());
  const priorCatalog = parseBillCatalog(input.catalog);
  const originalCatalog = typeof input.catalog === 'string' ? JSON.parse(input.catalog) : copy(input.catalog);
  const originalMonitor = copy(input.monitor);
  const priorMonitor = parseMonitor(originalMonitor, priorCatalog, now);
  const priorForecast = forecastBills(priorCatalog, { now: priorMonitor.checked.millis });
  const currentForecast = forecastBills(priorCatalog, { now: now.millis });
  const observations = input.observations ?? [], additions = input.additions ?? [];
  if (!Array.isArray(observations) || observations.length > MAX_ITEMS || !Array.isArray(additions) || additions.length > MAX_ITEMS) {
    invalid('BILLS_MONITOR_BATCH_INVALID');
  }
  if ((Object.hasOwn(input, 'observations') && input.observations === null) || (Object.hasOwn(input, 'additions') && input.additions === null)) {
    invalid('BILLS_MONITOR_BATCH_INVALID');
  }
  let candidate = priorCatalog, changes = [], observationWarnings = [];
  if (observations.length > 0) {
    const result = applyBillObservations(priorCatalog, observations, { updatedAt: now.iso });
    candidate = result.catalog;
    changes = result.changes;
    observationWarnings = result.warnings;
  }
  const priorIds = new Set(priorCatalog.bills.map(bill => bill.id));
  for (const addition of additions) {
    if (!addition || typeof addition !== 'object' || Array.isArray(addition) ||
        addition.kind !== 'expense' || addition.status !== 'active' || !STRONG_EVIDENCE.has(addition.evidence?.type)) {
      invalid('BILLS_NEW_OBLIGATION_UNVERIFIED');
    }
    if (priorIds.has(addition.id)) invalid('BILLS_ADDITION_ID_EXISTS');
    priorIds.add(addition.id);
    candidate = { ...candidate, bills: [...candidate.bills, copy(addition)] };
    changes.push({ billId: addition.id, fields: ['added'] });
  }
  const policyChanged = changes.length > 0;
  if (policyChanged && now.millis <= Date.parse(priorCatalog.updatedAt)) invalid('BILLS_MONITOR_TIME_NOT_ADVANCED');
  candidate = policyChanged ? parseBillCatalog({ ...candidate, updatedAt: now.iso }) : priorCatalog;
  if (priorCatalog.bills.some(bill => !candidate.bills.some(next => next.id === bill.id))) invalid('BILLS_MONITOR_ID_REMOVED');
  const nextForecast = forecastBills(candidate, { now: now.millis });

  const suppliedCodes = Object.hasOwn(input, 'reviewCodes') ? reviewCodes(input.reviewCodes) : priorMonitor.codes;
  const nextCodes = reviewCodes([...new Set([...suppliedCodes, ...observationWarnings.map(warning => warning.code)])]);
  const issueMap = new Map(priorMonitor.issues.filter(issue => nextCodes.includes(issue.code)).map(issue => [issue.fingerprint, issue]));
  for (const warning of observationWarnings) {
    const issue = issueFor(warning);
    issueMap.set(issue.fingerprint, issue);
  }
  const nextIssues = reviewIssues([...issueMap.values()]);
  const newReviewIssue = nextCodes.some(code => !priorMonitor.codes.includes(code)) ||
    nextIssues.some(issue => !priorMonitor.issues.some(prior => prior.fingerprint === issue.fingerprint));
  const reviewsChanged = !same(priorMonitor.codes, nextCodes) || !same(priorMonitor.issues, nextIssues);
  const targetChanged = nextForecast.targetCents !== priorForecast.targetCents;
  const yearChanged = nextForecast.year !== priorForecast.year;
  const heartbeatDue = now.millis - priorMonitor.checked.millis >= BILL_MONITOR_HEARTBEAT_MS;
  const requiresWrite = policyChanged || reviewsChanged || targetChanged || yearChanged || heartbeatDue;
  const shouldNotify = policyChanged || targetChanged || newReviewIssue;
  const warnings = [...observationWarnings, ...nextForecast.warnings];
  const expected = { expectedCatalogHash: priorForecast.catalogHash, expectedMonitorCheckedAt: originalMonitor.checkedAt };
  const base = {
    requiresWrite, shouldNotify, blocked: false,
    previousTargetCents: priorForecast.targetCents,
    targetCents: nextForecast.targetCents, peakMonthCents: nextForecast.peakMonthCents,
    warnings, changes, ...expected,
  };
  if (!requiresWrite) return { ...base, catalog: originalCatalog, monitor: originalMonitor, patch: null };
  const activeHistory = priorMonitor.history.filter(time => time.millis > now.millis - BILL_MONITOR_WRITE_WINDOW_MS);
  if (activeHistory.length >= BILL_MONITOR_MAX_WRITES) {
    return {
      ...base, requiresWrite: false, shouldNotify: true, blocked: true, code: 'BILLS_MONITOR_WRITE_QUOTA_REACHED',
      targetCents: currentForecast.targetCents, peakMonthCents: currentForecast.peakMonthCents,
      proposedTargetCents: nextForecast.targetCents,
      warnings: [...warnings, { code: 'BILLS_MONITOR_WRITE_QUOTA_REACHED' }],
      catalog: originalCatalog, monitor: originalMonitor, patch: null,
    };
  }
  if (activeHistory.length > 0 && activeHistory.at(-1).millis >= now.millis) invalid('BILLS_MONITOR_TIME_NOT_ADVANCED');
  const nextCatalog = policyChanged ? candidate : originalCatalog;
  const nextMonitor = {
    schemaVersion: 1, source: 'chatgpt_finances', status: 'ok', checkedAt: now.iso,
    catalogUpdatedAt: candidate.updatedAt, reviewCodes: nextCodes,
    writeHistory: [...activeHistory.map(time => time.iso), now.iso],
    ...(nextIssues.length > 0 ? { reviewIssues: nextIssues } : {}),
  };
  return {
    ...base, catalog: nextCatalog, monitor: nextMonitor,
    patch: { bills_catalog: nextCatalog, bills_monitor: nextMonitor },
  };
}
