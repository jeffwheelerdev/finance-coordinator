/** Pure dashboard read models. These functions never read a provider, write the
 * financial ledger, send email, or authorize a transfer. Every public field is
 * selected explicitly; raw provider records and private evidence stay server-side. */
import { createHash } from 'node:crypto';
import { VERSION } from './config.mjs';
import { MONTHLY_ALLOCATION_IDS, monthlyPercentageTargets, planMonthlyFunding } from './monthly-plan.mjs';
import { dashboardControlView, nextMonthlySlot } from './dashboard-controls.mjs';
import { monthlyClock, monthlySlot } from './monthly-schedule.mjs';

export class DashboardViewError extends Error {
  constructor(code) { super(code); this.name = 'DashboardViewError'; this.code = code; }
}
const fail = code => { throw new DashboardViewError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const codes = values => [...new Set((Array.isArray(values) ? values : []).map(code).filter(Boolean))].slice(0, 80);
const month = value => typeof value === 'string' && /^(?:[2-9]\d{3})-(?:0[1-9]|1[0-2])$/.test(value) ? value : null;
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sum = values => { const result = values.reduce((total, value) => total + BigInt(amount(value) ?? 0), 0n);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null; };
const clock = now => { const result = typeof now === 'function' ? now() : now;
  if (!Number.isFinite(result) || !Number.isFinite(new Date(result).getTime())) fail('DASHBOARD_TIME_INVALID'); return result; };
const enumValue = (value, values, fallback = null) => values.includes(value) ? value : fallback;
const MAX_CYCLES = 1200;
const MAX_DEBUG_BYTES = 256 * 1024;
const MAX_RUN_HISTORY = 100;
const RUN_STATUSES = ['busy', 'blocked', 'review', 'waiting', 'observe', 'uncertain', 'pending', 'complete'];
const STATES = ['PLANNED', 'SUBMITTING', 'PENDING', 'COMPLETE', 'NOOP', 'SKIPPED', 'REVIEW'];
const PROVIDER_STATES = ['APPROVAL_PENDING', 'PROCESSING', 'PENDING', 'COMPLETE', 'INCOMPLETE', 'ERROR', 'CANCELLED', 'APPROVAL_DENIED'];
const FIELDS = ['generalMonthlyBudgetCents', 'generalReserveMonths', 'incomeReserveCents', 'emergencyTargetCents',
  'emergencyRateBasisPoints', 'projectRateBasisPoints', 'executionDay', 'decemberDay'];
const ROLES = Object.freeze([
  ['income', 'Income', 'cash'], ['bills', 'Bills & subscriptions', 'cash'], ['general', 'General spending', 'cash'],
  ['emergency', 'Emergency fund', 'cash'], ['roth', 'Roth IRA', 'investment'],
  ['project', 'Project savings', 'cash'], ['personalInvestment', 'Personal investment', 'investment'],
]);
const ROUTES = Object.freeze({
  bills: ['income', 'bills', 1], 'general-spending': ['income', 'general', 2],
  'emergency-fund': ['income', 'emergency', 3], 'roth-ira': ['income', 'roth', 4],
  'project-savings': ['income', 'project', 5], 'personal-investment': ['income', 'personalInvestment', 6],
  'emergency-excess': ['emergency', 'income', 7],
});
const allocationId = value => Object.hasOwn(ROUTES, value) ? value : null;
function safeSettings(value) { return Object.fromEntries(FIELDS.map(field => [field, integer(value?.[field])])); }
function safeSettingsView(value) {
  const entry = row => ({ revision: integer(row?.revision), effectiveMonth: month(row?.effectiveMonth), settings: safeSettings(row?.settings),
    ...(row?.updatedAt ? { updatedAt: stamp(row.updatedAt) } : {}) });
  return { schemaVersion: 1, revision: integer(value?.revision), current: entry(value?.current),
    pending: (Array.isArray(value?.pending) ? value.pending : []).slice(0, 24).map(entry),
    editableFields: FIELDS.filter(field => value?.editableFields?.includes(field)),
    history: (Array.isArray(value?.history) ? value.history : []).slice(-24).reverse().map(row => ({
      revision: integer(row?.revision), effectiveMonth: month(row?.effectiveMonth), at: stamp(row?.at),
      before: safeSettings(row?.before), after: safeSettings(row?.after),
    })) };
}
function safeSlot(value) {
  return { monthKey: month(value?.monthKey), year: integer(value?.year, 9999), dayOfMonth: integer(value?.dayOfMonth, 31),
    dueAt: stamp(value?.dueAt), closesAt: stamp(value?.closesAt), timeZone: 'America/New_York', checkHourUTC: 15,
    settingsRevision: integer(value?.settingsRevision), settingsEffectiveMonth: month(value?.settingsEffectiveMonth) };
}
function safeReadiness(value) {
  if (!record(value)) return { status: 'not_checked', checkedAt: null, readyForActivation: false, executionEnabled: false,
    checks: [], blockers: [], recheckAtActivation: true };
  return { status: enumValue(value.status, ['active', 'ready_for_user_activation', 'blocked'], 'not_checked'),
    checkedAt: stamp(value.checkedAt), readyForActivation: value.readyForActivation === true,
    executionEnabled: value.executionEnabled === true, activationEstablished: value.activationEstablished === true,
    readChecks: enumValue(value.readChecks, ['passed', 'blocked']),
    nextCycle: value.nextCycle ? safeSlot(value.nextCycle) : null,
    checks: (Array.isArray(value.checks) ? value.checks : []).slice(0, 30).map(row => ({
      id: typeof row?.id === 'string' && /^[a-z][a-z_]{0,63}$/.test(row.id) ? row.id : 'unknown_check',
      status: enumValue(row?.status, ['passed', 'blocked'], 'blocked'), codes: codes(row?.codes),
    })), blockers: codes(value.blockers),
    activationChanges: (Array.isArray(value.activationChanges) ? value.activationChanges : []).slice(0, 3).map(row => ({
      setting: enumValue(row?.setting, ['APP_MODE', 'LIVE_TRANSFERS_ENABLED', 'AUTOMATION_START_AT']),
      requiredValue: enumValue(row?.requiredValue, ['live', 'true']),
    })).filter(row => row.setting), recheckAtActivation: true };
}
function safeLastRun(value) {
  if (!record(value)) return null;
  return { at: stamp(value.at), mode: enumValue(value.mode, ['observe', 'live']),
    status: enumValue(value.result?.status, ['busy', 'blocked', 'review', 'waiting', 'observe', 'uncertain', 'pending', 'complete']),
    code: code(value.result?.code), submitted: integer(value.result?.submitted, 7) };
}
function runHistoryView(state, limit = MAX_RUN_HISTORY, unavailableCode = null) {
  const raw = state?.monthly?.runHistory;
  const unavailable = errorCode => ({ status: 'unavailable', items: [], storedCount: null, limit,
    coverage: 'bounded_coordinator_runs', retentionReached: false, hasMore: false, code: errorCode });
  if (unavailableCode) return unavailable(code(unavailableCode) ?? 'DASHBOARD_RUN_HISTORY_UNAVAILABLE');
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > MAX_RUN_HISTORY)) return unavailable('DASHBOARD_RUN_HISTORY_INVALID');
  const rows = (raw ?? []).map(row => ({ at: stamp(row?.at), mode: enumValue(row?.mode, ['observe', 'live']),
    status: enumValue(row?.status, RUN_STATUSES), code: code(row?.code), monthKey: month(row?.monthKey),
    submittedCount: integer(row?.submittedCount, MAX_CYCLES * 7), settledCount: integer(row?.settledCount, MAX_CYCLES * 7) }));
  if (rows.some(row => Object.values(row).some(value => value === null))) return unavailable('DASHBOARD_RUN_HISTORY_INVALID');
  rows.reverse();
  return { status: 'available', items: rows.slice(0, limit), storedCount: rows.length, limit,
    coverage: 'bounded_coordinator_runs', retentionReached: rows.length === MAX_RUN_HISTORY,
    hasMore: rows.length > limit, code: null };
}
function cycleEntries(state) {
  const entries = Object.entries(record(state?.monthly?.cycles) ? state.monthly.cycles : {});
  if (entries.length > MAX_CYCLES) fail('DASHBOARD_LEDGER_LIMIT');
  return entries.filter(([key, value]) => month(key) && record(value)).sort(([a], [b]) => b.localeCompare(a));
}
function execution(child) {
  if (!child) return 'not_planned';
  switch (child.status) {
    case 'PLANNED': return 'planned';
    case 'SUBMITTING': return 'submission_unknown';
    case 'PENDING': return child.providerStatus === 'APPROVAL_PENDING' ? 'approval_required' : 'pending';
    case 'COMPLETE': return 'complete';
    case 'NOOP': return 'not_needed';
    case 'SKIPPED': return 'skipped';
    case 'REVIEW': return ['ERROR', 'INCOMPLETE', 'CANCELLED', 'APPROVAL_DENIED'].includes(child.providerStatus) ||
      child.reason === 'MONTHLY_PROVIDER_REJECTED' ? 'failed' : 'review_required';
    default: return 'review_required';
  }
}
function flowLine(id, child, line, monthKey) {
  const [sourceRole, destinationRole, priority] = ROUTES[id];
  const planned = amount(line?.amountInCents ?? child?.amountInCents);
  const accepted = child?.transferId && ['PENDING', 'COMPLETE'].includes(child.status);
  return { key: `${monthKey ?? 'unplanned'}:${id}`, allocationId: id, sourceRole, destinationRole, priority,
    plannedCents: planned, targetCents: amount(line?.targetCents), monthlyTargetCents: amount(line?.monthlyTargetCents),
    regularCents: amount(line?.regularCents ?? child?.regularCents), windfallCents: amount(line?.windfallCents ?? child?.windfallCents),
    planReason: code(line?.reason), executionStatus: execution(child),
    ledgerStatus: enumValue(child?.status, STATES), providerStatus: enumValue(child?.providerStatus, PROVIDER_STATES),
    committedCents: child?.request ? amount(child.amountInCents) : 0,
    submittedCents: accepted ? amount(child.amountInCents) : 0,
    settledCents: child?.request && child.status === 'COMPLETE' ? amount(child.amountInCents) : 0,
    firstAttemptAt: stamp(child?.firstAttemptAt), lastAttemptAt: stamp(child?.lastAttemptAt),
    updatedAt: stamp(child?.updatedAt), completedAt: stamp(child?.completedAt), nextAttemptAt: stamp(child?.nextAttemptAt),
    attempts: integer(child?.attempts, 100000), code: ['REVIEW', 'SKIPPED', 'NOOP'].includes(child?.status)
      ? code(child?.reason) ?? code(child?.lastError) : code(child?.lastError),
    belowProviderMinimum: planned !== null && planned > 0 && planned < 100 };
}
function cycleView(key, cycle) {
  const plan = cycle?.plan;
  const lines = Array.isArray(plan?.allocations) ? plan.allocations : [];
  const flows = MONTHLY_ALLOCATION_IDS.map(id => flowLine(id, cycle?.children?.[id], lines.find(line => line.allocationId === id), key));
  if (cycle?.children?.['emergency-excess'] || amount(plan?.emergencyExcessCents) > 0) flows.push(flowLine('emergency-excess',
    cycle?.children?.['emergency-excess'], { amountInCents: plan?.emergencyExcessCents, regularCents: 0, windfallCents: 0 }, key));
  return { monthKey: key, kind: cycle ? 'frozen' : 'not_created',
    status: enumValue(cycle?.status, ['OPEN', 'COMPLETE', 'REVIEW']), createdAt: stamp(cycle?.createdAt),
    settingsRevision: integer(cycle?.settingsSnapshot?.revision ?? cycle?.settingsRevision ?? plan?.settingsRevision),
    settingsEffectiveMonth: month(cycle?.settingsSnapshot?.effectiveMonth),
    dueAt: stamp(cycle?.slot?.dueAt ?? cycle?.dueAt ?? plan?.dueAt), closesAt: stamp(cycle?.slot?.closesAt ?? cycle?.closesAt ?? plan?.closesAt),
    openingRegularCents: amount(plan?.openingRegularCents), totalPlannedCents: amount(plan?.totalPlannedCents),
    heldRegularCents: amount(plan?.heldRegularCents), heldWindfallCents: amount(plan?.heldWindfallCents),
    unknownHeldCents: amount(plan?.unknownHeldCents), blockers: codes(plan?.blockers),
    settledCents: sum(flows.filter(row => row.sourceRole === 'income').map(row => row.settledCents)),
    submittedCents: sum(flows.filter(row => row.sourceRole === 'income').map(row => row.submittedCents)),
    emergencyReturnSettledCents: flows.find(row => row.allocationId === 'emergency-excess')?.settledCents ?? 0,
    skippedCount: flows.filter(row => row.ledgerStatus === 'SKIPPED').length,
    noTransferCount: flows.filter(row => row.ledgerStatus === 'NOOP').length, flows };
}
function activityRows(state) {
  const rows = [];
  for (const [key, cycle] of cycleEntries(state)) {
    const view = cycleView(key, cycle);
    rows.push({ key: `cycle:${key}`, kind: 'cycle', monthKey: key, at: view.createdAt,
      status: view.status, plannedCents: view.totalPlannedCents, settledCents: view.settledCents,
      skippedCount: view.skippedCount, noTransferCount: view.noTransferCount });
    for (const flow of view.flows) if (cycle.children?.[flow.allocationId]) rows.push({ ...flow,
      kind: 'allocation', monthKey: key, at: flow.completedAt ?? flow.updatedAt ?? flow.lastAttemptAt ?? view.createdAt });
  }
  return rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || b.key.localeCompare(a.key));
}

