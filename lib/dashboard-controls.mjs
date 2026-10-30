/** Private dashboard settings and their audit live inside the existing CAS
 * ledger. These pure helpers never write a provider, change activation gates,
 * reset financial history, or assert a personal financial fact. */
import { createHash } from 'node:crypto';
import { monthlyClock, monthlySlot, nextMonthKey, validateMonthlySchedule, firstEligibleMonth } from './monthly-schedule.mjs';

export const DASHBOARD_CONTROL_FIELDS = Object.freeze(['generalMonthlyBudgetCents', 'generalReserveMonths',
  'incomeReserveCents', 'emergencyTargetCents', 'emergencyRateBasisPoints', 'projectRateBasisPoints', 'executionDay', 'decemberDay']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const MONTH = /^(?:[2-9]\d{3})-(?:0[1-9]|1[0-2])$/;
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class DashboardControlError extends Error {
  constructor(code) { super(code); this.name = 'DashboardControlError'; this.code = code; }
}
const fail = code => { throw new DashboardControlError(code); };
function shape(value, fields) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail('DASHBOARD_SETTINGS_INVALID');
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || iso(Date.parse(value)) !== value) fail('DASHBOARD_SETTINGS_TIME_INVALID');
  return value;
}
function valueFor(key, value) {
  if (!Number.isSafeInteger(value) || value < 0 || key === 'generalReserveMonths' && value < 1 ||
      key.endsWith('RateBasisPoints') && value > 10000 || key === 'executionDay' && (value < 1 || value > 28) ||
      key === 'decemberDay' && (value < 1 || value > 15)) fail('DASHBOARD_SETTINGS_INVALID');
  return value;
}
export function parseDashboardChanges(changes) {
  if (!record(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !DASHBOARD_CONTROL_FIELDS.includes(key))) fail('DASHBOARD_SETTINGS_INVALID');
  return Object.fromEntries(DASHBOARD_CONTROL_FIELDS.filter(key => Object.hasOwn(changes, key)).map(key => [key, valueFor(key, changes[key])]));
}
function settings(value) {
  shape(value, DASHBOARD_CONTROL_FIELDS);
  const result = Object.fromEntries(DASHBOARD_CONTROL_FIELDS.map(key => [key, valueFor(key, value[key])]));
  if (BigInt(result.generalMonthlyBudgetCents) * BigInt(result.generalReserveMonths) > BigInt(Number.MAX_SAFE_INTEGER)) fail('DASHBOARD_SETTINGS_INVALID');
  validateMonthlySchedule(result);
  return result;
}
function defaults(config) {
  const general = config.allocations?.find(row => row.id === 'general-spending');
  return settings({ generalMonthlyBudgetCents: general?.monthlyBudgetCents, generalReserveMonths: general?.reserveMonths,
    incomeReserveCents: config.incomeReserveCents, emergencyTargetCents: config.monthly?.emergencyTargetCents,
    emergencyRateBasisPoints: config.monthly?.emergencyRateBasisPoints, projectRateBasisPoints: config.monthly?.projectRateBasisPoints,
    executionDay: config.monthly?.executionDay ?? 1, decemberDay: config.monthly?.decemberDay ?? 1 });
}
function effective(controls, monthKey) {
  const version = controls.versions.filter(row => row.effectiveMonth <= monthKey).at(-1);
  return version ? { revision: version.revision, effectiveMonth: version.effectiveMonth, settings: version.after }
    : { revision: 0, effectiveMonth: null, settings: controls.baseline.settings };
}
export function validateDashboardControls(value) {
  if (value === undefined || value === null) return null;
  shape(value, ['schemaVersion', 'revision', 'baseline', 'versions']);
  shape(value.baseline, ['capturedAt', 'settings']);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Array.isArray(value.versions) || value.versions.length !== value.revision || value.versions.length > 1000) fail('DASHBOARD_SETTINGS_INVALID');
  timestamp(value.baseline.capturedAt); settings(value.baseline.settings);
  const parsed = { ...value, versions: [] };
  let previousHash = hash(value.baseline), previousAt = Date.parse(value.baseline.capturedAt), previousMonth = null;
  for (const [index, row] of value.versions.entries()) {
    shape(row, ['revision', 'effectiveMonth', 'at', 'actor', 'before', 'after', 'previousHash', 'hash']);
    if (row.revision !== index + 1 || !MONTH.test(row.effectiveMonth ?? '') || Number(row.effectiveMonth.slice(0, 4)) > 9998 ||
        typeof row.actor !== 'string' || !row.actor.trim() || row.actor.length > 100 || /[\x00-\x1f\x7f]/.test(row.actor)) fail('DASHBOARD_SETTINGS_INVALID');
    const at = Date.parse(timestamp(row.at)); settings(row.before); settings(row.after);
    const { hash: actualHash, ...body } = row;
    if (at < previousAt || previousMonth && row.effectiveMonth < previousMonth || row.previousHash !== previousHash || actualHash !== hash(body) ||
        hash(row.before) !== hash(effective(parsed, row.effectiveMonth).settings)) fail('DASHBOARD_SETTINGS_HISTORY_INVALID');
    parsed.versions.push(row); previousAt = at; previousHash = actualHash; previousMonth = row.effectiveMonth;
  }
  return structuredClone(value);
}

