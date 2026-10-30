/** Preparation checks only. This module never reads a provider, writes a ledger,
 * changes an activation switch, sends mail, or authorizes a transfer. */
import { createHash } from 'node:crypto';
import { initialState, safeCode } from './engine.mjs';
import { validateMonthlyState, monthlyOwnedTransfers, summarizeMonthlyRoth } from './monthly-engine.mjs';
import { reconcileIncome } from './income-ledger.mjs';
import { checkMonthlyRothEvidence } from './monthly-evidence.mjs';
import { forecastBills } from './bills.mjs';
import { MAX_MONITOR_AGE_MS } from './bills-source.mjs';
import { validTime } from './evidence.mjs';

const iso = value => new Date(value).toISOString();
const cents = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const unique = values => [...new Set(values)];
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function localMonth(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function nextCycle(config, state, now) {
  const bound = state?.monthly?.activationAt;
  const configured = config.activationAt ? Date.parse(config.activationAt) : null;
  const liveCutoff = config.mode === 'live' && config.liveEnabled === true ? config.activationAt : null;
  // Once the live gates are on, the executor uses the configured cutoff even
  // before its first ledger binding. Preparation may instead choose a new one.
  const effectiveCutoff = bound ?? liveCutoff;
  const cutoff = effectiveCutoff ? Date.parse(effectiveCutoff) : Math.max(now, configured ?? now);
  if (!Number.isFinite(cutoff)) fail('MONTHLY_ACTIVATION_INVALID');
  const local = localMonth(now);
  let due = Date.UTC(local.year, local.month - 1, 1, 15);
  // A previously activated, still-open first-day slot can resume that day.
  const currentKey = `${local.year}-${String(local.month).padStart(2, '0')}`;
  const currentAvailable = Boolean(effectiveCutoff && local.day === 1 && due >= cutoff &&
    state.monthly?.cycles[currentKey]?.status !== 'COMPLETE');
  while (due < cutoff || due < now && !currentAvailable) {
    const date = new Date(due);
    due = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 15);
  }
  const date = new Date(due), year = date.getUTCFullYear();
  return { year, monthKey: `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    dueAt: iso(due), timeZone: 'America/New_York', prospectiveCutoff: effectiveCutoff ?? iso(cutoff) };
}

function configurationHash(config) {
  // This is the permanent monthly binding, not the changeable spending budget.
  return hash({ income: config.accounts.income, bills: config.accounts.bills, general: config.accounts.general,
    emergency: config.accounts.emergency, roth: config.roth.accountId, project: config.monthly.projectAccountId,
    personal: config.monthly.personalAccountId, rules: config.rules, zone: config.monthly.timeZone,
    due: config.monthly.dueHourUTC, close: config.monthly.annualCloseMonth });
}

/** Inputs are the current private policies and an actual readMonthlyEvidence
 * receipt. Every result is an aggregate or safe code; private proofs never leak.
 * A prepared observe deployment can be ready while executionEnabled stays false.
 * The separate build rehearsal is necessary and deliberately not inferred here. */
export function buildActivationReadiness({ config, state: inputState, evidence, evidenceError = null,
  billsPolicy, monthlyPolicy, monthlyPolicyError = null, rothPolicy, rothEvidence, rothPolicyError = null,
  alertDelivery, readinessEvidence, readinessEvidenceError = null, now = Date.now() }) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) fail('ACTIVATION_READINESS_TIME_INVALID');
  const state = structuredClone(inputState ?? initialState()), checks = [];
  let ledgerValid = false, readValid = false, pools = null, cycle = null, roth = null;
  const check = (id, fn) => {
    try {
      const result = fn() ?? {}, codes = unique(result.codes ?? []);
      checks.push({ id, status: codes.length ? 'blocked' : 'passed', ...result, codes });
    } catch (error) { checks.push({ id, status: 'blocked', codes: [safeCode(error)] }); }
  };

  check('configuration', () => {
    if (!config.monthly?.enabled || config.monthly.timeZone !== 'America/New_York' || config.monthly.dueHourUTC !== 15 ||
        config.monthly.annualCloseMonth !== 12 || config.monthly.emergencyRateBasisPoints !== 750 ||
        config.monthly.projectRateBasisPoints !== 500) fail('MONTHLY_CONFIGURATION_INVALID');
    if (state.monthly?.activationAt && state.monthly.activationAt !== config.activationAt) fail('MONTHLY_ACTIVATION_CHANGED');
    if (state.monthly?.bindingHash && state.monthly.bindingHash !== configurationHash(config)) fail('MONTHLY_BINDING_CHANGED');
    cycle = nextCycle(config, state, now);
  });
  check('ledger', () => {
    validateMonthlyState(state); ledgerValid = true;
    const codes = [];
    if (state.active || Object.keys(state.events).length) codes.push('MONTHLY_LEGACY_HISTORY_REQUIRES_REVIEW');
    if (state.lease && Date.parse(state.lease.expiresAt) > now) codes.push('MONTHLY_WORKER_ACTIVE');
    const monthly = state.monthly;
    if (monthly) {
      if (Object.values(monthly.cycles).some(row => row.status !== 'COMPLETE')) codes.push('MONTHLY_CYCLE_INCOMPLETE');
      const owned = monthlyOwnedTransfers(state);
      if (owned.some(row => row.status !== 'COMPLETE')) codes.push('MONTHLY_TRANSFER_UNRESOLVED');
      if (Object.values(monthly.cycles).some(row => row.status === 'REVIEW')) codes.push('MONTHLY_REVIEW_REQUIRED');
      if (Object.keys(monthly.taxYearReview).length) codes.push('ROTH_TAX_YEAR_RECONCILIATION_REQUIRED');
      if (Object.values(monthly.alerts).some(row => row.status !== 'DELIVERED')) codes.push('MONTHLY_ALERT_UNRESOLVED');
    }
    return { codes };
  });
  check('account_and_cash_reads', () => {
    if (evidenceError) fail(evidenceError);
    if (!evidence?.accountSnapshots || !Array.isArray(evidence.transfers)) fail('MONTHLY_EVIDENCE_REQUIRED');
    validTime(evidence.observedAt, now, 'MONTHLY_EVIDENCE_TIME_INVALID');
    const roles = { income: config.accounts.income, bills: config.accounts.bills, general: config.accounts.general,
      emergency: config.accounts.emergency, project: config.monthly.projectAccountId,
      personalInvestment: config.monthly.personalAccountId, roth: config.roth.accountId };
    for (const [role, id] of Object.entries(roles)) {
      const account = evidence.accountSnapshots[role];
      if (!sameId(account?.accountId, id)) fail('MONTHLY_ACCOUNT_IDENTITY_INVALID');
      if (['personalInvestment', 'roth'].includes(role)) continue;
      const at = validTime(account.observedAt, now, 'BALANCE_TIMESTAMP_UNAVAILABLE');
      if (now - at > config.maxBalanceAgeMs) fail('BALANCE_TOO_OLD');
    }
    readValid = true;
  });
  check('legacy_rules_disabled', () => {
    if (!evidence?.nativeRuleStatuses || Object.keys(config.rules).some(name => evidence.nativeRuleStatuses[name] !== 'DISABLED')) {
      fail('MONTHLY_LEGACY_RULES_UNVERIFIED');
    }
  });
  check('bills_policy', () => {
    if (!billsPolicy?.catalog || !billsPolicy.monitor || !billsPolicy.forecast) fail('BILLS_POLICY_UNAVAILABLE');
    const checked = validTime(billsPolicy.monitor.checkedAt, now, 'BILLS_MONITOR_TIME_INVALID');
    if (now - checked > MAX_MONITOR_AGE_MS) fail('BILLS_MONITOR_STALE');
    const forecast = forecastBills(billsPolicy.catalog, { now }), configured = config.calculatedBillsTarget;
    const fields = ['targetCents', 'catalogHash', 'catalogUpdatedAt', 'year', 'effectiveDate'];
    if (fields.some(field => configured?.[field] !== forecast[field] || billsPolicy.forecast[field] !== forecast[field])) fail('BILLS_FORECAST_CONFIGURATION_MISMATCH');
    const prior = state.monthly?.billsCatalog ?? state.billsCatalog;
    if (prior) {
      if (forecast.catalogUpdatedAt < prior.catalogUpdatedAt || forecast.year < prior.year || forecast.effectiveDate < prior.effectiveDate) fail('BILLS_CATALOG_ROLLBACK_BLOCKED');
      if (forecast.catalogUpdatedAt === prior.catalogUpdatedAt && forecast.catalogHash !== prior.catalogHash) fail('BILLS_CATALOG_VERSION_CONFLICT');
      if (fields.slice(1).every(field => forecast[field] === prior[field]) && forecast.targetCents !== prior.targetCents) fail('BILLS_FORECAST_CHANGED_WITHOUT_CATALOG');
    }
    return { targetCents: forecast.targetCents, reviewCodeCount: billsPolicy.monitor.reviewCodes?.length ?? 0 };
  });
  check('income_reconciliation', () => {
    if (monthlyPolicyError) fail(monthlyPolicyError);
    if (!monthlyPolicy) fail('MONTHLY_POLICY_UNAVAILABLE');
    if (monthlyPolicy.opening?.status !== 'verified') fail('INCOME_OPENING_UNVERIFIED');
    if (!ledgerValid || !readValid) fail('INCOME_RECONCILIATION_UNVERIFIED');
    pools = reconcileIncome({ policy: monthlyPolicy, ledger: state.monthly?.income ?? null,
      evidence, ownedTransfers: monthlyOwnedTransfers(state) });
    return { reconciled: true, codes: pools.alerts.map(row => row.code),
      regularAvailableCents: pools.availableRegularCents, windfallHeldCents: pools.windfallHeldCents,
      priorYearWindfallHeldCents: pools.priorYearWindfallHeldCents, unknownHeldCents: pools.unknownHeldCents };
  });
  check('next_cycle_roth_policy', () => {
    if (!cycle || !ledgerValid) fail('ROTH_ACTIVATION_READINESS_UNVERIFIED');
    if (rothPolicyError) fail(rothPolicyError);
    if (!rothPolicy) fail('ROTH_POLICY_UNAVAILABLE');
    validTime(rothPolicy.updatedAt, now, 'ROTH_POLICY_FROM_FUTURE');
    const candidateConfig = { ...config, activationAt: cycle.prospectiveCutoff };
    roth = summarizeMonthlyRoth({ config: candidateConfig, state, rothPolicy, rothPolicyError, rothEvidence,
      now: Date.parse(cycle.dueAt) });
    return { year: cycle.year, monthlyAmountCents: roth.monthlyAmountCents,
      annualLimitCents: roth.annualLimitCents ?? null, remainingAnnualCents: roth.remainingAnnualCents,
      codes: roth.blockers };
  });
  check('roth_route_and_contributions', () => {
    if (!readValid || !ledgerValid || !cycle) fail('ROTH_ROUTE_READINESS_UNVERIFIED');
    const outside = rothPolicy?.years?.find(row => row.year === cycle.year)?.outsideContributions;
    checkMonthlyRothEvidence(evidence, config, { now, rothEvidence,
      outsideContributionsVerifiedAt: outside?.status === 'verified' ? outside.verifiedAt : null,
      knownTransfers: monthlyOwnedTransfers(state).filter(row => row.transferId) });
  });
  check('activation_evidence', () => {
    if (readinessEvidenceError) fail(readinessEvidenceError);
    if (!readinessEvidence || readinessEvidence.schemaVersion !== 1) fail('ACTIVATION_EVIDENCE_UNVERIFIED');
    validTime(readinessEvidence.updatedAt, now, 'ACTIVATION_EVIDENCE_TIME_INVALID');
  });
  check('sequence_authority', () => {
    const proof = readinessEvidence?.sequenceAuthority;
    if (proof?.status !== 'verified') fail('SEQUENCE_AUTHORITY_UNVERIFIED');
    validTime(proof.verifiedAt, now, 'SEQUENCE_AUTHORITY_TIME_INVALID');
    if (proof.automaticApproval !== true) fail('SEQUENCE_UNATTENDED_APPROVAL_UNVERIFIED');
    const required = [config.accounts.bills, config.accounts.general, config.accounts.emergency,
      config.roth.accountId, config.monthly.projectAccountId, config.monthly.personalAccountId]
      .map(destinationAccountId => [config.accounts.income, destinationAccountId]);
    required.push([config.accounts.emergency, config.accounts.income]);
    if (!Array.isArray(proof.accountPairs) || required.some(([source, destination]) =>
      !proof.accountPairs.some(pair => sameId(pair.sourceAccountId, source) && sameId(pair.destinationAccountId, destination)))) {
      fail('SEQUENCE_TRANSFER_PAIR_UNVERIFIED');
    }
    if (proof.maxAmountCents !== null && (!cents(proof.maxAmountCents) || proof.maxAmountCents < 100)) fail('SEQUENCE_TRANSFER_LIMIT_UNVERIFIED');
    if (!readValid) fail('SEQUENCE_TRANSFER_LIMIT_CHECK_UNAVAILABLE');
    const emergency = evidence.accountSnapshots.emergency;
    const incomeBound = Math.max(0, evidence.sourceSpendableCents - config.incomeReserveCents);
    const returnBound = Math.max(0, Math.min(emergency.balanceCents - config.monthly.emergencyTargetCents, emergency.spendableCents));
    const upperBound = Math.max(incomeBound, returnBound);
    return { approvedPairCount: required.length, maxAmountCents: proof.maxAmountCents,
      currentSingleRequestUpperBoundCents: upperBound, limitAssessment: 'conservative_upper_bound_not_a_transfer_plan',
      codes: proof.maxAmountCents !== null && upperBound > proof.maxAmountCents ? ['SEQUENCE_TRANSFER_LIMIT_REVIEW_REQUIRED'] : [] };
  });
  check('email_delivery', () => {
    if (alertDelivery?.configured !== true) fail('MONTHLY_ALERT_DELIVERY_REQUIRED');
    const proof = readinessEvidence?.emailDelivery;
    if (proof?.status !== 'verified' || proof.provider !== 'resend' || proof.providerAccepted !== true || proof.recipientConfirmed !== true) fail('EMAIL_DELIVERY_UNVERIFIED');
    validTime(proof.verifiedAt, now, 'EMAIL_DELIVERY_TIME_INVALID');
    if (typeof alertDelivery.recipient !== 'string' || typeof proof.recipient !== 'string' ||
      alertDelivery.recipient.toLowerCase() !== proof.recipient.toLowerCase()) fail('EMAIL_DELIVERY_RECIPIENT_MISMATCH');
    if (typeof alertDelivery.sender !== 'string' || typeof proof.sender !== 'string' ||
      alertDelivery.sender.toLowerCase() !== proof.sender.toLowerCase()) fail('EMAIL_DELIVERY_SENDER_MISMATCH');
    return { providerAccepted: true, recipientConfirmed: true };
  });

  const blockers = unique(checks.flatMap(row => row.codes));
  const executionEnabled = config.mode === 'live' && config.liveEnabled === true;
  const activationEstablished = ledgerValid && checks.find(row => row.id === 'configuration')?.status === 'passed' &&
    Boolean(state.monthly?.activationAt && state.monthly?.bindingHash);
  const readyForActivation = blockers.length === 0;
  const activationChanges = [
    ...(config.mode !== 'live' ? [{ setting: 'APP_MODE', requiredValue: 'live' }] : []),
    ...(config.liveEnabled !== true ? [{ setting: 'LIVE_TRANSFERS_ENABLED', requiredValue: 'true' }] : []),
    ...(!state.monthly?.activationAt ? [{ setting: 'AUTOMATION_START_AT', requirement: 'Choose a prospective cutoff after authorization, at or before the intended monthly slot.' }] : []),
  ];
  return { schemaVersion: 1, status: readyForActivation ? executionEnabled ? 'active' : 'ready_for_user_activation' : 'blocked',
    readyForActivation, executionEnabled, activationEstablished, checkedAt: iso(now), readChecks: readValid ? 'passed' : 'blocked',
    nextCycle: cycle && { year: cycle.year, monthKey: cycle.monthKey, dueAt: cycle.dueAt, timeZone: cycle.timeZone },
    checks, blockers, activationChanges, recheckAtActivation: true,
    limitations: { realTransferTested: false, providerAcceptanceNotSettlement: true,
      futureBalancesNotGuaranteed: true, offlineRehearsal: 'reported_separately', storageWritesTested: false } };
}

/** Initial financial activation is a deployment gate. Once the permanent
 * monthly binding exists, ordinary in-flight ACH work must not prevent a code
 * repair deployment; the executor continues to enforce all per-request guards. */
export function assertActivationReadyForDeployment(config, readiness) {
  if (!config.monthly?.enabled || config.mode !== 'live' || config.liveEnabled !== true) return;
  if (readiness?.schemaVersion !== 1 ||
      readiness.activationEstablished !== true && readiness.readyForActivation !== true) {
    fail('ACTIVATION_PREREQUISITES_INCOMPLETE');
  }
}