/** Current recorded cycle/request milestones, not a complete history of cron
 * invocations. A cursor is bound to a redacted snapshot and fails on a change. */
export function dashboardActivity({ state, cursor = null, limit = 25 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DASHBOARD_ACTIVITY_LIMIT_INVALID');
  const rows = activityRows(state);
  const revision = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 24);
  let offset = 0;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 160 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('DASHBOARD_ACTIVITY_CURSOR_INVALID');
    let value;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail('DASHBOARD_ACTIVITY_CURSOR_INVALID'); }
    if (!Array.isArray(value) || value.length !== 2 || !/^[a-f0-9]{24}$/.test(value[0]) || !Number.isSafeInteger(value[1]) || value[1] < 0) fail('DASHBOARD_ACTIVITY_CURSOR_INVALID');
    if (value[0] !== revision) fail('DASHBOARD_ACTIVITY_CHANGED');
    if (value[1] > rows.length) fail('DASHBOARD_ACTIVITY_CURSOR_INVALID');
    offset = value[1];
  }
  const items = rows.slice(offset, offset + limit), hasMore = offset + items.length < rows.length;
  return { kind: 'recorded_milestones', completeRunLog: false, snapshotRevision: revision,
    items, totalCount: rows.length, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify([revision, offset + items.length])).toString('base64url') : null };
}
function alertView(state, limit = 25) {
  const all = Object.values(record(state?.monthly?.alerts) ? state.monthly.alerts : {});
  if (all.length > 20000) fail('DASHBOARD_ALERT_LIMIT');
  const rows = all.filter(record).sort((a, b) => (stamp(b.createdAt) ?? '').localeCompare(stamp(a.createdAt) ?? ''));
  return { totalCount: rows.length, hasMore: rows.length > limit,
    items: rows.slice(0, limit).map((row, index) => ({ key: `${month(row.monthKey) ?? 'unknown'}:${code(row.code) ?? 'UNKNOWN'}:${index}`,
      monthKey: month(row.monthKey), code: code(row.code), allocationId: allocationId(row.allocationId) ?? (row.allocationId === 'income' ? 'income' : null),
      severity: enumValue(row.severity, ['critical', 'warning'], 'warning'),
      deliveryStatus: row.status === 'DELIVERED' ? 'provider_accepted' : row.status === 'REVIEW' ? 'review_required' : 'queued',
      inboxReceipt: 'not_verified', createdAt: stamp(row.createdAt), lastAttemptAt: stamp(row.lastAttemptAt),
      providerAcceptedAt: stamp(row.deliveredAt), attempts: integer(row.attempts, 100000),
      shortfallCents: amount(row.shortfallCents), amountInCents: amount(row.amountInCents), lastError: code(row.lastError) })) };
}
function annualView(state, id, year, rothSummary) {
  const entries = cycleEntries(state).filter(([key]) => Number(key.slice(0, 4)) === year);
  const children = entries.map(([, cycle]) => cycle.children?.[id]).filter(record);
  const field = id === 'roth-ira' ? 'rothTargetCents' : 'projectTargetCents';
  const obligations = Object.entries(record(state?.monthly?.obligations) ? state.monthly.obligations : {})
    .filter(([key]) => month(key) && Number(key.slice(0, 4)) === year).map(([, value]) => amount(value?.[field]));
  const committed = sum(children.filter(row => row.request).map(row => row.amountInCents));
  const target = obligations.length && obligations.every(value => value !== null) ? sum(obligations) : null;
  return { year, targetThroughRecordedMonthsCents: target, committedCents: committed,
    settledCents: sum(children.filter(row => row.request && row.status === 'COMPLETE').map(row => row.amountInCents)),
    pendingCents: sum(children.filter(row => row.request && row.status === 'PENDING').map(row => row.amountInCents)),
    reviewCents: sum(children.filter(row => row.request && ['REVIEW', 'SUBMITTING'].includes(row.status)).map(row => row.amountInCents)),
    outstandingCents: target !== null && committed !== null ? Math.max(0, target - committed) : null,
    ...(id === 'roth-ira' ? { monthlyAmountCents: amount(rothSummary?.monthlyAmountCents),
      annualLimitCents: amount(rothSummary?.annualLimitCents), previewAnnualLimitCents: amount(rothSummary?.previewAnnualLimitCents),
      remainingAnnualCents: amount(rothSummary?.remainingAnnualCents), blockers: codes(rothSummary?.blockers),
      taxYearReviewRequired: Object.keys(state?.monthly?.taxYearReview ?? {}).length > 0 } : {}) };
}
function testsView(value) {
  const offline = value?.offline, provider = value?.provider, scheduler = value?.scheduler;
  const status = row => enumValue(row?.status, ['passed', 'failed'], 'not_run');
  const offlineIds = ['full_year_carry_and_december_close', 'priority_shortage_and_partial_roth',
    'provider_uncertain_and_failed_outcomes', 'first_day_schedule_and_prospective_activation', 'year_transition_and_new_annual_limit'];
  const probeIds = ['income_to_bills', 'income_to_general', 'income_to_emergency', 'income_to_roth', 'income_to_project', 'income_to_personal', 'emergency_to_income'];
  return { offline: { status: status(offline), softwareVersion: typeof offline?.softwareVersion === 'string' && /^\d+\.\d+\.\d+$/.test(offline.softwareVersion) ? offline.softwareVersion : null,
    syntheticDataOnly: offline?.syntheticDataOnly === true, scenarioCount: integer(offline?.scenarioCount, 100),
    checkedAt: stamp(offline?.checkedAt), resultHash: typeof offline?.resultHash === 'string' && /^[a-f0-9]{64}$/.test(offline.resultHash) ? offline.resultHash : null,
    networkAttempts: integer(offline?.networkAttempts, 100000), realTransfers: integer(offline?.realTransfers, 100000), realEmails: integer(offline?.realEmails, 100000),
    scenarios: (Array.isArray(offline?.scenarios) ? offline.scenarios : []).filter(row => offlineIds.includes(row?.id)).slice(0, 10)
      .map(row => ({ id: row.id, status: status(row) })) },
    provider: { status: status(provider), checkedAt: stamp(provider?.checkedAt), syntheticProbes: provider?.syntheticProbes === true,
      requestCount: integer(provider?.requestCount, 7), realTransferRequested: provider?.realTransferRequested === false ? false : null,
      unattendedApprovalProven: false, settlementProven: false,
      results: (Array.isArray(provider?.results) ? provider.results : []).filter(row => probeIds.includes(row?.label)).slice(0, 7)
        .map(row => ({ label: row.label, amountInCents: amount(row.amountInCents), status: status(row),
          executionMode: row.executionMode === 'SIMULATION' ? 'SIMULATION' : null, code: code(row.code) })) },
    scheduler: { status: enumValue(scheduler?.status, ['not_run', 'pending', 'queued', 'unknown', 'completed', 'expired', 'unverified'], 'not_run'),
      queuedAt: stamp(scheduler?.queuedAt), expiresAt: stamp(scheduler?.expiresAt), completedAt: stamp(scheduler?.completedAt), checkedAt: stamp(scheduler?.checkedAt),
      softwareVersion: typeof scheduler?.softwareVersion === 'string' && /^\d+\.\d+\.\d+$/.test(scheduler.softwareVersion) ? scheduler.softwareVersion : null,
      code: code(scheduler?.code), transport: scheduler?.transport === 'vercel-queue' ? 'vercel-queue' : null,
      authentication: scheduler?.authentication === 'vercel-oidc' ? 'vercel-oidc' : null,
      target: scheduler?.target === 'health_only' ? 'health_only' : null,
      realTransfers: scheduler?.realTransfers === 0 ? 0 : null, realEmails: scheduler?.realEmails === 0 ? 0 : null } };
}
function billsView(value, config) {
  const forecast = value?.forecast;
  return { status: forecast ? 'available' : 'unavailable', targetCents: amount(forecast?.targetCents ?? config?.calculatedBillsTarget?.targetCents),
    peakMonthCents: amount(forecast?.peakMonthCents), peakMonth: month(forecast?.peakMonth), year: integer(forecast?.year, 9999),
    annualTotalCents: amount(forecast?.annualTotalCents), includedBillCount: integer(forecast?.includedBillCount, 10000),
    catalogUpdatedAt: stamp(forecast?.catalogUpdatedAt), monitorCheckedAt: stamp(value?.monitor?.checkedAt),
    reviewCodes: codes(value?.monitor?.reviewCodes), warningCodes: codes(forecast?.warnings?.map(row => row.code)),
    roundingCents: 50000,
    months: (Array.isArray(forecast?.months) ? forecast.months : []).slice(0, 12).map(row => ({ month: month(row?.month), totalCents: amount(row?.totalCents) })) };
}

