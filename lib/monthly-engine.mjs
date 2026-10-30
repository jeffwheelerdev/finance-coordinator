import { createHash, randomUUID } from 'node:crypto';
import { initialState, validateState, safeCode, LEASE_MS } from './engine.mjs';
import { forecastRoth, parseRothPolicy } from './roth.mjs';
import { PENDING, validTime, calculatedBillsTarget } from './evidence.mjs';
import { planMonthlyFunding, monthlyPercentageTargets, MONTHLY_ALLOCATION_IDS } from './monthly-plan.mjs';
import { readMonthlyEvidence, checkMonthlyRothEvidence, verifyMonthlyNativeRules } from './monthly-evidence.mjs';
import { reconcileIncome, incomeScanFrom } from './income-ledger.mjs';
import { validateMonthlySequenceRetirement } from './config.mjs';

const RUN_MS = 240000, RECOVERY_MS = 23 * 3600000, MAX_CYCLES = 1200;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const REQUEST_STATES = new Set(['SUBMITTING', 'PENDING', 'COMPLETE', 'REVIEW']);
const FINAL = new Set(['COMPLETE', 'NOOP', 'SKIPPED']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const cents = value => Number.isSafeInteger(value) && value >= 0;
const add = values => {
  const total = values.reduce((sum, value) => {
    if (!cents(value)) throw new MonthlyEngineError('MONTHLY_AMOUNT_INVALID');
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new MonthlyEngineError('MONTHLY_AMOUNT_OVERFLOW');
  return Number(total);
};
export class MonthlyEngineError extends Error {
  constructor(code) { super(code); this.name = 'MonthlyEngineError'; this.code = code; }
}
const fail = code => { throw new MonthlyEngineError(code); };

function clock(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => Number(parts.find(item => item.type === type).value);
  const year = part('year'), month = part('month'), day = part('day');
  return { year, month, day, monthKey: `${year}-${String(month).padStart(2, '0')}`, dueAt: iso(Date.UTC(year, month - 1, 1, 15)) };
}
function nextMonth(monthKey) {
  const year = Number(monthKey.slice(0, 4)), month = Number(monthKey.slice(5));
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
}
function firstMonth(activationAt) {
  const at = Date.parse(activationAt);
  if (!Number.isFinite(at)) fail('MONTHLY_ACTIVATION_REQUIRED');
  const current = clock(at);
  return at <= Date.parse(current.dueAt) ? current.monthKey : nextMonth(current.monthKey);
}
function writableWindow(monthKey, now) {
  const current = clock(now);
  return current.day === 1 && current.monthKey === monthKey && now >= Date.parse(current.dueAt);
}
function freshMonthlyState() {
  return { schemaVersion: 1, activationAt: null, bindingHash: null, cycles: {}, obligations: {},
    income: null, billsCatalog: null, rothPolicy: null, outsideContributionFloors: {}, taxYearReview: {}, alerts: {}, lastSettledAt: null, lastRun: null };
}
function allChildren(monthly) {
  return Object.values(monthly.cycles).flatMap(cycle => Object.values(cycle.children).map(child => ({ cycle, child })));
}
export function validateMonthlyState(state) {
  validateState(state);
  const monthly = state.monthly;
  if (!monthly) return state;
  if (monthly.schemaVersion !== 1 || ['cycles', 'obligations', 'outsideContributionFloors', 'taxYearReview', 'alerts'].some(key =>
    !monthly[key] || typeof monthly[key] !== 'object' || Array.isArray(monthly[key])) || Object.keys(monthly.cycles).length > MAX_CYCLES) fail('MONTHLY_LEDGER_INVALID');
  if (monthly.retirementBindingHash !== undefined && monthly.retirementBindingHash !== null &&
      !/^[a-f0-9]{64}$/.test(monthly.retirementBindingHash)) fail('MONTHLY_RETIREMENT_LEDGER_INVALID');
  let unknown = 0;
  for (const [monthKey, cycle] of Object.entries(monthly.cycles)) {
    if (!MONTH.test(monthKey) || cycle.monthKey !== monthKey || !['OPEN', 'COMPLETE', 'REVIEW'].includes(cycle.status) ||
        !cycle.children || Array.isArray(cycle.children) || cycle.planHash !== hash(cycle.plan)) fail('MONTHLY_CYCLE_INVALID');
    if (!Array.isArray(cycle.plan.allocations) || cycle.plan.allocations.length !== MONTHLY_ALLOCATION_IDS.length) fail('MONTHLY_CYCLE_INVALID');
    const allocations = new Map(cycle.plan.allocations.map(row => [row.allocationId, row]));
    const expected = [...MONTHLY_ALLOCATION_IDS, ...(cycle.plan.emergencyExcessCents >= 100 ? ['emergency-excess'] : [])];
    if (allocations.size !== MONTHLY_ALLOCATION_IDS.length || MONTHLY_ALLOCATION_IDS.some(id => !allocations.has(id)) ||
        Object.keys(cycle.children).length !== expected.length || expected.some(id => !Object.hasOwn(cycle.children, id))) fail('MONTHLY_CHILD_SET_INVALID');
    for (const [id, child] of Object.entries(cycle.children)) {
      const line = allocations.get(id);
      if (child.allocationId !== id || !['PLANNED', 'SUBMITTING', 'PENDING', 'COMPLETE', 'NOOP', 'SKIPPED', 'REVIEW'].includes(child.status) ||
          !cents(child.amountInCents) || !cents(child.regularCents) || !cents(child.windfallCents) ||
          (id !== 'emergency-excess' && (!line || child.amountInCents !== line.amountInCents ||
            child.regularCents !== line.regularCents || child.windfallCents !== line.windfallCents ||
            hash(child.obligations ?? []) !== hash(line.obligations ?? [])))) fail('MONTHLY_CHILD_INVALID');
      if (id === 'emergency-excess' && (child.regularCents !== 0 || child.windfallCents !== 0 ||
          child.amountInCents !== cycle.plan.emergencyExcessCents)) fail('MONTHLY_CHILD_INVALID');
      if (child.request) {
        if (!REQUEST_STATES.has(child.status) || child.requestHash !== hash(child.request) ||
            child.request.amountInCents !== child.amountInCents || child.amountInCents < 100 ||
            !Number.isFinite(Date.parse(child.firstAttemptAt)) || typeof child.idempotencyKey !== 'string') fail('MONTHLY_REQUEST_INVALID');
        if (!child.transferId && child.status === 'SUBMITTING') unknown += 1;
      } else if (REQUEST_STATES.has(child.status)) fail('MONTHLY_REQUEST_MISSING');
    }
    if (cycle.status === 'COMPLETE' && !Object.values(cycle.children).every(child => FINAL.has(child.status))) fail('MONTHLY_COMPLETION_INVALID');
  }
  if (unknown > 1) fail('MONTHLY_MULTIPLE_UNKNOWN_REQUESTS');
  for (const [monthKey, row] of Object.entries(monthly.obligations)) {
    if (!MONTH.test(monthKey) || ['rothTargetCents', 'projectTargetCents'].some(key => row[key] !== null && !cents(row[key]))) fail('MONTHLY_OBLIGATION_INVALID');
  }
  return state;
}

export function monthlyOwnedTransfers(state) {
  if (!state.monthly) return [];
  return allChildren(state.monthly).filter(({ child }) => child.request).map(({ cycle, child }) => ({
    id: `${cycle.monthKey}:${child.allocationId}`, monthKey: cycle.monthKey, transferId: child.transferId ?? null,
    sourceAccountId: child.request.sourceAccountId, destinationAccountId: child.request.destinationAccountId,
    amountInCents: child.request.amountInCents, regularCents: child.regularCents, windfallCents: child.windfallCents,
    status: child.status, firstAttemptAt: child.firstAttemptAt, completedAt: child.completedAt ?? null,
  }));
}
function knownTransfers(state) { return monthlyOwnedTransfers(state).filter(row => row.transferId); }
function annualReserved(monthly, year, exclude = null) {
  return add(allChildren(monthly).filter(({ cycle, child }) => child.allocationId === 'roth-ira' && child.request &&
    Number(cycle.monthKey.slice(0, 4)) === year && child !== exclude).map(({ child }) => child.amountInCents));
}
function binding(config) {
  return hash({ income: config.accounts.income, bills: config.accounts.bills, general: config.accounts.general,
    emergency: config.accounts.emergency, roth: config.roth.accountId, project: config.monthly.projectAccountId,
    personal: config.monthly.personalAccountId, rules: config.rules, zone: config.monthly.timeZone,
    due: config.monthly.dueHourUTC, close: config.monthly.annualCloseMonth });
}
function configuration(monthly, config, now, live) {
  if (!config.monthly?.enabled || config.monthly.timeZone !== 'America/New_York' || config.monthly.dueHourUTC !== 15 ||
      config.monthly.annualCloseMonth !== 12 || config.monthly.emergencyRateBasisPoints !== 750 || config.monthly.projectRateBasisPoints !== 500) fail('MONTHLY_CONFIGURATION_INVALID');
  const retirement = validateMonthlySequenceRetirement(config, now);
  const retirementBindingHash = retirement ? hash({ podAccountId: retirement.podAccountId, rules: retirement.rules }) : null;
  if (monthly.retirementBindingHash && monthly.retirementBindingHash !== retirementBindingHash) fail('MONTHLY_RETIREMENT_CHANGED');
  if (!config.activationAt) { if (live) fail('MONTHLY_ACTIVATION_REQUIRED'); return; }
  if (monthly.activationAt && monthly.activationAt !== config.activationAt) fail('MONTHLY_ACTIVATION_CHANGED');
  if (monthly.bindingHash && monthly.bindingHash !== binding(config)) fail('MONTHLY_BINDING_CHANGED');
  if (live) {
    if (Date.parse(config.activationAt) > now) fail('MONTHLY_ACTIVATION_NOT_STARTED');
    monthly.activationAt ??= config.activationAt;
    monthly.bindingHash ??= binding(config);
    if (retirementBindingHash) monthly.retirementBindingHash ??= retirementBindingHash;
  }
}

function checkBillsCatalog(state, config, now, bind = false) {
  calculatedBillsTarget(config);
  const current = config.calculatedBillsTarget;
  const updated = validTime(current.catalogUpdatedAt, now, 'BILLS_CATALOG_TIMESTAMP_INVALID');
  if (!/^[a-f0-9]{64}$/.test(current.catalogHash ?? '') || !Number.isInteger(current.year) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(current.effectiveDate ?? '')) fail('BILLS_CATALOG_INVALID');
  validTime(`${current.effectiveDate}T00:00:00Z`, now, 'BILLS_FORECAST_DATE_INVALID');
  const prior = state.monthly.billsCatalog ?? state.billsCatalog;
  if (prior) {
    const previous = validTime(prior.catalogUpdatedAt, now, 'LEDGER_BILLS_CATALOG_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prior.effectiveDate ?? '')) fail('LEDGER_BILLS_CATALOG_INVALID');
    if (updated < previous || current.year < prior.year || current.effectiveDate < prior.effectiveDate) fail('BILLS_CATALOG_ROLLBACK_BLOCKED');
    if (updated === previous && current.catalogHash !== prior.catalogHash) fail('BILLS_CATALOG_VERSION_CONFLICT');
    if (updated === previous && current.catalogHash === prior.catalogHash && current.year === prior.year &&
        current.effectiveDate === prior.effectiveDate && current.targetCents !== prior.targetCents) fail('BILLS_FORECAST_CHANGED_WITHOUT_CATALOG');
  }
  if (bind) state.monthly.billsCatalog = copy(current);
}

function rothForecast(monthly, config, policy, policyError, now, exclude = null) {
  if (!policy || policyError) return { eligible: false, monthlyAmountCents: null, remainingAnnualCents: null,
    installments: [], blockers: [policyError ?? 'ROTH_POLICY_UNAVAILABLE'], reason: policyError ?? 'ROTH_POLICY_UNAVAILABLE' };
  const forecast = forecastRoth(policy, { now, activationAt: monthly.activationAt ?? config.activationAt,
    ownReservedCents: annualReserved(monthly, clock(now).year, exclude) });
  if (!config.roth?.enabled) return { ...forecast, eligible: false, amountInCents: 0,
    blockers: [...forecast.blockers, 'ROTH_DISABLED'], reason: 'ROTH_DISABLED' };
  const prior = monthly.rothPolicy;
  if (prior && (Date.parse(forecast.policyUpdatedAt) < Date.parse(prior.updatedAt) ||
      forecast.policyUpdatedAt === prior.updatedAt && forecast.policyHash !== prior.hash)) fail('ROTH_POLICY_ROLLBACK_BLOCKED');
  const floor = monthly.outsideContributionFloors[forecast.year];
  if (floor && (forecast.outsideTraditionalCents !== null && forecast.outsideTraditionalCents < floor.traditionalCents ||
      forecast.outsideRothCents !== null && forecast.outsideRothCents < floor.rothCents)) fail('ROTH_OUTSIDE_CONTRIBUTIONS_ROLLBACK_BLOCKED');
  if (Object.keys(monthly.taxYearReview).length) return { ...forecast, eligible: false, amountInCents: 0,
    blockers: [...forecast.blockers, 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED'], reason: 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED' };
  return forecast;
}
function bindRothPolicy(monthly, forecast) {
  if (!forecast.policyHash) return;
  monthly.rothPolicy = { hash: forecast.policyHash, updatedAt: forecast.policyUpdatedAt };
  if (cents(forecast.outsideTraditionalCents) && cents(forecast.outsideRothCents)) monthly.outsideContributionFloors[forecast.year] = {
    traditionalCents: forecast.outsideTraditionalCents, rothCents: forecast.outsideRothCents,
  };
}
function indicativeTarget(policy, monthKey) {
  if (!policy) return null;
  const parsed = parseRothPolicy(policy), year = Number(monthKey.slice(0, 4)), month = Number(monthKey.slice(5));
  const statutory = parsed.statutoryLimits.find(row => row.year === year), personal = parsed.years.find(row => row.year === year);
  if (!statutory) return null;
  const ceiling = add([statutory.baseLimitCents, personal?.catchUpEligible === true ? statutory.catchUpLimitCents : 0]);
  const amount = personal?.eligibility.status === 'verified' ? Math.min(ceiling, personal.eligibility.annualRothLimitCents) : ceiling;
  return Number(BigInt(amount) * BigInt(month) / 12n - BigInt(amount) * BigInt(month - 1) / 12n);
}
function materializeObligations(monthly, config, policy, now) {
  if (!(monthly.activationAt ?? config.activationAt)) return;
  const start = firstMonth(monthly.activationAt ?? config.activationAt), current = clock(now);
  let key = start, count = 0;
  while (key <= current.monthKey && ++count <= MAX_CYCLES) {
    if (key === current.monthKey && now < Date.parse(current.dueAt)) break;
    const row = monthly.obligations[key] ??= { rothTargetCents: null, projectTargetCents: null };
    if (row.rothTargetCents === null) row.rothTargetCents = indicativeTarget(policy, key);
    key = nextMonth(key);
  }
  if (count > MAX_CYCLES) fail('MONTHLY_LEDGER_CAPACITY');
}
function obligationRows(monthly, allocationId, monthKey, firstEligibleMonth) {
  const from = firstEligibleMonth > `${monthKey.slice(0, 4)}-01` ? firstEligibleMonth : `${monthKey.slice(0, 4)}-01`;
  const field = allocationId === 'roth-ira' ? 'rothTargetCents' : 'projectTargetCents';
  const rows = Object.entries(monthly.obligations).filter(([key]) => key >= from && key <= monthKey).map(([key, row]) => ({
    monthKey: key, targetCents: row[field], fundedCents: 0, reservedCents: 0,
  })).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  const byMonth = new Map(rows.map(row => [row.monthKey, row]));
  for (const { child } of allChildren(monthly)) {
    if (child.allocationId !== allocationId || !child.request) continue;
    for (const attribution of child.obligations ?? []) {
      const row = byMonth.get(attribution.monthKey);
      if (!row) continue;
      const field = child.status === 'COMPLETE' ? 'fundedCents' : 'reservedCents';
      row[field] = add([row[field], attribution.amountInCents]);
    }
  }
  return rows;
}
function alert(monthly, data, now) {
  const id = `monthly-${hash([data.monthKey ?? clock(now).monthKey, data.code, data.allocationId ?? null,
    data.shortfallCents ?? data.amountInCents ?? null]).slice(0, 40)}`;
  monthly.alerts[id] ??= { id, severity: 'critical', ...data, createdAt: iso(now), status: 'PENDING', attempts: 0 };
  return monthly.alerts[id];
}
function finishCycle(cycle) {
  if (Object.values(cycle.children).every(child => FINAL.has(child.status))) cycle.status = 'COMPLETE';
}
function targetFor(config, id) {
  if (id === 'bills') return calculatedBillsTarget(config);
  if (id === 'general-spending') return config.allocations.find(row => row.id === id)?.targetCents;
  if (id === 'emergency-fund') return config.monthly.emergencyTargetCents;
  return null;
}
function destination(config, id) {
  return { bills: config.accounts.bills, 'general-spending': config.accounts.general, 'emergency-fund': config.accounts.emergency,
    'roth-ira': config.roth.accountId, 'project-savings': config.monthly.projectAccountId,
    'personal-investment': config.monthly.personalAccountId, 'emergency-excess': config.accounts.income }[id];
}
function snapshot(evidence, role) {
  const result = evidence.accountSnapshots?.[role];
  if (!result) fail('MONTHLY_ACCOUNT_SNAPSHOT_MISSING');
  return result;
}
function emergencyCapBalance(evidence) {
  const emergency = snapshot(evidence, 'emergency');
  // The cap concerns posted Emergency funds, even when a hold reduces available
  // cash. Pending inbound commitments also consume room under that cap.
  return add([emergency.balanceCents, emergency.pendingIncomingCents]);
}
function buildPlan(state, config, pools, evidence, forecast, now) {
  const monthly = state.monthly, current = clock(now), firstEligibleMonth = firstMonth(monthly.activationAt ?? config.activationAt);
  const row = monthly.obligations[current.monthKey] ??= { rothTargetCents: forecast.monthlyAmountCents ?? null, projectTargetCents: null };
  row.projectTargetCents = monthlyPercentageTargets(pools.openingRegularCents).projectCents;
  const plan = planMonthlyFunding({ monthKey: current.monthKey, firstEligibleMonth,
    annualCloseMonth: config.monthly.annualCloseMonth, openingRegularCents: pools.openingRegularCents,
    availableRegularCents: pools.availableRegularCents, windfallHeldCents: pools.windfallHeldCents,
    incomeReserveCents: config.incomeReserveCents,
    bills: { targetCents: targetFor(config, 'bills'), balanceCents: snapshot(evidence, 'bills').fundingBalanceCents },
    general: { targetCents: targetFor(config, 'general-spending'), balanceCents: snapshot(evidence, 'general').fundingBalanceCents },
    emergency: { targetCents: targetFor(config, 'emergency-fund'), balanceCents: emergencyCapBalance(evidence) },
    roth: { eligible: forecast.eligible, annualRemainingCents: forecast.remainingAnnualCents,
      months: obligationRows(monthly, 'roth-ira', current.monthKey, firstEligibleMonth) },
    project: { months: obligationRows(monthly, 'project-savings', current.monthKey, firstEligibleMonth) },
  });
  const emergency = snapshot(evidence, 'emergency');
  const excess = Math.max(0, Math.min(emergency.balanceCents - config.monthly.emergencyTargetCents, emergency.spendableCents));
  return { ...plan, emergencyExcessCents: excess,
    sourceBalanceAt: evidence.incomeBalanceUpdatedAt, billsTargetCents: targetFor(config, 'bills'),
    generalTargetCents: targetFor(config, 'general-spending'), emergencyTargetCents: targetFor(config, 'emergency-fund'),
    rothBlockers: forecast.blockers ?? [], unknownHeldCents: pools.unknownHeldCents };
}

/** Aggregates only: no destination IDs, income descriptions or email addresses. */
export function summarizeMonthlyState({ config, state, now = Date.now() }) {
  const monthly = state.monthly ?? freshMonthlyState(), current = clock(now), cycle = monthly.cycles[current.monthKey];
  const rows = allChildren(monthly), requests = rows.filter(({ child }) => child.request);
  const obligations = Object.entries(monthly.obligations).filter(([key]) => key.slice(0, 4) === String(current.year));
  const sumTargets = field => obligations.some(([, row]) => row[field] === null) ? null : add(obligations.map(([, row]) => row[field]));
  const totals = id => ({ targetCents: sumTargets(id === 'roth-ira' ? 'rothTargetCents' : 'projectTargetCents'),
    settledCents: add(requests.filter(({ cycle, child }) => cycle.monthKey.startsWith(`${current.year}-`) && child.allocationId === id && child.status === 'COMPLETE').map(({ child }) => child.amountInCents)),
    reservedCents: add(requests.filter(({ cycle, child }) => cycle.monthKey.startsWith(`${current.year}-`) && child.allocationId === id && child.status !== 'COMPLETE').map(({ child }) => child.amountInCents)) });
  return { configured: Boolean(config.monthly?.enabled), monthKey: current.monthKey, dueAt: current.dueAt,
    executionEnabled: config.liveEnabled === true && config.mode === 'live', firstEligibleMonth: config.activationAt ? firstMonth(monthly.activationAt ?? config.activationAt) : null,
    cycleStatus: cycle?.status ?? null, openingRegularCents: cycle?.plan.openingRegularCents ?? null,
    allocations: cycle ? Object.values(cycle.children).map(child => ({ allocationId: child.allocationId, amountInCents: child.amountInCents,
      regularCents: child.regularCents, windfallCents: child.windfallCents, status: child.status })) : [],
    pendingTransfers: requests.filter(({ child }) => child.status === 'PENDING').length,
    unknownTransfers: requests.filter(({ child }) => child.status === 'SUBMITTING' && !child.transferId).length,
    reviewRequired: rows.some(({ child }) => child.status === 'REVIEW'),
    alertsPending: Object.values(monthly.alerts).filter(row => row.status !== 'DELIVERED').length,
    roth: totals('roth-ira'), project: totals('project-savings'),
    windfallHeldCents: monthly.income ? monthly.income.windfallReceivedCents - monthly.income.windfallReservedCents : null,
    unknownHeldCents: monthly.income?.unknownHeldCents ?? null,
    taxYearReconciliationRequired: Object.keys(monthly.taxYearReview).length > 0 };
}

export function summarizeMonthlyRoth({ config, state, rothPolicy = null, rothPolicyError = null, rothEvidence = null, now = Date.now() }) {
  const monthly = state.monthly ?? freshMonthlyState(), year = clock(now).year;
  const summary = summarizeMonthlyState({ config, state, now }).roth;
  const base = { configured: Boolean(config.roth?.enabled), year, executionEnabled: false, ...summary,
    ownReservedCents: annualReserved(monthly, year) };
  try {
    const forecast = rothForecast(monthly, config, rothPolicy, rothPolicyError, now);
    const blockers = [...(forecast.blockers ?? [])];
    if (rothEvidence?.route?.status !== 'verified') blockers.push('ROTH_ROUTE_UNVERIFIED');
    else if (rothEvidence.route.sourceAccountId !== config.accounts.income || rothEvidence.route.destinationAccountId !== config.roth.accountId) blockers.push('ROTH_ROUTE_MISMATCH');
    if (!config.roth?.enabled) blockers.push('ROTH_DISABLED');
    const outstandingCents = summary.targetCents === null ? null : Math.max(0, summary.targetCents - summary.settledCents - summary.reservedCents);
    return { ...base, monthlyAmountCents: forecast.monthlyAmountCents, previewAnnualLimitCents: forecast.previewAnnualLimitCents ?? null,
      annualLimitCents: forecast.annualRothLimitCents ?? null, remainingAnnualCents: forecast.remainingAnnualCents,
      outstandingCents, executionEnabled: blockers.length === 0 && config.liveEnabled === true && config.mode === 'live', blockers };
  } catch (error) { return { ...base, monthlyAmountCents: null, remainingAnnualCents: null, blockers: [safeCode(error)] }; }
}

/** One CAS lease, one immutable monthly allocation plan, many identified pending
 * legs. An unknown provider outcome prevents every subsequent financial POST. */
export async function reconcileMonthly({ config, client, store, monthlyPolicy, monthlyPolicyError = null, rothPolicy = null, rothEvidence = null,
  rothPolicyError = null, now = () => Date.now(), uuid = randomUUID, forceObserve = false, sendAlert = null,
  dependencies = {} }) {
  const readEvidence = dependencies.readMonthlyEvidence ?? readMonthlyEvidence;
  const checkRoth = dependencies.checkMonthlyRothEvidence ?? checkMonthlyRothEvidence;
  const reconcileCash = dependencies.reconcileIncome ?? reconcileIncome;
  const checkNativeRules = dependencies.verifyMonthlyNativeRules ?? verifyMonthlyNativeRules;
  const started = now(), deadline = started + RUN_MS, owner = uuid();
  let retirement;
  try { retirement = validateMonthlySequenceRetirement(config, started); }
  catch (error) { return { status: 'blocked', code: safeCode(error) }; }
  let record = await store.read(), state = validateMonthlyState(copy(record?.value ?? initialState()));
  if (state.lease && Date.parse(state.lease.expiresAt) > started) return { status: 'busy', code: 'ANOTHER_RUN_OWNS_LEASE' };
  if (state.active || Object.keys(state.events).length) return { status: 'review', code: 'MONTHLY_LEGACY_HISTORY_REQUIRES_REVIEW' };
  state.monthly ??= freshMonthlyState();
  const monthly = state.monthly;
  const live = config.mode === 'live' && config.liveEnabled === true && !forceObserve;
  // Refuse an invalid migration/competing rule before any fresh ledger write.
  // Already accepted transfers retain their normal observable recovery path.
  if (retirement && !monthlyOwnedTransfers(state).some(row => row.transferId && row.status === 'PENDING')) {
    try { await checkNativeRules(client, config, { now: now() }); }
    catch (error) { return { status: 'blocked', code: safeCode(error) }; }
  }
  state.lease = { owner, expiresAt: iso(started + LEASE_MS) };
  try { record = await store.compareAndSwap(record?.etag ?? null, copy(state)); }
  catch (error) {
    if (error.code === 'STORE_CONFLICT' || error.name === 'StoreConflict') return { status: 'busy', code: 'ANOTHER_RUN_WON_CLAIM' };
    throw error;
  }
  let result, lostLease = false;
  async function save() {
    if (lostLease || state.lease?.owner !== owner || now() >= deadline || Date.parse(state.lease.expiresAt) <= now() + 15000) fail('LEASE_OR_RUN_EXPIRED');
    validateMonthlyState(state);
    try { record = await store.compareAndSwap(record.etag, copy(state)); }
    catch (error) { lostLease = true; throw error; }
  }
  async function flushAlerts() {
    if (!live || typeof sendAlert !== 'function') return;
    for (const entry of Object.values(monthly.alerts).filter(row => row.status === 'PENDING').slice(0, 12)) {
      if (now() >= deadline - 15000) break;
      if (entry.firstAttemptAt && now() - Date.parse(entry.firstAttemptAt) >= RECOVERY_MS) {
        entry.status = 'REVIEW'; entry.lastError = 'ALERT_IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED'; await save(); continue;
      }
      entry.firstAttemptAt ??= iso(now());
      entry.attempts += 1; entry.lastAttemptAt = iso(now()); await save();
      try {
        const delivered = await sendAlert(copy(entry));
        if (typeof delivered?.deliveryId !== 'string' || !delivered.deliveryId) fail('MONTHLY_ALERT_DELIVERY_UNCONFIRMED');
        entry.status = 'DELIVERED'; entry.deliveryId = delivered.deliveryId; entry.deliveredAt = iso(now());
        delete entry.lastError;
      } catch (error) { entry.lastError = safeCode(error); }
      await save();
    }
  }
  function review(cycle, child, code) {
    child.status = 'REVIEW'; child.reason = code; cycle.status = 'REVIEW';
    alert(monthly, { monthKey: cycle.monthKey, code, allocationId: child.allocationId, amountInCents: child.amountInCents }, now());
    return { status: 'review', code, allocationId: child.allocationId };
  }
  function receive(cycle, child, transfer) {
    if (!transfer || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(transfer.id ?? '') || child.transferId && transfer.id !== child.transferId ||
        transfer.executionMode !== 'LIVE' || transfer.origin !== 'USER' || transfer.ruleId !== null || transfer.ruleExecutionId !== null ||
        transfer.source?.id !== child.request.sourceAccountId || transfer.destination?.id !== child.request.destinationAccountId ||
        transfer.source.isDeleted !== false || transfer.destination.isDeleted !== false || transfer.amountInCents !== child.amountInCents) {
      return review(cycle, child, 'MONTHLY_TRANSFER_IDENTITY_INVALID');
    }
    child.transferId = transfer.id; child.providerStatus = transfer.status; child.updatedAt = iso(now());
    try { if (validTime(transfer.createdAt, now(), 'MONTHLY_TRANSFER_TIME_INVALID') < Date.parse(child.firstAttemptAt)) return review(cycle, child, 'MONTHLY_TRANSFER_TIME_INVALID'); }
    catch { return review(cycle, child, 'MONTHLY_TRANSFER_TIME_INVALID'); }
    if (transfer.status === 'COMPLETE') {
      let completed;
      try { completed = validTime(transfer.completedAt, now(), 'MONTHLY_SETTLEMENT_TIME_INVALID'); }
      catch { return review(cycle, child, 'MONTHLY_SETTLEMENT_TIME_INVALID'); }
      if (completed < Date.parse(child.firstAttemptAt) || transfer.errorCode !== null) return review(cycle, child, 'MONTHLY_SETTLEMENT_INVALID');
      child.status = 'COMPLETE'; child.completedAt = transfer.completedAt;
      monthly.lastSettledAt = iso(Math.max(completed, Date.parse(monthly.lastSettledAt ?? 0) || 0));
      state.lastSettledAt = monthly.lastSettledAt;
      if (child.allocationId === 'roth-ira' && clock(completed).year !== Number(cycle.monthKey.slice(0, 4))) {
        monthly.taxYearReview[`${cycle.monthKey}:${child.allocationId}`] = true;
        alert(monthly, { monthKey: cycle.monthKey, code: 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED', allocationId: child.allocationId }, now());
      }
      finishCycle(cycle);
      return { status: 'complete', code: 'MONTHLY_TRANSFER_SETTLED', allocationId: child.allocationId };
    }
    if (PENDING.has(transfer.status) && transfer.completedAt === null && transfer.errorCode === null) {
      child.status = 'PENDING';
      return { status: 'pending', code: transfer.status === 'APPROVAL_PENDING' ? 'PROVIDER_APPROVAL_REQUIRED' : 'MONTHLY_TRANSFER_PENDING', allocationId: child.allocationId };
    }
    return review(cycle, child, 'MONTHLY_TRANSFER_FAILED');
  }
  async function evidenceAndPools(exclude = null) {
    if (!monthlyPolicy || monthlyPolicyError) fail(monthlyPolicyError ?? 'MONTHLY_POLICY_UNAVAILABLE');
    if (monthlyPolicy.opening.status !== 'verified') fail('INCOME_OPENING_UNVERIFIED');
    const evidence = await readEvidence(client, config, { now: now(), knownTransfers: knownTransfers(state),
      lastSettledAt: monthly.lastSettledAt ?? state.lastSettledAt, externalFrom: incomeScanFrom(monthlyPolicy, monthly.income) });
    const ownedTransfers = monthlyOwnedTransfers(state);
    const pools = reconcileCash({ policy: monthlyPolicy, ledger: monthly.income, evidence, ownedTransfers });
    if (live) {
      monthly.income = pools.ledger;
      for (const entry of pools.alerts ?? []) alert(monthly, { ...entry, monthKey: clock(now()).monthKey }, now());
      await save();
    }
    // A same-key recovery checks whether the original windfall reservation could
    // still be sent. Never remove that reservation from the durable income ledger.
    return { evidence, pools: exclude ? { ...pools,
      windfallHeldCents: add([pools.windfallHeldCents, exclude.child.windfallCents]),
      availableRegularCents: Math.max(0, pools.availableRegularCents - exclude.child.windfallCents) } : pools };
  }
  function authorizedForecast(evidence, exclude = null) {
    let forecast;
    try {
      forecast = rothForecast(monthly, config, rothPolicy, rothPolicyError, now(), exclude);
      if (forecast.eligible) checkRoth(evidence, config, { now: now(), rothEvidence, knownTransfers: knownTransfers(state),
        outsideContributionsVerifiedAt: rothPolicy?.years.find(row => row.year === clock(now()).year)?.outsideContributions?.verifiedAt });
      if (live) bindRothPolicy(monthly, forecast);
      return forecast;
    } catch (error) {
      return { ...(forecast ?? { monthlyAmountCents: null, remainingAnnualCents: null, installments: [] }), eligible: false,
        blockers: [...(forecast?.blockers ?? []), safeCode(error)], reason: safeCode(error) };
    }
  }
  async function submit(cycle, child, retry = false) {
    if (!writableWindow(cycle.monthKey, now())) return retry ? review(cycle, child, 'MONTHLY_RECOVERY_WINDOW_CLOSED') : { status: 'waiting', code: 'MONTHLY_FIRST_DAY_ONLY' };
    if (retry && (now() - Date.parse(child.firstAttemptAt) < 0 || now() - Date.parse(child.firstAttemptAt) >= RECOVERY_MS)) return review(cycle, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED');
    if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) return { status: 'waiting', code: 'RETRY_NOT_DUE' };
    checkBillsCatalog(state, config, now(), true);
    const { evidence, pools } = await evidenceAndPools(retry ? { cycle, child } : null);
    if (child.allocationId === 'emergency-excess') {
      const emergency = snapshot(evidence, 'emergency');
      if (child.amountInCents > Math.max(0, emergency.balanceCents - config.monthly.emergencyTargetCents) ||
          child.amountInCents > emergency.spendableCents) return { status: 'waiting', code: 'EMERGENCY_EXCESS_CHANGED' };
    } else {
      if (child.regularCents > Math.max(0, pools.availableRegularCents - config.incomeReserveCents) || child.windfallCents > pools.windfallHeldCents ||
          child.amountInCents > evidence.sourceSpendableCents) return { status: 'waiting', code: 'MONTHLY_RESERVED_CASH_UNAVAILABLE' };
      if (targetFor(config, 'bills') > cycle.plan.billsTargetCents || targetFor(config, 'general-spending') > cycle.plan.generalTargetCents ||
          targetFor(config, 'emergency-fund') !== cycle.plan.emergencyTargetCents) return { status: 'waiting', code: 'MONTHLY_PRIORITY_TARGET_CHANGED' };
      if (child.allocationId !== 'bills' && snapshot(evidence, 'bills').fundingBalanceCents < targetFor(config, 'bills') ||
          !['bills', 'general-spending'].includes(child.allocationId) && snapshot(evidence, 'general').fundingBalanceCents < targetFor(config, 'general-spending')) {
        return { status: 'waiting', code: 'MONTHLY_ESSENTIAL_PRIORITY_UNMET' };
      }
      const role = { bills: 'bills', 'general-spending': 'general', 'emergency-fund': 'emergency' }[child.allocationId];
      const targetBalance = role === 'emergency' ? emergencyCapBalance(evidence) : role ? snapshot(evidence, role).fundingBalanceCents : null;
      if (role && child.amountInCents > Math.max(0, targetFor(config, child.allocationId) - targetBalance)) return { status: 'waiting', code: 'MONTHLY_TARGET_CHANGED' };
      const rothChild = cycle.children['roth-ira'];
      if (['project-savings', 'personal-investment'].includes(child.allocationId) && rothChild.amountInCents > 0 && !rothChild.request) {
        return { status: 'waiting', code: 'ROTH_PRIORITY_UNMET' };
      }
      if (child.allocationId === 'roth-ira') {
        const forecast = authorizedForecast(evidence, retry ? child : null);
        if (!forecast.eligible || child.amountInCents > forecast.remainingAnnualCents) return retry
          ? review(cycle, child, 'ROTH_RETRY_NO_LONGER_WITHIN_LIMIT') : { status: 'waiting', code: forecast.reason ?? 'ROTH_ANNUAL_ROOM_UNAVAILABLE' };
      }
      if (child.allocationId === 'personal-investment' && Object.values(monthly.alerts).some(entry => entry.severity === 'critical' && entry.status !== 'DELIVERED')) {
        return { status: 'waiting', code: 'MONTHLY_CRITICAL_ALERT_UNDELIVERED' };
      }
    }
    if (!child.request) {
      const request = { sourceAccountId: child.allocationId === 'emergency-excess' ? config.accounts.emergency : config.accounts.income,
        destinationAccountId: destination(config, child.allocationId), amountInCents: child.amountInCents,
        description: child.allocationId === 'roth-ira' ? 'ROTH IRA' : child.allocationId === 'emergency-excess' ? 'EF RETURN' : 'FINANCE',
        reasonForApproval: `Monthly finance coordinator ${cycle.monthKey}: ${child.allocationId}; reserved regular ${child.regularCents} cents and windfall ${child.windfallCents} cents.` };
      Object.assign(child, { request, requestHash: hash(request), idempotencyKey: uuid(), firstAttemptAt: iso(now()), status: 'SUBMITTING', attempts: 0 });
    }
    child.attempts += 1; child.lastAttemptAt = iso(now());
    await save();
    if (!writableWindow(cycle.monthKey, now())) return review(cycle, child, 'MONTHLY_RECOVERY_WINDOW_CLOSED');
    if (now() >= deadline || Date.parse(state.lease.expiresAt) <= now() + 15000) fail('LEASE_OR_RUN_EXPIRED');
    let response;
    try { response = await client.createTransfer({ idempotencyKey: child.idempotencyKey, request: copy(child.request), firstAttemptAt: child.firstAttemptAt }); }
    catch (error) {
      if (error.uncertain !== false || error.status === 429) {
        child.status = 'SUBMITTING'; child.lastError = safeCode(error);
        const delay = Math.max(60, Math.min(Number(error.retryAfter) || 60, RECOVERY_MS / 1000));
        child.nextAttemptAt = iso(now() + delay * 1000);
        alert(monthly, { monthKey: cycle.monthKey, code: 'MONTHLY_SUBMISSION_UNKNOWN', allocationId: child.allocationId, amountInCents: child.amountInCents }, now());
        await save();
        return { status: 'uncertain', code: 'MONTHLY_SUBMISSION_UNKNOWN', allocationId: child.allocationId };
      }
      const result = review(cycle, child, 'MONTHLY_PROVIDER_REJECTED'); await save(); return result;
    }
    const received = receive(cycle, child, response);
    await save();
    return received;
  }
  try {
    // Accepted transfers remain observable while paused and outside the first.
    for (const { cycle, child } of allChildren(monthly).filter(({ child }) => child.transferId && child.status === 'PENDING')) {
      try { receive(cycle, child, await client.getTransfer(child.transferId)); }
      catch (error) { return result = { status: 'waiting', code: safeCode(error) }; }
      await save();
    }
    if (allChildren(monthly).some(({ child }) => child.status === 'REVIEW')) {
      await flushAlerts(); return result = { status: 'review', code: 'MONTHLY_REVIEW_REQUIRED' };
    }
    configuration(monthly, config, now(), live);
    checkBillsCatalog(state, config, now(), live);
    if (live && typeof sendAlert !== 'function') return result = { status: 'blocked', code: 'MONTHLY_ALERT_SENDER_REQUIRED' };
    const scratch = live ? monthly : copy(monthly);
    materializeObligations(scratch, config, rothPolicyError ? null : rothPolicy, now());
    if (live) await save();
    const uncertain = allChildren(monthly).find(({ child }) => child.status === 'SUBMITTING' && !child.transferId);
    if (uncertain) {
      if (!live) return result = { status: 'observe', code: 'MONTHLY_UNKNOWN_INTENT_PAUSED' };
      result = await submit(uncertain.cycle, uncertain.child, true); await save(); await flushAlerts();
      if (result.status !== 'pending' && result.status !== 'complete') return result;
    }
    const { evidence, pools } = await evidenceAndPools();
    const forecast = authorizedForecast(evidence);
    const current = clock(now()), activation = monthly.activationAt ?? config.activationAt;
    if (!activation || current.monthKey < firstMonth(activation) || now() < Date.parse(current.dueAt)) {
      await flushAlerts(); return result = { status: live ? 'waiting' : 'observe', code: activation ? 'MONTHLY_NOT_DUE' : 'MONTHLY_ACTIVATION_REQUIRED' };
    }
    // Record missed opportunities without making a late financial request.
    if (live) {
      for (const old of Object.values(monthly.cycles)) if (old.monthKey < current.monthKey || !writableWindow(old.monthKey, now())) {
        for (const child of Object.values(old.children)) if (child.status === 'PLANNED') {
          child.status = 'SKIPPED'; child.reason = 'MONTHLY_FIRST_DAY_MISSED';
          alert(monthly, { monthKey: old.monthKey, code: 'MONTHLY_ALLOCATION_MISSED', allocationId: child.allocationId, amountInCents: child.amountInCents }, now());
        }
        finishCycle(old);
      }
      if (!writableWindow(current.monthKey, now()) && !monthly.cycles[current.monthKey]) alert(monthly,
        { monthKey: current.monthKey, code: 'MONTHLY_CYCLE_MISSED', shortfallCents: monthly.obligations[current.monthKey]?.rothTargetCents ?? null }, now());
      await save();
    }
    if (!writableWindow(current.monthKey, now())) {
      await flushAlerts(); return result = { status: live ? 'waiting' : 'observe', code: 'MONTHLY_FIRST_DAY_ONLY' };
    }
    let cycle = monthly.cycles[current.monthKey];
    if (!cycle) {
      if (allChildren(monthly).some(({ cycle, child }) => cycle.monthKey < current.monthKey && child.status === 'PENDING')) {
        if (live) { alert(monthly, { monthKey: current.monthKey, code: 'MONTHLY_PRIOR_CYCLE_PENDING' }, now()); await save(); await flushAlerts(); }
        return result = { status: 'waiting', code: 'MONTHLY_PRIOR_CYCLE_PENDING' };
      }
      const working = live ? state : { ...state, monthly: scratch };
      const plan = buildPlan(working, config, pools, evidence, forecast, now());
      if (!live) return result = { status: 'observe', code: 'READ_ONLY_MONTHLY_PLAN', plan };
      if (Object.keys(monthly.cycles).length >= MAX_CYCLES) fail('MONTHLY_LEDGER_CAPACITY');
      const children = Object.fromEntries(plan.allocations.map(line => [line.allocationId, { ...copy(line),
        status: line.amountInCents >= 100 ? 'PLANNED' : 'NOOP', reason: line.amountInCents > 0 && line.amountInCents < 100 ? 'BELOW_PROVIDER_MINIMUM' : line.reason }]));
      if (plan.emergencyExcessCents >= 100) children['emergency-excess'] = { allocationId: 'emergency-excess', amountInCents: plan.emergencyExcessCents,
        regularCents: 0, windfallCents: 0, status: 'PLANNED' };
      cycle = { monthKey: current.monthKey, taxYear: current.year, createdAt: iso(now()), status: 'OPEN', plan, planHash: hash(plan), children };
      monthly.cycles[current.monthKey] = cycle;
      for (const entry of plan.alerts) alert(monthly, { ...entry, monthKey: current.monthKey }, now());
      for (const child of Object.values(children)) if (child.amountInCents > 0 && child.amountInCents < 100) {
        alert(monthly, { monthKey: current.monthKey, code: 'MONTHLY_BELOW_PROVIDER_MINIMUM', allocationId: child.allocationId, amountInCents: child.amountInCents }, now());
      }
      finishCycle(cycle); await save();
    }
    if (!live) return result = { status: 'observe', code: 'READ_ONLY_MONTHLY_PLAN', plan: copy(cycle.plan) };
    await flushAlerts();
    let submitted = 0;
    for (const id of [...MONTHLY_ALLOCATION_IDS, 'emergency-excess']) {
      const child = cycle.children[id];
      if (!child) continue;
      if (child.status !== 'PLANNED') continue;
      const response = await submit(cycle, child);
      if (!['pending', 'complete'].includes(response.status)) {
        alert(monthly, { monthKey: cycle.monthKey, code: response.code, allocationId: child.allocationId, amountInCents: child.amountInCents }, now());
        await save(); await flushAlerts(); return result = { ...response, submitted };
      }
      submitted += 1;
    }
    finishCycle(cycle); await save(); await flushAlerts();
    return result = { status: cycle.status === 'COMPLETE' ? 'complete' : 'pending', code: submitted ? 'MONTHLY_TRANSFERS_SUBMITTED' : cycle.status === 'COMPLETE' ? 'MONTHLY_CYCLE_COMPLETE' : 'MONTHLY_TRANSFERS_PENDING',
      submitted, monthKey: current.monthKey, summary: summarizeMonthlyState({ config, state, now: now() }) };
  } catch (error) {
    result = { status: 'blocked', code: safeCode(error) };
    if (live && !lostLease && now() < deadline) {
      alert(monthly, { monthKey: clock(now()).monthKey, code: safeCode(error) }, now());
      try { await save(); await flushAlerts(); } catch { /* A failed financial persistence never permits another POST. */ }
    }
    return result;
  } finally {
    if (!lostLease && now() < deadline && state.lease?.owner === owner) {
      monthly.lastRun = { at: iso(now()), result: result ?? { status: 'blocked', code: 'MONTHLY_RUN_INTERRUPTED' } };
      state.lastRun = { at: iso(now()), mode: live ? 'live' : 'observe', result: monthly.lastRun.result };
      state.lease = null;
      try { await store.compareAndSwap(record.etag, copy(state)); } catch { /* Preserve prior durable version on conflict. */ }
    }
  }
}

/** Pure operational preview: use a private in-memory CAS store, never mutate the
 * caller's ledger, submit a transfer, or send an alert. */
export async function previewMonthly(args) {
  const original = await args.store.read();
  let value = copy(original?.value ?? initialState()), version = 0;
  // A preview does not contend with the production lease or change it.
  value.lease = null;
  const store = { read: async () => ({ value: copy(value), etag: String(version) }),
    compareAndSwap: async (_etag, next) => { value = copy(next); return { value: copy(value), etag: String(++version) }; } };
  return reconcileMonthly({ ...args, store, forceObserve: true, sendAlert: null });
}
