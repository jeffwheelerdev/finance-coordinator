import { EvidenceError } from './evidence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const BAD = new Set(['FAILED', 'PARTIAL', 'APPROVAL_DENIED']);
const PENDING = new Set(['IN_PROGRESS', 'APPROVAL_PENDING']);
const COUNT_KEYS = ['transfersAttempted', 'transfersCompleted', 'transfersFailed', 'transfersPending'];
const fail = (code, review = false) => { throw new EvidenceError(code, { review }); };
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && UUID.test(a) && a.toLowerCase() === b.toLowerCase();

function time(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return NaN;
  const parsed = Date.parse(value), calendar = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) && Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 10) === value.slice(0, 10)
    ? parsed : NaN;
}

function validateSummary(run, ruleId, lower, upper) {
  if (!run || typeof run !== 'object' || Array.isArray(run) || typeof run.id !== 'string' || !UUID.test(run.id) ||
      !sameId(run.ruleId, ruleId) || run.executionMode !== 'LIVE') {
    fail('UPSTREAM_EXECUTION_IDENTITY_INVALID', true);
  }
  const created = time(run.createdAt);
  if (!Number.isFinite(created) || created < lower || created > upper) fail('UPSTREAM_EXECUTION_TIME_INVALID', true);
  if (run.status !== 'EXECUTED' && !BAD.has(run.status) && !PENDING.has(run.status)) {
    fail('UPSTREAM_EXECUTION_STATUS_UNKNOWN', true);
  }
  return created;
}

function validateLatestDetail(detail, summary, ruleId, lower, upper) {
  const created = validateSummary(detail, ruleId, lower, upper);
  if (!sameId(detail.id, summary.id) || created !== time(summary.createdAt)) fail('UPSTREAM_EXECUTION_CHANGED', true);
  if (BAD.has(detail.status)) fail('UPSTREAM_FUNDING_REQUIRES_REVIEW', true);
  if (PENDING.has(detail.status)) fail('UPSTREAM_FUNDING_PENDING');
  if (COUNT_KEYS.some(key => !Number.isSafeInteger(detail[key]) || detail[key] < 0) ||
      !Array.isArray(detail.transferIds) || detail.transferIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(detail.transferIds.map(id => id.toLowerCase())).size !== detail.transferIds.length ||
      typeof detail.conditionsNotMet !== 'boolean' ||
      !(detail.stepIndexMatched === null || Number.isSafeInteger(detail.stepIndexMatched) && detail.stepIndexMatched >= 0) ||
      !(detail.errorMessage === null || typeof detail.errorMessage === 'string') ||
      !(detail.nextAttemptAt === null || Number.isFinite(time(detail.nextAttemptAt)))) {
    fail('UPSTREAM_COUNTS_INCONSISTENT', true);
  }
  if (detail.transfersFailed > 0 || detail.errorMessage !== null) fail('UPSTREAM_FUNDING_REQUIRES_REVIEW', true);
  if (detail.transfersPending > 0 || detail.nextAttemptAt !== null) fail('UPSTREAM_FUNDING_PENDING');
  if (detail.transfersCompleted !== detail.transferIds.length || detail.transfersAttempted < detail.transfersCompleted ||
      (detail.conditionsNotMet && (detail.stepIndexMatched !== null || detail.transfersAttempted !== 0 || detail.transfersCompleted !== 0)) ||
      (!detail.conditionsNotMet && detail.stepIndexMatched === null)) {
    fail('UPSTREAM_COUNTS_INCONSISTENT', true);
  }
}

/**
 * Independent global guard, not a guessed join between funding and payout runs.
 * Every LIVE funding summary in the requested window must be terminal-successful.
 * The provider defines EXECUTED as all transfers completed. Older summaries rely
 * on that contract; only the latest success is re-read for detailed consistency.
 * A legitimate no-match or zero-calculated-amount execution may create no transfers.
 */
export async function verifyUpstreamFunding(client, config, { now = Date.now(), activationAt = null } = {}) {
  const ruleId = config?.rules?.funding;
  const lower = activationAt === null ? -Infinity : time(activationAt);
  if (typeof ruleId !== 'string' || !UUID.test(ruleId) || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) ||
      (activationAt !== null && !Number.isFinite(lower)) || lower > now) fail('UPSTREAM_WINDOW_INVALID', true);
  const result = await client.listRuleExecutions({
    ruleId, executionMode: 'LIVE', to: new Date(now).toISOString(),
    ...(activationAt !== null ? { from: activationAt } : {}),
  });
  if (result?.complete !== true || !Array.isArray(result.items)) fail('INCOMPLETE_FUNDING_HISTORY');
  let latest = null, latestTime = -Infinity, failed = false, pending = false;
  const seen = new Set();
  for (const summary of result.items) {
    const created = validateSummary(summary, ruleId, lower, now), id = summary.id.toLowerCase();
    if (seen.has(id)) fail('UPSTREAM_HISTORY_CHANGED');
    seen.add(id);
    failed ||= BAD.has(summary.status);
    pending ||= PENDING.has(summary.status);
    if (created > latestTime || created === latestTime && id < latest.id.toLowerCase()) {
      latest = summary; latestTime = created;
    }
  }
  // A later successful run does not prove that an earlier failure was reconciled.
  if (failed) fail('UPSTREAM_FUNDING_REQUIRES_REVIEW', true);
  if (pending) fail('UPSTREAM_FUNDING_PENDING');
  if (latest) {
    const detail = await client.getRuleExecution(ruleId, latest.id);
    validateLatestDetail(detail, latest, ruleId, lower, now);
  }
  return { checked: seen.size };
}