/** A partial snapshot is useful: saved plans remain readable when policies,
 * income reconciliation, or providers are unavailable. Missing cash is null. */
export function buildDashboardView({ config, state = {}, settings, readiness, evidence, incomePools, billsPolicy,
  rothSummary, sectionErrors = {}, tests, now = Date.now() } = {}) {
  const at = clock(now), current = monthlyClock(at, config?.monthly);
  const safeErrors = Object.fromEntries(['settings', 'readiness', 'accounts', 'income', 'bills', 'roth', 'tests', 'ledger']
    .map(key => [key, code(sectionErrors?.[key])]));
  if (!settings) { try { settings = dashboardControlView({ config, state, now: at }); }
    catch (error) { safeErrors.settings = code(error.code) ?? 'DASHBOARD_SETTINGS_UNAVAILABLE'; } }
  let slot;
  try { slot = nextMonthlySlot({ config, state, now: at }); }
  catch (error) { safeErrors.settings ??= code(error.code) ?? 'DASHBOARD_SCHEDULE_UNAVAILABLE'; }
  const currentCycle = state?.monthly?.cycles?.[current.monthKey];
  const cycle = cycleView(current.monthKey, currentCycle);
  const targets = { bills: amount(config?.calculatedBillsTarget?.targetCents ?? config?.allocations?.find(row => row.id === 'bills')?.targetCents),
    general: amount(config?.allocations?.find(row => row.id === 'general-spending')?.targetCents), emergency: amount(config?.monthly?.emergencyTargetCents) };
  const configuredRoles = { income: config?.accounts?.income, bills: config?.accounts?.bills, general: config?.accounts?.general,
    emergency: config?.accounts?.emergency, roth: config?.roth?.accountId,
    project: config?.monthly?.projectAccountId, personalInvestment: config?.monthly?.personalAccountId };
  const accounts = ROLES.map(([role, label, kind]) => {
    const snapshot = evidence?.accountSnapshots?.[role], balanceAsOf = stamp(snapshot?.observedAt);
    const validBalance = kind === 'cash' && amount(snapshot?.balanceCents) !== null && balanceAsOf && Date.parse(balanceAsOf) <= at;
    const stale = validBalance && at - Date.parse(balanceAsOf) > (config?.maxBalanceAgeMs ?? 0);
    return { role, label, kind, configured: typeof configuredRoles[role] === 'string' && Boolean(configuredRoles[role]),
      balanceStatus: validBalance ? stale ? 'stale' : 'available' : 'unavailable',
      balanceCents: validBalance ? snapshot.balanceCents : null,
      availableBalanceCents: validBalance ? amount(snapshot.availableBalanceCents) : null,
      spendableCents: validBalance ? amount(snapshot.spendableCents) : null,
      pendingIncomingCents: validBalance ? amount(snapshot.pendingIncomingCents) : null,
      pendingOutgoingCents: validBalance ? amount(snapshot.pendingOutgoingCents) : null,
      balanceAsOf: validBalance ? balanceAsOf : null, targetCents: targets[role] ?? null,
      targetCommittedBalanceCents: validBalance && role === 'emergency' && amount(snapshot.pendingIncomingCents) !== null ? sum([snapshot.balanceCents, snapshot.pendingIncomingCents])
        : validBalance && ['bills', 'general'].includes(role) ? amount(snapshot.fundingBalanceCents) : null };
  });
  const poolValid = !safeErrors.income && record(incomePools) &&
    ['availableRegularCents', 'windfallHeldCents', 'priorYearWindfallHeldCents', 'unknownHeldCents'].every(key => amount(incomePools[key]) !== null);
  const income = { status: poolValid ? 'reconciled' : 'unavailable', code: safeErrors.income,
    asOf: poolValid ? stamp(incomePools.ledger?.reconciledAt ?? evidence?.observedAt) : null,
    availableRegularCents: poolValid ? incomePools.availableRegularCents : null,
    windfallHeldCents: poolValid ? incomePools.windfallHeldCents : null,
    priorYearWindfallHeldCents: poolValid ? incomePools.priorYearWindfallHeldCents : null,
    unknownHeldCents: poolValid ? incomePools.unknownHeldCents : null,
    incomeReserveCents: amount(config?.incomeReserveCents),
    sourceSpendableCents: amount(evidence?.sourceSpendableCents),
    pendingSequenceDebitCents: amount(evidence?.pendingSourceDebitCents), pendingSequenceCreditCents: amount(evidence?.pendingIncomeCreditCents),
    pendingBankDebitCents: amount(evidence?.pendingExternalIncomeDebitCents), pendingBankCreditCents: amount(evidence?.pendingExternalIncomeCreditCents),
    pendingReservationsMayOverlap: true, windfallUseMonth: 12, virtualPools: true };
  const all = cycleEntries(state).flatMap(([, entry]) => Object.values(entry.children ?? {}));
  const sections = Object.fromEntries(Object.entries(safeErrors).map(([key, value]) => [key, { status: value ? 'unavailable' : 'available', code: value }]));
  if (!evidence && !safeErrors.accounts) sections.accounts = { status: 'not_checked', code: null };
  if (!poolValid && !safeErrors.income) sections.income = { status: 'not_checked', code: null };
  if (!readiness && !safeErrors.readiness) sections.readiness = { status: 'not_checked', code: null };
  if (!billsPolicy && !safeErrors.bills) sections.bills = { status: 'not_checked', code: null };
  if (!rothSummary && !safeErrors.roth) sections.roth = { status: 'not_checked', code: null };
  if (!tests && !safeErrors.tests) sections.tests = { status: 'not_checked', code: null };
  const ledgerAvailable = !safeErrors.ledger;
  const activity = ledgerAvailable ? dashboardActivity({ state, limit: 12 }) : {
    kind: 'recorded_milestones', completeRunLog: false, snapshotRevision: null,
    items: [], totalCount: null, hasMore: false, nextCursor: null, code: safeErrors.ledger };
  const annual = { roth: annualView(state, 'roth-ira', current.year, rothSummary), project: annualView(state, 'project-savings', current.year) };
  if (!ledgerAvailable) {
    cycle.kind = 'unavailable';
    for (const key of ['settledCents', 'submittedCents', 'emergencyReturnSettledCents', 'skippedCount', 'noTransferCount']) cycle[key] = null;
    for (const row of cycle.flows) for (const key of ['committedCents', 'submittedCents', 'settledCents']) row[key] = null;
    for (const row of Object.values(annual)) for (const key of ['committedCents', 'settledCents', 'pendingCents', 'reviewCents', 'outstandingCents']) row[key] = null;
  }
  return { schemaVersion: 1, asOf: new Date(at).toISOString(), currency: 'USD',
    system: { softwareVersion: VERSION, mode: enumValue(config?.mode, ['observe', 'live'], 'observe'),
      executionEnabled: config?.mode === 'live' && config?.liveEnabled === true,
      activationEstablished: Boolean(state?.monthly?.activationAt && state?.monthly?.bindingHash),
      activationAt: stamp(state?.monthly?.activationAt ?? config?.activationAt), lastRun: safeLastRun(state?.lastRun),
      pendingCount: ledgerAvailable ? all.filter(row => row?.status === 'PENDING').length : null,
      uncertainCount: ledgerAvailable ? all.filter(row => row?.status === 'SUBMITTING').length : null,
      reviewCount: ledgerAvailable ? all.filter(row => row?.status === 'REVIEW').length : null,
      dataStatus: Object.values(sections).some(row => row.status !== 'available') ? 'partial' : 'available' },
    schedule: { ...safeSlot(slot), currentMonthKey: current.monthKey,
      cadence: 'monthly', newMoneyOnlyInScheduledWindow: true, settlementMonitoringContinues: true },
    settings: safeSettingsView(settings), readiness: safeReadiness(readiness), accounts, income,
    cycle: Object.fromEntries(Object.entries(cycle).filter(([key]) => key !== 'flows')), flows: cycle.flows,
    annual, bills: billsView(billsPolicy, config), activity, runs: runHistoryView(state, MAX_RUN_HISTORY, safeErrors.ledger),
    alerts: ledgerAvailable ? alertView(state) : { totalCount: null, hasMore: false, items: [], code: safeErrors.ledger },
    tests: testsView(tests), sections };
}

