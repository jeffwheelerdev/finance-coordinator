import { createHash, randomUUID } from 'node:crypto';
import { EvidenceError, PENDING, checkRules, discoverEvents, verifyRefund, fundingPlan, validTime, calculatedBillsTarget } from './evidence.mjs';
import { verifyUpstreamFunding } from './upstream.mjs';
import { forecastRoth } from './roth.mjs';
import { parseRothEvidence, rothFundingPlan } from './roth-evidence.mjs';

export const LEASE_MS = 360_000; // Must exceed the deployed function's 300-second maximum.
const RUN_MS = 240_000;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_EVENTS = 4000;
const finalChild = (child) => ['COMPLETE', 'NOOP', 'SKIPPED'].includes(child.status);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const clone = (value) => structuredClone(value);
const isRoth = (event) => event.kind === 'roth-month';
const ROTH_ID = 'roth-ira';
const refundEvent = (event) => event.kind === undefined || event.kind === 'refund';

function localMonth(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find(part => part.type === 'year').value);
  return { year, monthKey: `${year}-${parts.find(part => part.type === 'month').value}` };
}

export class EngineError extends Error {
  constructor(code) { super(code); this.name = 'EngineError'; this.code = code; }
}

export function initialState() {
  return { schemaVersion: 1, activationAt: null, bindingHash: null, allocations: {}, events: {}, active: null,
    lastSettledAt: null, lease: null, lastRun: null, inbox: {}, billsCatalog: null,
    rothBinding: null, rothPolicy: null, rothContributionFloors: {} };
}

export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !state.events || !state.allocations || !state.inbox ||
      Array.isArray(state.events) || Array.isArray(state.allocations) || Array.isArray(state.inbox) ||
      Object.keys(state.events).length > MAX_EVENTS ||
      (state.lease && (typeof state.lease.owner !== 'string' || !Number.isFinite(Date.parse(state.lease.expiresAt))))) {
    throw new EngineError('LEDGER_INVALID');
  }
  if (state.rothBinding && (typeof state.rothBinding.incomeAccountId !== 'string' ||
      typeof state.rothBinding.destinationAccountId !== 'string' || !/^[a-z][a-z0-9_-]{0,95}$/.test(state.rothBinding.policyId ?? '') ||
      !Number.isFinite(Date.parse(state.rothBinding.firstEligibleAt)))) throw new EngineError('LEDGER_ROTH_BINDING_INVALID');
  if (state.rothPolicy && (!/^[a-f0-9]{64}$/.test(state.rothPolicy.hash ?? '') ||
      !Number.isFinite(Date.parse(state.rothPolicy.updatedAt)))) throw new EngineError('LEDGER_ROTH_POLICY_INVALID');
  if (state.rothContributionFloors !== undefined && (!state.rothContributionFloors || typeof state.rothContributionFloors !== 'object' ||
      Array.isArray(state.rothContributionFloors) || Object.entries(state.rothContributionFloors).some(([year, floor]) =>
        !/^\d{4}$/.test(year) || !floor || !Number.isSafeInteger(floor.traditionalCents) || floor.traditionalCents < 0 ||
        !Number.isSafeInteger(floor.rothCents) || floor.rothCents < 0))) throw new EngineError('LEDGER_ROTH_CONTRIBUTIONS_INVALID');
  if (state.active && !state.events[state.active.eventKey]?.children?.[state.active.allocationId]) throw new EngineError('LEDGER_ACTIVE_INTENT_MISSING');
  const unresolved = [];
  for (const [eventKey, event] of Object.entries(state.events)) {
    if (!event || event.key !== eventKey || !event.children || Array.isArray(event.children) || !['OPEN', 'COMPLETE', 'REVIEW'].includes(event.status)) throw new EngineError('LEDGER_EVENT_INVALID');
    if (!refundEvent(event) && !isRoth(event)) throw new EngineError('LEDGER_EVENT_KIND_INVALID');
    if (isRoth(event)) {
      if (!/^[a-z][a-z0-9_-]{0,95}$/.test(event.policyId ?? '') || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(event.monthKey ?? '') ||
          event.taxYear !== Number(event.monthKey.slice(0, 4)) || event.key !== `roth:${event.policyId}:${event.monthKey}` ||
          Object.keys(event.children).length !== 1 || !event.children[ROTH_ID] ||
          event.dueAt !== new Date(Date.UTC(event.taxYear, Number(event.monthKey.slice(5)) - 1, 1, 15)).toISOString()) {
        throw new EngineError('LEDGER_ROTH_EVENT_INVALID');
      }
      const child = event.children[ROTH_ID];
      if (child.request && (!Number.isSafeInteger(child.request.amountInCents) || child.request.amountInCents < 100 ||
          child.request.destinationAccountId !== child.destinationAccountId)) throw new EngineError('LEDGER_ROTH_AMOUNT_INVALID');
      if (child.plannedAmountInCents !== undefined && (!Number.isSafeInteger(child.plannedAmountInCents) ||
          child.plannedAmountInCents < 0)) throw new EngineError('LEDGER_ROTH_AMOUNT_INVALID');
    }
    for (const [allocationId, child] of Object.entries(event.children)) {
      if (!child || child.allocationId !== allocationId || !['WAITING', 'SUBMITTING', 'PENDING', 'COMPLETE', 'NOOP', 'SKIPPED', 'REVIEW'].includes(child.status)) throw new EngineError('LEDGER_CHILD_INVALID');
      if (['SUBMITTING', 'PENDING'].includes(child.status)) unresolved.push({ eventKey: event.key, allocationId });
      if (child.request && child.requestHash !== hash(child.request)) throw new EngineError('LEDGER_REQUEST_CHANGED');
    }
    if (event.status === 'COMPLETE' && !Object.values(event.children).every(finalChild)) throw new EngineError('LEDGER_COMPLETION_INVALID');
  }
  if (unresolved.length > 1 || (unresolved.length === 0 && state.active) ||
      (unresolved.length === 1 && (unresolved[0].eventKey !== state.active?.eventKey || unresolved[0].allocationId !== state.active?.allocationId))) {
    throw new EngineError('LEDGER_RESERVATION_INVALID');
  }
  return state;
}

/** Every immutable request reserves annual room, even an unknown or failed
 * request awaiting review. A retry excludes only its own existing reservation. */