function selected(config, state, monthKey) {
  if (!MONTH.test(monthKey ?? '')) fail('DASHBOARD_SETTINGS_MONTH_INVALID');
  const controls = validateDashboardControls(state?.dashboardControls);
  return controls ? effective(controls, monthKey) : { revision: 0, effectiveMonth: null, settings: defaults(config) };
}

export function applyDashboardSelection(config, selection) {
  shape(selection, ['revision', 'effectiveMonth', 'settings']);
  if (!Number.isSafeInteger(selection.revision) || selection.revision < 0 ||
      selection.effectiveMonth !== null && !MONTH.test(selection.effectiveMonth) ||
      (selection.revision === 0) !== (selection.effectiveMonth === null)) fail('DASHBOARD_SETTINGS_INVALID');
  const value = settings(selection.settings), chosen = { ...selection, settings: value };
  return { ...config, incomeReserveCents: value.incomeReserveCents,
    allocations: config.allocations.map(row => row.id === 'general-spending' ? { ...row,
      monthlyBudgetCents: value.generalMonthlyBudgetCents, reserveMonths: value.generalReserveMonths,
      targetCents: Number(BigInt(value.generalMonthlyBudgetCents) * BigInt(value.generalReserveMonths)) } : { ...row }),
    monthly: { ...config.monthly, emergencyTargetCents: value.emergencyTargetCents,
      emergencyRateBasisPoints: value.emergencyRateBasisPoints, projectRateBasisPoints: value.projectRateBasisPoints,
      executionDay: value.executionDay, decemberDay: value.decemberDay },
    dashboardControls: structuredClone(chosen) };
}

export function resolveDashboardConfig(config, state, { now = Date.now(), monthKey = monthlyClock(now).monthKey } = {}) {
  return applyDashboardSelection(config, selected(config, state, monthKey));
}

export function dashboardControlView({ config, state, now = Date.now() }) {
  const monthKey = monthlyClock(now).monthKey, controls = validateDashboardControls(state?.dashboardControls);
  const current = selected(config, state, monthKey);
  const versions = controls?.versions ?? [];
  const pending = versions.filter(row => row.effectiveMonth > monthKey &&
    !versions.some(later => later.revision > row.revision && later.effectiveMonth <= row.effectiveMonth))
    .map(row => ({ revision: row.revision, effectiveMonth: row.effectiveMonth, settings: row.after, updatedAt: row.at }));
  return structuredClone({ schemaVersion: 1, revision: controls?.revision ?? 0, current, pending,
    editableFields: [...DASHBOARD_CONTROL_FIELDS],
    history: versions.map(({ revision, effectiveMonth, at, actor, before, after }) => ({ revision, effectiveMonth, at, actor, before, after })) });
}

/** Call with the exact state/ETag snapshot read by the handler, then CAS once.
 * A conflict requires reloading; this helper never merges an unseen revision. */