/** An explicit synthetic cash scenario. No real balance, contribution room,
 * historical obligation, pending transfer or eligibility claim is fabricated. */
export function simulateDashboardPlan({ config, settings, billsTargetCents, rothMonthlyCents = null, input, now = Date.now() } = {}) {
  const at = clock(now);
  const required = ['monthKey', 'regularIncomeCents', 'windfallCents', 'billsBalanceCents', 'generalBalanceCents', 'emergencyBalanceCents'];
  const optional = ['rothRemainingCents', 'rothCarryCents', 'projectCarryCents'];
  if (!record(input) || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)) ||
      !month(input.monthKey) || [...required.filter(key => key !== 'monthKey'), ...optional.filter(key => Object.hasOwn(input, key))].some(key => amount(input[key]) === null)) fail('DASHBOARD_SIMULATION_INPUT_INVALID');
  if (amount(billsTargetCents) === null || rothMonthlyCents !== null && amount(rothMonthlyCents) === null) fail('DASHBOARD_SIMULATION_POLICY_UNAVAILABLE');
  const effective = settings ?? config?.dashboardControls?.settings;
  const generalMonthly = effective?.generalMonthlyBudgetCents ?? config?.allocations?.find(row => row.id === 'general-spending')?.monthlyBudgetCents;
  const generalMonths = effective?.generalReserveMonths ?? config?.allocations?.find(row => row.id === 'general-spending')?.reserveMonths;
  const generalTarget = amount(generalMonthly) !== null && integer(generalMonths, 120) !== null ?
    Number(BigInt(generalMonthly) * BigInt(generalMonths)) : config?.allocations?.find(row => row.id === 'general-spending')?.targetCents;
  const emergencyTarget = effective?.emergencyTargetCents ?? config?.monthly?.emergencyTargetCents;
  const incomeReserve = effective?.incomeReserveCents ?? config?.incomeReserveCents;
  const emergencyRateBasisPoints = effective?.emergencyRateBasisPoints ?? config?.monthly?.emergencyRateBasisPoints ?? 750;
  const projectRateBasisPoints = effective?.projectRateBasisPoints ?? config?.monthly?.projectRateBasisPoints ?? 500;
  if ([generalTarget, emergencyTarget, incomeReserve].some(value => amount(value) === null)) fail('DASHBOARD_SIMULATION_SETTINGS_INVALID');
  const rothCarry = input.rothCarryCents ?? 0, projectCarry = input.projectCarryCents ?? 0;
  const monthNumber = Number(input.monthKey.slice(5));
  if (monthNumber === 1 && (rothCarry || projectCarry)) fail('DASHBOARD_SIMULATION_PRIOR_YEAR_CARRY_FORBIDDEN');
  const hasCarry = rothCarry > 0 || projectCarry > 0;
  const priorKey = `${input.monthKey.slice(0, 4)}-${String(monthNumber - 1).padStart(2, '0')}`;
  const firstEligibleMonth = hasCarry ? priorKey : input.monthKey;
  const rates = { emergencyRateBasisPoints, projectRateBasisPoints };
  const percentages = monthlyPercentageTargets(input.regularIncomeCents, rates);
  const rothTarget = rothMonthlyCents === null ? null : sum([rothMonthlyCents, rothCarry]);
  if (rothMonthlyCents !== null && rothTarget === null) fail('DASHBOARD_SIMULATION_INPUT_INVALID');
  const remaining = Object.hasOwn(input, 'rothRemainingCents') ? input.rothRemainingCents : rothTarget;
  const obligation = (key, target) => ({ monthKey: key, targetCents: target, fundedCents: 0, reservedCents: 0 });
  const plan = planMonthlyFunding({ monthKey: input.monthKey, firstEligibleMonth, annualCloseMonth: 12,
    openingRegularCents: input.regularIncomeCents, availableRegularCents: input.regularIncomeCents,
    windfallHeldCents: input.windfallCents, incomeReserveCents: incomeReserve, ...rates,
    bills: { targetCents: billsTargetCents, balanceCents: input.billsBalanceCents },
    general: { targetCents: generalTarget, balanceCents: input.generalBalanceCents },
    emergency: { targetCents: emergencyTarget, balanceCents: input.emergencyBalanceCents },
    roth: { eligible: rothMonthlyCents !== null && remaining !== null, annualRemainingCents: remaining,
      months: [...(hasCarry ? [obligation(priorKey, rothCarry)] : []), obligation(input.monthKey, rothMonthlyCents)] },
    project: { months: [...(hasCarry ? [obligation(priorKey, projectCarry)] : []), obligation(input.monthKey, percentages.projectCents)] } });
  const schedule = { ...config?.monthly, ...(effective ? { executionDay: effective.executionDay, decemberDay: effective.decemberDay } : {}) };
  const slot = monthlySlot(input.monthKey, schedule);
  return { schemaVersion: 1, kind: 'synthetic_estimate', asOf: new Date(at).toISOString(), currency: 'USD',
    realTransfers: 0, realEmails: 0, financialLedgerModified: false, providerCalls: 0,
    assumptions: { inputBalancesAreSynthetic: true, pendingTransfersExcluded: true, settlementNotPredicted: true,
      rothEligibility: 'hypothetical_only', rothRoom: Object.hasOwn(input, 'rothRemainingCents') ? 'entered_scenario' : 'assumed_due_target_only',
      existingContributionsExcluded: true, earlierShortfalls: hasCarry ? 'entered_same_year_only' : 'assumed_none',
      unknownIncomeExcluded: true, windfallAssumedCurrentYear: true, billCatalog: 'current_known_schedule_only',
      futureBillChangesPredicted: false, futureRothLimitsPredicted: false },
    schedule: safeSlot(slot), inputs: { ...input, rothCarryCents: rothCarry, projectCarryCents: projectCarry },
    settings: safeSettings(effective), plan,
    flows: plan.allocations.map(line => ({ ...flowLine(line.allocationId, null, line, input.monthKey), executionStatus: 'estimate' })),
    emergencyExcessEstimateCents: Math.max(0, input.emergencyBalanceCents - emergencyTarget),
    emergencyReturnNotCountedAsIncome: true };
}