export function rothAnnualReservations(state, year, { excludeEventKey = null } = {}) {
  let reservedCents = 0, settledCents = 0;
  for (const event of Object.values(state.events ?? {})) {
    if (!isRoth(event) || event.taxYear !== year || event.key === excludeEventKey) continue;
    const child = event.children?.[ROTH_ID];
    if (!child?.request) continue;
    const amount = child.request.amountInCents;
    if (!Number.isSafeInteger(amount) || amount < 100 || !Number.isSafeInteger(reservedCents + amount)) throw new EngineError('LEDGER_ROTH_AMOUNT_INVALID');
    reservedCents += amount;
    if (child.status === 'COMPLETE') settledCents += amount;
  }
  return { reservedCents, settledCents, unresolvedCents: reservedCents - settledCents };
}

function rothPolicyCheck(state, config, forecast, now) {
  const prior = state.rothBinding;
  if (prior && (prior.incomeAccountId !== config.accounts.income || prior.destinationAccountId !== config.roth?.accountId ||
      prior.policyId !== forecast.policyId)) throw new EngineError('ROTH_BINDING_CHANGED');
  const currentAt = validTime(forecast.policyUpdatedAt, now, 'ROTH_POLICY_TIMESTAMP_INVALID');
  if (state.rothPolicy) {
    const previousAt = validTime(state.rothPolicy.updatedAt, now, 'LEDGER_ROTH_POLICY_INVALID');
    if (currentAt < previousAt) throw new EngineError('ROTH_POLICY_ROLLBACK_BLOCKED');
    if (currentAt === previousAt && state.rothPolicy.hash !== forecast.policyHash) throw new EngineError('ROTH_POLICY_VERSION_CONFLICT');
  }
  if (Object.values(state.events).some(event => isRoth(event) && event.taxYearReconciliationRequired)) {
    throw new EngineError('ROTH_TAX_YEAR_RECONCILIATION_REQUIRED');
  }
  const floor = state.rothContributionFloors?.[forecast.year];
  if (floor && ((forecast.outsideTraditionalCents !== null && forecast.outsideTraditionalCents < floor.traditionalCents) ||
      (forecast.outsideRothCents !== null && forecast.outsideRothCents < floor.rothCents))) {
    throw new EngineError('ROTH_OUTSIDE_CONTRIBUTIONS_ROLLBACK_BLOCKED');
  }
}

function rothForecast(state, config, policy, now, excludeEventKey = null) {
  const { year } = localMonth(now);
  const { reservedCents } = rothAnnualReservations(state, year, { excludeEventKey });
  const activationAt = state.rothBinding?.firstEligibleAt ?? (state.activationAt ? iso(now) : config.activationAt);
  const forecast = forecastRoth(policy, { now, activationAt,
    ownReservedCents: reservedCents });
  rothPolicyCheck(state, config, forecast, now);
  return forecast;
}

function unpaidRothReserve(state, config, now, forecast = null) {
  if (!config.roth?.enabled) return 0;
  const current = Object.values(state.events ?? {}).find(event => isRoth(event) && event.monthKey === localMonth(now).monthKey);
  if (current && finalChild(current.children[ROTH_ID])) return 0;
  const held = current?.children[ROTH_ID]?.plannedAmountInCents ?? 0;
  return Math.max(held, forecast?.eligible ? forecast.amountInCents : 0);
}

function rothCashOptions(state, policy, forecast, now) {
  return { now, lastSettledAt: state.lastSettledAt,
    outsideContributionsVerifiedAt: policy.years.find(item => item.year === forecast.year)?.outsideContributions?.verifiedAt ?? null,
    ownTransfers: Object.values(state.events).filter(isRoth).flatMap(event => {
      const child = event.children[ROTH_ID];
      return child.request && child.transferId ? [{ transferId: child.transferId,
        sourceAccountId: child.request.sourceAccountId, destinationAccountId: child.request.destinationAccountId,
        amountInCents: child.request.amountInCents, status: child.status, firstAttemptAt: child.firstAttemptAt,
        completedAt: child.completedAt ?? null }] : [];
    }),
  };
}

function rothEvidenceBlockers(config, input, now) {
  if (!input) return ['ROTH_ROUTE_UNVERIFIED', 'ROTH_NATIVE_PROOF_UNVERIFIED'];
  try {
    const evidence = parseRothEvidence(input), blockers = [];
    validTime(evidence.updatedAt, now, 'ROTH_EVIDENCE_TIME_INVALID');
    if (evidence.route.status !== 'verified') blockers.push('ROTH_ROUTE_UNVERIFIED');
    else if (evidence.route.sourceAccountId !== config.accounts.income || evidence.route.destinationAccountId !== config.roth?.accountId ||
        Object.values(config.accounts).includes(config.roth?.accountId)) blockers.push('ROTH_ROUTE_MISMATCH');
    if (evidence.upstream.status !== 'verified') blockers.push('ROTH_NATIVE_PROOF_UNVERIFIED');
    else if (evidence.upstream.ruleId !== config.rules.funding) blockers.push('ROTH_NATIVE_PROOF_MISMATCH');
    return blockers;
  } catch (error) { return [safeCode(error)]; }
}

function bindRoth(state, config, forecast, now, firstActivation) {
  if (!state.rothBinding) state.rothBinding = {
    incomeAccountId: config.accounts.income, destinationAccountId: config.roth.accountId, policyId: forecast.policyId,
    firstEligibleAt: firstActivation ? config.activationAt : iso(now),
  };
  state.rothPolicy = { hash: forecast.policyHash, updatedAt: forecast.policyUpdatedAt };
  if (Number.isSafeInteger(forecast.outsideTraditionalCents) && Number.isSafeInteger(forecast.outsideRothCents)) {
    state.rothContributionFloors ??= {};
    state.rothContributionFloors[forecast.year] = {
      traditionalCents: forecast.outsideTraditionalCents, rothCents: forecast.outsideRothCents,
    };
  }
}

/** Safe authenticated aggregate view. It never exposes provider identifiers or
 * personal evidence references and never claims a monthly opportunity. */