export function prepareDashboardControlUpdate({ config, state, expectedRevision, changes, now = Date.now(), actor = 'owner' }) {
  const current = monthlyClock(now), controls = validateDashboardControls(state?.dashboardControls);
  if (!record(state) || !Number.isSafeInteger(expectedRevision) || expectedRevision !== (controls?.revision ?? 0)) fail('DASHBOARD_SETTINGS_CONFLICT');
  if (state.lease && (!Number.isFinite(Date.parse(state.lease.expiresAt)) || Date.parse(state.lease.expiresAt) > now)) fail('DASHBOARD_WORKER_ACTIVE');
  if (controls?.versions.length >= 1000) fail('DASHBOARD_SETTINGS_HISTORY_FULL');
  const patch = parseDashboardChanges(changes);
  const active = Boolean(state.monthly?.activationAt && state.monthly?.bindingHash || config.mode === 'live' && config.liveEnabled);
  let effectiveMonth = active ? nextMonthKey(current.monthKey) : current.monthKey;
  // Partial edits extend the latest pending revision. Bringing a new partial
  // patch ahead of an existing future version could silently erase that future
  // budget when the newer revision subsequently wins.
  if (controls?.versions.at(-1)?.effectiveMonth > effectiveMonth) effectiveMonth = controls.versions.at(-1).effectiveMonth;
  let before, after;
  for (let count = 0; count < 120; count += 1) {
    before = selected(config, state, effectiveMonth).settings;
    after = settings({ ...before, ...patch });
    const slot = monthlySlot(effectiveMonth, after), cutoff = Math.max(now, Date.parse(config.activationAt ?? '') || now);
    if (!state.monthly?.cycles?.[effectiveMonth] && (active || Date.parse(slot.dueAt) >= cutoff)) break;
    effectiveMonth = nextMonthKey(effectiveMonth);
    if (count === 119) fail('DASHBOARD_SETTINGS_SCHEDULE_UNAVAILABLE');
  }
  const nextControls = controls ?? { schemaVersion: 1, revision: 0,
    baseline: { capturedAt: iso(now), settings: defaults(config) }, versions: [] };
  const body = { revision: nextControls.revision + 1, effectiveMonth, at: iso(now), actor, before, after,
    previousHash: nextControls.versions.at(-1)?.hash ?? hash(nextControls.baseline) };
  nextControls.versions.push({ ...body, hash: hash(body) }); nextControls.revision = body.revision;
  validateDashboardControls(nextControls);
  const next = { ...structuredClone(state), dashboardControls: nextControls };
  return { state: next, settings: dashboardControlView({ config, state: next, now }) };
}

/** Match the executor's cutoff once active; inactive preparation is prospective.
 * An already-frozen month's own slot wins over subsequent settings versions. */
export function nextMonthlySlot({ config, state = {}, now = Date.now() }) {
  const monthly = state.monthly, bound = monthly?.activationAt;
  const liveCutoff = config.mode === 'live' && config.liveEnabled === true ? config.activationAt : null;
  const effectiveCutoff = bound ?? liveCutoff;
  const cutoff = effectiveCutoff ? Date.parse(effectiveCutoff) : Math.max(now, Date.parse(config.activationAt ?? '') || now);
  if (!Number.isFinite(cutoff)) fail('MONTHLY_ACTIVATION_INVALID');
  let key = monthlyClock(now).monthKey;
  const eligibilityFloor = monthly?.firstEligibleMonth ?? (bound ? firstEligibleMonth(bound) : null);
  if (eligibilityFloor && key < eligibilityFloor) key = eligibilityFloor;
  for (let count = 0; count < 120; count += 1) {
    const cycle = monthly?.cycles?.[key], resolved = resolveDashboardConfig(config, state, { now, monthKey: key });
    const slot = cycle ? cycle.slot ?? monthlySlot(key) : monthlySlot(key, resolved.monthly);
    const canResume = effectiveCutoff && cycle?.status !== 'COMPLETE' && now >= Date.parse(slot.dueAt) && now < Date.parse(slot.closesAt);
    if (Date.parse(slot.dueAt) >= cutoff && (Date.parse(slot.dueAt) >= now || canResume) && cycle?.status !== 'COMPLETE') {
      return { ...slot, settingsRevision: cycle?.settingsSnapshot?.revision ?? resolved.dashboardControls.revision,
        settingsEffectiveMonth: cycle?.settingsSnapshot?.effectiveMonth ?? resolved.dashboardControls.effectiveMonth,
        prospectiveCutoff: effectiveCutoff ?? iso(cutoff) };
    }
    key = nextMonthKey(key);
  }
  fail('MONTHLY_SCHEDULE_UNAVAILABLE');
}
