import { createHash } from 'node:crypto';
import { parseRothPolicy, forecastRoth } from './roth.mjs';

const fail = code => { throw Object.assign(new Error(code), { name: 'RothMonitorError', code }); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const rothEnvelopeHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Prepare an IRS-only annual-limit update. This helper neither researches the
 * announcement nor writes it. The caller must verify official IRS evidence,
 * reread the same private snapshot, apply one patch, and read it back.
 * Existing personal evidence, route proof, and prior-year records are preserved.
 */
export function prepareRothLimitUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['envelope', 'limits', 'verifiedOfficialSources', 'now'].includes(key)) ||
      input.verifiedOfficialSources !== true || !Array.isArray(input.limits) || input.limits.length > 2) {
    fail('ROTH_MONITOR_INPUT_INVALID');
  }
  const envelope = input.envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.schemaVersion !== 1 ||
      Object.keys(envelope).some(key => !['schemaVersion', 'policy', 'evidence'].includes(key)) ||
      !envelope.evidence || typeof envelope.evidence !== 'object' || Array.isArray(envelope.evidence)) {
    fail('ROTH_MONITOR_ENVELOPE_INVALID');
  }
  const time = typeof input.now === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(input.now);
  const now = time ? Date.parse(input.now) : NaN;
  // Date.parse normalizes impossible dates and 24:00 into another day. A
  // monitoring timestamp must name the actual instant supplied by the caller.
  if (!time || !Number.isFinite(now) ||
      new Date(now).toISOString() !== `${time[1]}.${(time[2] || '').padEnd(3, '0')}Z`) {
    fail('ROTH_MONITOR_TIME_INVALID');
  }
  const policy = parseRothPolicy(envelope.policy);
  const before = forecastRoth(policy, { now });
  const expectedEnvelopeHash = rothEnvelopeHash(envelope);
  const output = { requiresWrite: false, shouldNotify: false, expectedEnvelopeHash,
    expectedPolicyUpdatedAt: policy.updatedAt, changes: [], patch: null };
  if (new Set(input.limits.map(item => item?.year)).size !== input.limits.length) fail('ROTH_MONITOR_DUPLICATE_YEAR');
  const candidate = structuredClone(policy);
  candidate.updatedAt = new Date(now).toISOString();
  for (const observed of input.limits) {
    // Reuse the strict policy validator for cents, URLs, and calendar evidence.
    const validated = parseRothPolicy({ ...candidate, statutoryLimits: [observed], years: [] }).statutoryLimits[0];
    if (![before.year, before.year + 1].includes(validated.year)) fail('ROTH_MONITOR_YEAR_OUTSIDE_WINDOW');
    if (Date.parse(validated.verifiedAt) > now || now - Date.parse(validated.verifiedAt) > 24 * 60 * 60 * 1000) {
      fail('ROTH_MONITOR_SOURCE_NOT_CURRENT');
    }
    const existing = candidate.statutoryLimits.find(item => item.year === validated.year);
    if (existing) {
      if (existing.baseLimitCents !== validated.baseLimitCents || existing.catchUpLimitCents !== validated.catchUpLimitCents) {
        // A contradictory value for an already verified tax year needs review.
        // A new year's announcement follows the automatic append path below.
        fail('ROTH_PUBLISHED_LIMIT_CONFLICT');
      }
      continue;
    }
    candidate.statutoryLimits.push(validated);
    if (!candidate.years.some(item => item.year === validated.year)) candidate.years.push({
      year: validated.year, catchUpEligible: null, eligibility: { status: 'unverified' },
      outsideContributions: { status: 'unverified' }, exclusiveCoordinator: { confirmed: false },
      otherSchedule: { status: 'unverified' },
    });
    output.changes.push({ year: validated.year, baseLimitCents: validated.baseLimitCents,
      catchUpLimitCents: validated.catchUpLimitCents, sourceUrls: validated.sourceUrls,
      baseMonthlyMinimumCents: Math.floor(validated.baseLimitCents / 12),
      baseMonthlyMaximumCents: Math.ceil(validated.baseLimitCents / 12) });
  }
  if (!output.changes.length) return output;
  if (now <= Date.parse(policy.updatedAt)) fail('ROTH_MONITOR_REVISION_NOT_NEWER');
  output.patch = { ...structuredClone(envelope), policy: parseRothPolicy(candidate) };
  output.requiresWrite = true;
  output.shouldNotify = true;
  return output;
}