export function summarizeRothState({ config, state, rothPolicy = null, rothEvidence = null, rothPolicyError = null, now = Date.now() }) {
  const clock = localMonth(now), totals = rothAnnualReservations(state, clock.year);
  const current = Object.values(state.events ?? {}).find(event => isRoth(event) && event.monthKey === clock.monthKey);
  const common = { configured: Boolean(config.roth?.enabled), year: clock.year, monthKey: clock.monthKey,
    ownReservedCents: totals.reservedCents, ownSettledCents: totals.settledCents, ownUnresolvedCents: totals.unresolvedCents,
    monthStatus: current?.children?.[ROTH_ID]?.status ?? null, executionEnabled: false,
    taxYearReconciliationRequired: Object.values(state.events ?? {}).some(event => isRoth(event) && event.taxYearReconciliationRequired) };
  if (!config.roth?.enabled) return { ...common, eligible: false, amountInCents: 0, blockers: ['ROTH_DISABLED'] };
  if (!rothPolicy || rothPolicyError) return { ...common, eligible: false, amountInCents: 0, blockers: [rothPolicyError ?? 'ROTH_POLICY_UNAVAILABLE'] };
  try {
    const forecast = rothForecast(state, config, rothPolicy, now);
    const handled = current && finalChild(current.children[ROTH_ID]);
    const evidenceBlockers = rothEvidenceBlockers(config, rothEvidence, now);
    const blockers = [...forecast.blockers, ...evidenceBlockers, ...(handled ? ['ROTH_MONTH_ALREADY_HANDLED'] : [])];
    if (current?.children[ROTH_ID]?.request && !handled) blockers.push('ROTH_EXISTING_INTENT_UNRESOLVED');
    const eligible = blockers.length === 0;
    return { ...common, dueAt: forecast.dueAt, policyUpdatedAt: forecast.policyUpdatedAt,
      statutoryLimitCents: forecast.statutoryLimitCents, previewAnnualLimitCents: forecast.previewAnnualLimitCents,
      annualRothLimitCents: forecast.annualRothLimitCents, annualCombinedLimitCents: forecast.annualCombinedLimitCents,
      monthlyAmountCents: forecast.monthlyAmountCents, remainingAnnualCents: forecast.remainingAnnualCents,
      installments: forecast.installments, monetaryEligible: forecast.eligible, eligible,
      executionEnabled: eligible && config.liveEnabled === true && config.mode === 'live',
      amountInCents: eligible ? forecast.amountInCents : 0, blockers };
  } catch (error) { return { ...common, eligible: false, amountInCents: 0, blockers: [safeCode(error)] }; }
}

function binding(config) {
  return hash({ income: config.accounts.income, pod: config.accounts.pod, bills: config.accounts.bills, rules: config.rules });
}