/** Bounded download model. Reprojection deliberately ignores csrf/session data,
 * raw errors, provider identifiers, payer descriptions and evidence references. */
export function dashboardDebug({ snapshot, state = {}, now = Date.now() } = {}) {
  const at = clock(now);
  const activity = dashboardActivity({ state, limit: 100 }), alerts = alertView(state, 50);
  const runs = runHistoryView(state, 50, snapshot?.sections?.ledger?.status === 'unavailable'
    ? snapshot.sections.ledger.code ?? 'DASHBOARD_LEDGER_UNAVAILABLE' : null);
  const result = { schemaVersion: 1, generatedAt: new Date(at).toISOString(), kind: 'redacted_finance_diagnostics',
    softwareVersion: VERSION, redaction: { credentialsOmitted: true, providerIdentifiersOmitted: true,
      privateEvidenceOmitted: true, personalDescriptionsOmitted: true, sessionDataOmitted: true },
    system: { mode: enumValue(snapshot?.system?.mode, ['observe', 'live']), executionEnabled: snapshot?.system?.executionEnabled === true,
      activationEstablished: snapshot?.system?.activationEstablished === true, lastRun: snapshot?.system?.lastRun ? {
        at: stamp(snapshot.system.lastRun.at), mode: enumValue(snapshot.system.lastRun.mode, ['observe', 'live']),
        status: enumValue(snapshot.system.lastRun.status, ['busy', 'blocked', 'review', 'waiting', 'observe', 'uncertain', 'pending', 'complete']),
        code: code(snapshot.system.lastRun.code) } : null },
    schedule: safeSlot(snapshot?.schedule), settings: safeSettingsView(snapshot?.settings), readiness: safeReadiness(snapshot?.readiness),
    sections: Object.fromEntries(['settings', 'readiness', 'accounts', 'income', 'bills', 'roth', 'tests', 'ledger'].map(key => [key, {
      status: enumValue(snapshot?.sections?.[key]?.status, ['available', 'unavailable', 'not_checked'], 'not_checked'), code: code(snapshot?.sections?.[key]?.code) }])),
    activity, runs, alerts, tests: testsView(snapshot?.tests),
    limits: { maximumBytes: MAX_DEBUG_BYTES, maximumActivityItems: 100, maximumAlertItems: 50, maximumRunItems: 50,
      activityTruncated: activity.hasMore, alertsTruncated: alerts.hasMore,
      runsTruncated: runs.hasMore, runRetentionReached: runs.retentionReached } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DEBUG_BYTES) fail('DASHBOARD_DEBUG_LIMIT');
  return result;
}