function checkBillsCatalog(state, config, now) {
  calculatedBillsTarget(config);
  const current = config.calculatedBillsTarget;
  const updated = validTime(current.catalogUpdatedAt, now, 'BILLS_CATALOG_TIMESTAMP_INVALID');
  if (!/^[a-f0-9]{64}$/.test(current.catalogHash ?? '') || !Number.isInteger(current.year) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(current.effectiveDate ?? '')) throw new EngineError('BILLS_CATALOG_INVALID');
  validTime(`${current.effectiveDate}T00:00:00Z`, now, 'BILLS_FORECAST_DATE_INVALID');
  const prior = state.billsCatalog;
  if (prior) {
    const previous = validTime(prior.catalogUpdatedAt, now, 'LEDGER_BILLS_CATALOG_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prior.effectiveDate ?? '')) throw new EngineError('LEDGER_BILLS_CATALOG_INVALID');
    if (updated < previous || current.year < prior.year || current.effectiveDate < prior.effectiveDate) throw new EngineError('BILLS_CATALOG_ROLLBACK_BLOCKED');
    if (updated === previous && current.catalogHash !== prior.catalogHash) throw new EngineError('BILLS_CATALOG_VERSION_CONFLICT');
    // The same catalog can legitimately change at a later local date, for
    // example when an explicitly confirmed future cancellation takes effect.
    if (updated === previous && current.catalogHash === prior.catalogHash && current.year === prior.year &&
        current.effectiveDate === prior.effectiveDate &&
        current.targetCents !== prior.targetCents) throw new EngineError('BILLS_FORECAST_CHANGED_WITHOUT_CATALOG');
  }
  return { ...current };
}

function bindLiveConfiguration(state, config, now) {
  if (!config.activationAt) throw new EngineError('ACTIVATION_TIME_REQUIRED');
  if (Date.parse(config.activationAt) > now) throw new EngineError('ACTIVATION_NOT_STARTED');
  if (state.activationAt && state.activationAt !== config.activationAt) throw new EngineError('ACTIVATION_TIME_CHANGED');
  if (state.bindingHash && state.bindingHash !== binding(config)) throw new EngineError('ACCOUNT_OR_RULE_BINDING_CHANGED');
  const billsCatalog = checkBillsCatalog(state, config, now);
  const firstActivation = state.activationAt === null;
  state.activationAt = config.activationAt;
  state.bindingHash = binding(config);
  state.billsCatalog = billsCatalog;
  // Register prospective eligibility independently of the optional policy source.
  // A brief source outage on the first must not silently discard that month.
  if (config.roth?.enabled && !state.rothBinding) state.rothBinding = {
    incomeAccountId: config.accounts.income, destinationAccountId: config.roth.accountId, policyId: ROTH_ID,
    firstEligibleAt: firstActivation ? config.activationAt : iso(now),
  };
  const configuredIds = new Set(config.allocations.map((allocation) => allocation.id));
  for (const [id, prior] of Object.entries(state.allocations)) {
    if (!configuredIds.has(id)) prior.enabled = false;
  }
  for (const allocation of config.allocations) {
    const prior = state.allocations[allocation.id];
    if (prior && prior.destinationAccountId !== allocation.destinationAccountId) throw new EngineError('ALLOCATION_DESTINATION_CHANGED');
    if (prior && prior.enabled === false && allocation.enabled) {
      // Re-enabling is prospective, just like adding a new destination.
      prior.firstEligibleAt = iso(Math.max(now, allocation.startsAt ? Date.parse(allocation.startsAt) : now));
    }
    if (prior) prior.enabled = allocation.enabled;
    if (!prior) {
      const earliest = firstActivation ? Date.parse(config.activationAt) : now;
      state.allocations[allocation.id] = {
        destinationAccountId: allocation.destinationAccountId,
        firstEligibleAt: iso(Math.max(earliest, allocation.startsAt ? Date.parse(allocation.startsAt) : earliest)),
        enabled: allocation.enabled,
      };
    }
  }
}

function transferMatches(transfer, intent) {
  return transfer && typeof transfer.id === 'string' && transfer.executionMode === 'LIVE' &&
    transfer.source?.id === intent.request.sourceAccountId && transfer.destination?.id === intent.request.destinationAccountId &&
    transfer.source.isDeleted === false && transfer.destination.isDeleted === false &&
    transfer.amountInCents === intent.request.amountInCents && transfer.origin === 'USER' &&
    transfer.ruleId === null && transfer.ruleExecutionId === null;
}

function completeEventIfDone(event) {
  if (Object.values(event.children).every(finalChild)) event.status = 'COMPLETE';
}

function stopLowerPriorities(event, reason, now) {
  event.billsPriorityBlocked = { reason, at: iso(now) };
  for (const child of Object.values(event.children)) {
    if (child.allocationId !== 'bills' && child.status === 'WAITING') {
      child.status = 'SKIPPED'; child.reason = reason; child.completedAt = iso(now);
    }
  }
  completeEventIfDone(event);
}

function markReview(state, event, child, code, now) {
  child.status = 'REVIEW'; child.reason = code; child.updatedAt = iso(now);
  event.status = 'REVIEW'; event.reason = code;
  // Keep the exact request and provider identity. A reviewer must reconcile it;
  // changing a budget or deploying again cannot clear this state.
  state.active = null;
  return { status: 'review', code, allocationId: child.allocationId };
}

/** One global, CAS-protected writer serializes all allocations sharing Income. */
export async function reconcile({ config, client, store, now = () => Date.now(), uuid = randomUUID, forceObserve = false,
  rothPolicy = null, rothEvidence = null, rothPolicyError = null }) {
  const started = now();
  const deadline = started + RUN_MS;
  const owner = uuid();
  let record = await store.read();
  let state = validateState(clone(record?.value ?? initialState()));
  if (state.lease && Date.parse(state.lease.expiresAt) > started) return { status: 'busy', code: 'ANOTHER_RUN_OWNS_LEASE' };
  state.lease = { owner, expiresAt: iso(started + LEASE_MS) };
  try { record = await store.compareAndSwap(record?.etag ?? null, state); }
  catch (error) {
    if (error.code === 'STORE_CONFLICT' || error.name === 'StoreConflict') return { status: 'busy', code: 'ANOTHER_RUN_WON_CLAIM' };
    throw error;
  }
  let result;
  let rothObservation = null;
  let rothReserveCents = 0;
  let lostLease = false;
  const live = config.liveEnabled === true && config.mode === 'live' && !forceObserve;
  async function save() {
    if (lostLease || state.lease?.owner !== owner || Date.parse(state.lease.expiresAt) <= now() + 15_000 || now() >= deadline) {
      throw new EngineError('LEASE_OR_RUN_EXPIRED');
    }
    validateState(state);
    try { record = await store.compareAndSwap(record.etag, clone(state)); }
    catch (error) { lostLease = true; throw error; }
  }
  async function receiveTransfer(event, child, transfer) {
    if (!transferMatches(transfer, child) || (child.transferId && transfer.id !== child.transferId)) {
      return markReview(state, event, child, 'TOPUP_TRANSFER_IDENTITY_INVALID', now());
    }
    child.transferId = transfer.id;
    child.providerStatus = transfer.status;
    child.updatedAt = iso(now());
    if (transfer.status === 'COMPLETE') {
      const completed = validTime(transfer.completedAt, now(), 'TOPUP_COMPLETION_TIME_INVALID');
      if (completed < Date.parse(child.firstAttemptAt) || transfer.errorCode !== null) return markReview(state, event, child, 'TOPUP_SETTLEMENT_INCONSISTENT', now());
      child.status = 'COMPLETE'; child.completedAt = transfer.completedAt;
      state.lastSettledAt = iso(Math.max(completed, state.lastSettledAt ? Date.parse(state.lastSettledAt) : 0));
      state.active = null;
      completeEventIfDone(event);
      if (isRoth(event) && localMonth(completed).year !== event.taxYear) {
        event.taxYearReconciliationRequired = true;
        return { status: 'review', code: 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED', allocationId: child.allocationId,
          amountInCents: child.request.amountInCents };
      }
      return { status: 'complete', code: isRoth(event) ? 'ROTH_CONTRIBUTION_SETTLED' : 'TOPUP_SETTLED', allocationId: child.allocationId, amountInCents: child.request.amountInCents };
    }
    if (PENDING.has(transfer.status)) {
      child.status = 'PENDING';
      return { status: 'pending', code: transfer.status === 'APPROVAL_PENDING' ? 'PROVIDER_APPROVAL_REQUIRED' : isRoth(event) ? 'ROTH_CONTRIBUTION_PENDING' : 'TOPUP_PENDING', allocationId: child.allocationId,
        ...(isRoth(event) && localMonth(now()).year !== event.taxYear ? { taxYearReconciliationRequired: true } : {}) };
    }
    return markReview(state, event, child, 'TOPUP_DID_NOT_SETTLE', now());
  }
  async function submit(event, child, rothCashPlan = null) {
    if (!live) return { status: 'observe', code: 'SUBMISSION_DISABLED', allocationId: child.allocationId };
    const age = now() - Date.parse(child.firstAttemptAt);
    if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS) {
      return markReview(state, event, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED', now());
    }
    if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) return { status: 'waiting', code: 'RETRY_NOT_DUE' };
    if (child.requestHash !== hash(child.request)) throw new EngineError('LEDGER_REQUEST_CHANGED');
    // Flush the exact immutable intent before every attempt. If this fails, no POST.
    child.attempts = (child.attempts ?? 0) + 1;
    child.lastAttemptAt = iso(now());
    await save();
    // Awaited cash reads and persistence can straddle a month/year boundary.
    // The provider routes ACH to its current calendar year, so this check must
    // occur after the last await and immediately before every POST.
    if (isRoth(event) && localMonth(now()).monthKey !== event.monthKey) {
      if (localMonth(now()).year !== event.taxYear) event.taxYearReconciliationRequired = true;
      return markReview(state, event, child,
        localMonth(now()).year !== event.taxYear ? 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED' : 'ROTH_MONTH_RECONCILIATION_REQUIRED', now());
    }
    if (now() >= deadline || Date.parse(state.lease.expiresAt) <= now() + 15_000) throw new EngineError('LEASE_OR_RUN_EXPIRED');
    if (isRoth(event)) {
      const date = new Date(now()), currentCycle = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() >= 15 ? 15 : 1, 14);
      if (currentCycle > now() || rothCashPlan?.nativeCycleAt !== iso(currentCycle)) {
        return { status: 'waiting', code: 'ROTH_NATIVE_CYCLE_CHANGED', allocationId: ROTH_ID };
      }
    }
    try {
      const transfer = await client.createTransfer({
        idempotencyKey: child.idempotencyKey, request: clone(child.request), firstAttemptAt: child.firstAttemptAt,
      });
      return await receiveTransfer(event, child, transfer);
    } catch (error) {
      // Unknown errors after entering the provider call are uncertain, even if an
      // unexpected adapter exception omitted the uncertainty flag.
      if (error.uncertain !== false || error.status === 429) {
        child.status = 'SUBMITTING'; child.lastError = safeCode(error);
        const retryAfter = Number(error.retryAfter);
        const delay = Number.isFinite(retryAfter) ? Math.max(60, Math.min(retryAfter, RETRY_WINDOW_MS / 1000)) : 60;
        child.nextAttemptAt = iso(now() + delay * 1000);
        return { status: error.status === 429 ? 'waiting' : 'uncertain', code: error.status === 429 ? 'RATE_LIMIT_RETRY_PENDING' : 'SUBMISSION_OUTCOME_UNKNOWN', allocationId: child.allocationId };
      }
      return markReview(state, event, child, 'PROVIDER_REJECTED_TOPUP', now());
    }
  }

  async function retryRoth(event, child) {
    bindLiveConfiguration(state, config, now());
    await checkRules(client, config, { requireEnabled: true });
    if (localMonth(now()).monthKey !== event.monthKey) {
      if (localMonth(now()).year !== event.taxYear) event.taxYearReconciliationRequired = true;
      return markReview(state, event, child,
        localMonth(now()).year !== event.taxYear ? 'ROTH_TAX_YEAR_RECONCILIATION_REQUIRED' : 'ROTH_MONTH_RECONCILIATION_REQUIRED', now());
    }
    if (now() - Date.parse(child.firstAttemptAt) >= RETRY_WINDOW_MS) return markReview(state, event, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED', now());
    if (!config.roth?.enabled) return { status: 'observe', code: 'ROTH_UNCERTAIN_INTENT_PAUSED', allocationId: ROTH_ID };
    if (!rothPolicy || rothPolicyError) return { status: 'waiting', code: rothPolicyError ?? 'ROTH_POLICY_UNAVAILABLE', allocationId: ROTH_ID };
    if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) return { status: 'waiting', code: 'RETRY_NOT_DUE', allocationId: ROTH_ID };
    const forecast = rothForecast(state, config, rothPolicy, now(), event.key);
    if (!forecast.eligible || forecast.amountInCents < child.request.amountInCents) return markReview(state, event, child, 'ROTH_RETRY_NO_LONGER_WITHIN_LIMIT', now());
    if (child.request.destinationAccountId !== config.roth.accountId || child.request.sourceAccountId !== config.accounts.income) {
      return markReview(state, event, child, 'ROTH_BINDING_CHANGED', now());
    }
    const plan = await rothFundingPlan(client, config, rothEvidence, child.request.amountInCents, rothCashOptions(state, rothPolicy, forecast, now()));
    if (plan.amountInCents !== child.request.amountInCents) return { status: 'waiting', code: 'ROTH_RETRY_CASH_UNAVAILABLE', allocationId: ROTH_ID };
    bindRoth(state, config, forecast, now(), false);
    return submit(event, child, plan);
  }

  async function monthlyRoth(firstActivation) {
    const current = localMonth(now());
    // An unsubmitted old month expires. An immutable request is handled through
    // state.active/review and is never relabeled as a new month's contribution.
    if (live) {
      let expired = false;
      for (const event of Object.values(state.events)) {
        if (isRoth(event) && event.monthKey < current.monthKey && event.status === 'OPEN' &&
            event.children[ROTH_ID].status === 'WAITING' && !event.children[ROTH_ID].request) {
          Object.assign(event.children[ROTH_ID], { status: 'SKIPPED', reason: 'ROTH_MONTH_MISSED', completedAt: iso(now()) });
          completeEventIfDone(event); expired = true;
        }
      }
      if (expired) await save();
    }
    const prior = Object.values(state.events).find(event => isRoth(event) && event.monthKey === current.monthKey &&
      event.children[ROTH_ID].status === 'WAITING');
    if (config.roth?.enabled && Number.isSafeInteger(prior?.children[ROTH_ID].plannedAmountInCents)) {
      rothReserveCents = prior.children[ROTH_ID].plannedAmountInCents;
    }
    if (!config.roth?.enabled) return null;
    if (!rothPolicy || rothPolicyError) {
      rothObservation = { status: live ? 'waiting' : 'observe', code: rothPolicyError ?? 'ROTH_POLICY_UNAVAILABLE', allocationId: ROTH_ID };
      return null;
    }
    let forecast = rothForecast(state, config, rothPolicy, now());
    if (live) {
      bindRoth(state, config, forecast, now(), firstActivation);
      forecast = rothForecast(state, config, rothPolicy, now());
      await save();
    }
    if (!forecast.eligible) {
      rothObservation = { status: live ? 'waiting' : 'observe', code: forecast.reason, allocationId: ROTH_ID,
        blockers: forecast.blockers };
      return null;
    }
    const key = `roth:${forecast.policyId}:${forecast.monthKey}`;
    let event = state.events[key];
    if (event && finalChild(event.children[ROTH_ID])) {
      rothReserveCents = 0;
      rothObservation = { status: live ? 'complete' : 'observe', code: 'ROTH_MONTH_ALREADY_HANDLED', allocationId: ROTH_ID };
      return null;
    }
    if (event && !live) event = clone(event);
    if (!event) {
      event = { key, kind: 'roth-month', policyId: forecast.policyId, monthKey: forecast.monthKey, taxYear: forecast.year,
        dueAt: forecast.dueAt, startedAt: forecast.dueAt, status: 'OPEN',
        children: { [ROTH_ID]: { allocationId: ROTH_ID, destinationAccountId: config.roth.accountId, status: 'WAITING' } } };
      if (live) {
        if (Object.keys(state.events).length >= MAX_EVENTS) throw new EngineError('LEDGER_CAPACITY_REQUIRES_ARCHIVE');
        state.events[key] = event;
      }
    }
    const child = event.children[ROTH_ID];
    if (child.destinationAccountId !== config.roth.accountId) throw new EngineError('ROTH_BINDING_CHANGED');
    const requested = forecast.amountInCents;
    child.plannedAmountInCents = requested;
    rothReserveCents = requested;
    if (requested < 100) {
      if (live) {
        Object.assign(child, { status: 'NOOP', reason: requested === 0 ? forecast.reason : 'ROTH_BELOW_PROVIDER_MINIMUM', completedAt: iso(now()) });
        completeEventIfDone(event); await save();
      }
      rothReserveCents = 0;
      rothObservation = { status: live ? 'complete' : 'observe', code: requested === 0 ? forecast.reason : 'ROTH_BELOW_PROVIDER_MINIMUM', allocationId: ROTH_ID };
      return null;
    }
    if (live) await save();
    const cash = await rothFundingPlan(client, config, rothEvidence, requested, rothCashOptions(state, rothPolicy, forecast, now()));
    const plan = { ...cash, taxYear: forecast.year, monthKey: forecast.monthKey, monthlyAmountCents: forecast.monthlyAmountCents,
      annualRothLimitCents: forecast.annualRothLimitCents, annualCombinedLimitCents: forecast.annualCombinedLimitCents,
      remainingAnnualCents: forecast.remainingAnnualCents, policyHash: forecast.policyHash, policyUpdatedAt: forecast.policyUpdatedAt };
    if (!live) return { status: 'observe', code: 'READ_ONLY_ROTH_PLAN', allocationId: ROTH_ID, plan };
    if (cash.amountInCents === 0) {
      child.plan = plan; child.reason = cash.reason; await save();
      rothObservation = { status: 'waiting', code: cash.reason, allocationId: ROTH_ID, plan };
      return null;
    }
    if (cash.amountInCents !== requested) throw new EngineError('ROTH_PARTIAL_PLAN_REJECTED');
    if (localMonth(now()).monthKey !== event.monthKey) {
      rothObservation = { status: 'waiting', code: 'ROTH_MONTH_ROLLED_OVER', allocationId: ROTH_ID };
      return null;
    }
    const request = { sourceAccountId: config.accounts.income, destinationAccountId: config.roth.accountId,
      amountInCents: requested, description: 'ROTH IRA',
      reasonForApproval: `Finance coordinator: Roth contribution for ${forecast.monthKey}; current-year ACH route, annual room ${forecast.remainingAnnualCents} cents.` };
    Object.assign(child, { status: 'SUBMITTING', request, requestHash: hash(request), idempotencyKey: uuid(),
      firstAttemptAt: iso(now()), configHash: config.configHash, plan, attempts: 0 });
    state.active = { eventKey: key, allocationId: ROTH_ID };
    await save();
    const submitted = await submit(event, child, cash);
    await save();
    return submitted;
  }
  try {
    // Existing intents remain observable when paused. Mapping changes never redirect
    // an accepted or possibly accepted transfer.
    if (state.active) {
      const event = state.events[state.active.eventKey];
      const child = event.children[state.active.allocationId];
      if (child.transferId) {
        try { result = await receiveTransfer(event, child, await client.getTransfer(child.transferId)); }
        catch (error) {
          if (error instanceof EvidenceError) result = markReview(state, event, child, error.code, now());
          else result = { status: 'waiting', code: error.status === 404 ? 'ACCEPTED_TRANSFER_NOT_VISIBLE_YET' : safeCode(error) };
        }
      } else if (live && isRoth(event)) {
        result = await retryRoth(event, child);
      } else if (live) {
        bindLiveConfiguration(state, config, now());
        await checkRules(client, config, { requireEnabled: true });
        if (!event.children.bills) {
          result = markReview(state, event, child, 'BILLS_POLICY_MIGRATION_REQUIRED', now());
        } else if (now() - Date.parse(child.firstAttemptAt) >= RETRY_WINDOW_MS) {
          result = markReview(state, event, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED', now());
        } else if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) {
          result = { status: 'waiting', code: 'RETRY_NOT_DUE' };
        } else {
          // A lost response may mean the first POST never arrived. A retry must be
          // safe even if it creates the transfer for the first time right now.
          const allocation = config.allocations.find((item) => item.id === child.allocationId && item.enabled);
          if (!allocation || allocation.destinationAccountId !== child.request.destinationAccountId ||
              (allocation.startsAt && Date.parse(event.startedAt) < Date.parse(allocation.startsAt))) {
            result = markReview(state, event, child, 'RETRY_ALLOCATION_CHANGED', now());
          } else {
            const history = await discoverEvents(client, config, { now: now(), activationAt: state.activationAt });
            await verifyUpstreamFunding(client, config, { now: now(), activationAt: state.activationAt });
            const verified = await verifyRefund(client, config, event, { now: now(), activationAt: state.activationAt });
            const frozen = { ...allocation, targetCents: Math.min(allocation.targetCents, child.plan.targetCents) };
            const currentRoth = summarizeRothState({ config, state, rothPolicy, rothEvidence, rothPolicyError, now: now() });
            const plan = await fundingPlan(client, config, frozen, { ...verified, children: event.children }, history.transfers,
              { now: now(), lastSettledAt: state.lastSettledAt,
                additionalIncomeReserveCents: unpaidRothReserve(state, config, now(), currentRoth) });
            if (plan.amountInCents < child.request.amountInCents) result = markReview(state, event, child, 'RETRY_NO_LONGER_FITS_CURRENT_BALANCES', now());
            else result = await submit(event, child);
          }
        }
      } else result = { status: 'observe', code: 'UNCERTAIN_INTENT_PAUSED' };
      await save();
      return result;
    }
    if (Object.values(state.events).some((event) => event.status === 'REVIEW')) return result = { status: 'review', code: 'UNRESOLVED_EVENT_REQUIRES_REVIEW' };
    const firstActivation = state.activationAt === null;
    if (live) { bindLiveConfiguration(state, config, now()); await save(); }
    const rules = await checkRules(client, config, { requireEnabled: live });
    try {
      const monthly = await monthlyRoth(firstActivation);
      if (monthly) return result = monthly;
    } catch (error) {
      // Missing Roth eligibility/evidence must not suspend ordinary bill funding.
      // Its existing immutable request is handled above, never ignored here.
      if (lostLease || state.active || /^(?:LEDGER_|STORE_|LEASE_)/.test(safeCode(error))) throw error;
      rothObservation = { status: live ? 'waiting' : 'observe', code: safeCode(error), allocationId: ROTH_ID };
    }
    const cutoff = state.activationAt ?? config.activationAt;
    const history = await discoverEvents(client, config, { now: now(), activationAt: cutoff });
    const openEvents = Object.values(state.events).filter((event) => refundEvent(event) && event.status === 'OPEN');
    // Prefer the durable event even if a later listing momentarily omits its transfer.
    const candidates = [...openEvents, ...history.events.filter((event) => !state.events[event.key])];
    if (candidates.length === 0) return result = rothObservation ?? { status: live ? 'waiting' : 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
    await verifyUpstreamFunding(client, config, { now: now(), activationAt: cutoff });
    let candidate;
    let verified;
    for (const possible of candidates) {
      try {
        verified = await verifyRefund(client, config, possible, { now: now(), activationAt: cutoff });
        candidate = possible;
        break;
      } catch (error) {
        if (error instanceof EvidenceError && error.code === 'PAYOUT_PREDATES_ACTIVATION') continue;
        throw error;
      }
    }
    if (!candidate) return result = { status: live ? 'waiting' : 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
    let event = state.events[candidate.key];
    // Observation may walk through already-satisfied priorities to show the next
    // plan, but must never persist simulated completion of an existing event.
    if (event && !live) event = clone(event);
    if (!event) {
      let eligible = config.allocations.filter((allocation) => allocation.enabled &&
        Date.parse(verified.startedAt) >= Math.max(live ? Date.parse(state.allocations[allocation.id].firstEligibleAt) : -Infinity,
          allocation.startsAt ? Date.parse(allocation.startsAt) : -Infinity));
      // Bills is mandatory for this policy. Never retrofit an older event with
      // lower-priority recipients while its Bills allocation is not yet eligible.
      if (!eligible.some((allocation) => allocation.id === 'bills')) eligible = [];
      event = { ...verified, status: 'OPEN', children: Object.fromEntries(eligible.map((allocation) => [allocation.id,
        { allocationId: allocation.id, destinationAccountId: allocation.destinationAccountId, status: 'WAITING' }])) };
      if (live) {
        if (Object.keys(state.events).length >= MAX_EVENTS) throw new EngineError('LEDGER_CAPACITY_REQUIRES_ARCHIVE');
        state.events[event.key] = event;
        completeEventIfDone(event);
        await save();
      }
    } else {
      if (JSON.stringify(event.refundIds) !== JSON.stringify(verified.refundIds)) throw new EngineError('PAYOUT_REFUND_SET_CHANGED');
      event.completedAt = verified.completedAt;
    }
    if (!event.children.bills && Object.values(event.children).some((item) => !finalChild(item))) {
      throw new EngineError('BILLS_POLICY_MIGRATION_REQUIRED');
    }
    for (;;) {
      // Even an older object's property order cannot move Bills behind another recipient.
      const child = event.children.bills && !finalChild(event.children.bills) ? event.children.bills :
        Object.values(event.children).find((item) => !finalChild(item));
      if (!child) return result = { status: live ? 'complete' : 'observe', code: 'EVENT_HAS_NO_ELIGIBLE_ALLOCATIONS' };
      const allocation = config.allocations.find((item) => item.id === child.allocationId);
      const firstEligibleAt = Math.max(
        state.allocations[child.allocationId]?.firstEligibleAt ? Date.parse(state.allocations[child.allocationId].firstEligibleAt) : -Infinity,
        allocation?.startsAt ? Date.parse(allocation.startsAt) : -Infinity,
      );
      if (!allocation || !allocation.enabled || Date.parse(event.startedAt) < firstEligibleAt) {
        if (live) {
          child.status = 'SKIPPED'; child.reason = 'ALLOCATION_DISABLED_OR_NOT_STARTED';
          if (child.allocationId === 'bills') stopLowerPriorities(event, 'BILLS_PRIORITY_UNMET', now());
          completeEventIfDone(event); await save();
        }
        return result = { status: live ? 'complete' : 'observe', code: 'ALLOCATION_DISABLED_OR_NOT_STARTED', allocationId: child.allocationId };
      }
      if (allocation.destinationAccountId !== child.destinationAccountId) throw new EngineError('ALLOCATION_DESTINATION_CHANGED');
      const plan = await fundingPlan(client, config, allocation, { ...verified, children: event.children }, history.transfers,
        { now: now(), lastSettledAt: state.lastSettledAt, additionalIncomeReserveCents: rothReserveCents });
      if (allocation.id !== 'bills' && (event.billsPriorityBlocked || plan.reason === 'BILLS_PRIORITY_UNMET')) {
        if (live) { stopLowerPriorities(event, 'BILLS_PRIORITY_UNMET', now()); await save(); }
        return result = { status: live ? 'complete' : 'observe', code: 'BILLS_PRIORITY_UNMET', plan };
      }
      if (allocation.id === 'bills' && plan.amountInCents === 0 && plan.gapCents === 0) {
        child.status = 'NOOP'; child.reason = plan.reason; child.plan = plan; child.completedAt = iso(now());
        completeEventIfDone(event);
        if (live) await save();
        // An already-filled Bills account needs no transfer and no extra wakeup.
        continue;
      }
      if (!live) return result = { status: 'observe', code: 'READ_ONLY_PLAN', rules, plan };
      if (plan.amountInCents === 0) {
        child.status = 'NOOP'; child.reason = plan.reason; child.plan = plan; child.completedAt = iso(now());
        if (allocation.id === 'bills' && plan.gapCents > 0) stopLowerPriorities(event, 'BILLS_PRIORITY_UNMET', now());
        completeEventIfDone(event); await save();
        return result = { status: 'complete', code: allocation.id === 'bills' && plan.gapCents > 0 ? 'BILLS_PRIORITY_UNMET' : plan.reason, plan };
      }
      const request = {
        sourceAccountId: config.accounts.income, destinationAccountId: allocation.destinationAccountId,
        amountInCents: plan.amountInCents, description: 'TOPUP',
        reasonForApproval: `Finance coordinator: ${allocation.id}; verified refund ${event.executionId}; target ${allocation.targetCents} cents.`,
      };
      Object.assign(child, {
        status: 'SUBMITTING', request, requestHash: hash(request), idempotencyKey: uuid(),
        firstAttemptAt: iso(now()), configHash: config.configHash, plan, attempts: 0,
      });
      if (allocation.id === 'bills' && plan.amountInCents < plan.gapCents) stopLowerPriorities(event, 'BILLS_PRIORITY_UNMET', now());
      state.active = { eventKey: event.key, allocationId: child.allocationId };
      await save();
      result = await submit(event, child);
      await save();
      return result;
    }
  } catch (error) {
    result = { status: error instanceof EvidenceError && !error.review ? 'waiting' : 'blocked', code: safeCode(error) };
    return result;
  } finally {
    if (rothObservation && result && result !== rothObservation) result.roth = rothObservation;
    // Never overwrite another worker after a CAS conflict. A crash leaves the lease
    // and immutable intent for recovery after the old function has necessarily ended.
    if (!lostLease && now() < deadline && state.lease?.owner === owner) {
      state.lastRun = { at: iso(now()), mode: live ? 'live' : 'observe', result: result ?? { status: 'blocked', code: 'RUN_INTERRUPTED' } };
      state.lease = null;
      try { await store.compareAndSwap(record.etag, clone(state)); } catch { /* The durable prior state remains authoritative. */ }
    }
  }
}

export function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
}

/** A plan never claims an event, records completion, or calls a mutation method. */
export async function preview({ config, client, store, now = () => Date.now(), rothPolicy = null, rothEvidence = null, rothPolicyError = null }) {
  const state = validateState((await store.read())?.value ?? initialState());
  if (state.active) return { status: 'waiting', code: 'EXISTING_INTENT_UNRESOLVED' };
  if (Object.values(state.events).some((event) => event.status === 'REVIEW')) return { status: 'review', code: 'UNRESOLVED_EVENT_REQUIRES_REVIEW' };
  checkBillsCatalog(state, config, now());
  const rules = await checkRules(client, config);
  let rothObservation = null, rothReserveCents = unpaidRothReserve(state, config, now());
  const finish = result => rothObservation ? { ...result, roth: rothObservation } : result;
  if (config.roth?.enabled) {
    try {
      if (!rothPolicy || rothPolicyError) throw new EngineError(rothPolicyError ?? 'ROTH_POLICY_UNAVAILABLE');
      const forecast = rothForecast(state, config, rothPolicy, now());
      const current = state.events[`roth:${forecast.policyId}:${forecast.monthKey}`];
      rothReserveCents = unpaidRothReserve(state, config, now(), forecast);
      if (!forecast.eligible) rothObservation = { status: 'observe', code: forecast.reason, blockers: forecast.blockers, allocationId: ROTH_ID };
      else if (current && finalChild(current.children[ROTH_ID])) rothObservation = { status: 'observe', code: 'ROTH_MONTH_ALREADY_HANDLED', allocationId: ROTH_ID };
      else if (forecast.amountInCents < 100) rothObservation = { status: 'observe', code: forecast.amountInCents === 0 ? forecast.reason : 'ROTH_BELOW_PROVIDER_MINIMUM', allocationId: ROTH_ID };
      else {
        const cash = await rothFundingPlan(client, config, rothEvidence, forecast.amountInCents, rothCashOptions(state, rothPolicy, forecast, now()));
        return { status: 'observe', code: 'READ_ONLY_ROTH_PLAN', allocationId: ROTH_ID, rules,
          plan: { ...cash, taxYear: forecast.year, monthKey: forecast.monthKey, monthlyAmountCents: forecast.monthlyAmountCents,
            annualRothLimitCents: forecast.annualRothLimitCents, annualCombinedLimitCents: forecast.annualCombinedLimitCents,
            remainingAnnualCents: forecast.remainingAnnualCents, policyHash: forecast.policyHash, policyUpdatedAt: forecast.policyUpdatedAt } };
      }
    } catch (error) { rothObservation = { status: 'observe', code: safeCode(error), allocationId: ROTH_ID }; }
  }
  const history = await discoverEvents(client, config, { now: now(), activationAt: state.activationAt ?? config.activationAt });
  const candidates = [...Object.values(state.events).filter((event) => refundEvent(event) && event.status === 'OPEN'), ...history.events.filter((event) => !state.events[event.key])];
  let candidate, event;
  for (const possible of candidates) {
    try {
      event = await verifyRefund(client, config, possible, { now: now(), activationAt: state.activationAt ?? config.activationAt });
      candidate = possible;
      break;
    } catch (error) {
      if (error instanceof EvidenceError && error.code === 'PAYOUT_PREDATES_ACTIVATION') continue;
      throw error;
    }
  }
  if (!candidate) return rothObservation ?? { status: 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
  await verifyUpstreamFunding(client, config, { now: now(), activationAt: state.activationAt ?? config.activationAt });
  if (candidate.children && !candidate.children.bills) throw new EngineError('BILLS_POLICY_MIGRATION_REQUIRED');
  if (candidate.billsPriorityBlocked) return finish({ status: 'observe', code: 'BILLS_PRIORITY_UNMET' });
  const allocations = config.allocations.filter((item) => item.enabled &&
    (!candidate.children || candidate.children[item.id]?.status === 'WAITING') &&
    (!state.allocations[item.id]?.firstEligibleAt || Date.parse(state.allocations[item.id].firstEligibleAt) <= Date.parse(event.startedAt)) &&
    (!item.startsAt || Date.parse(item.startsAt) <= Date.parse(event.startedAt)));
  if (!candidate.children && !allocations.some((item) => item.id === 'bills')) return finish({ status: 'observe', code: 'EVENT_HAS_NO_ELIGIBLE_ALLOCATIONS' });
  for (const allocation of allocations) {
    const plan = await fundingPlan(client, config, allocation, event, history.transfers,
      { now: now(), lastSettledAt: state.lastSettledAt, additionalIncomeReserveCents: rothReserveCents });
    if (allocation.id === 'bills' && plan.amountInCents === 0 && plan.gapCents === 0) continue;
    if (allocation.id !== 'bills' && plan.reason === 'BILLS_PRIORITY_UNMET') return finish({ status: 'observe', code: 'BILLS_PRIORITY_UNMET', plan });
    return finish({ status: 'observe', code: 'READ_ONLY_PLAN', rules, plan });
  }
  return finish({ status: 'observe', code: 'EVENT_HAS_NO_ELIGIBLE_ALLOCATIONS' });
}
