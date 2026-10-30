import { createHash } from 'node:crypto';
import { EvidenceError, PENDING, cashBalance, calculatedBillsTarget, validTime, validateAccount } from './evidence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = new Set(['FAILED', 'PARTIAL', 'APPROVAL_DENIED']);
const TRANSFER_FAILED = new Set(['INCOMPLETE', 'ERROR', 'CANCELLED', 'APPROVAL_DENIED']);
const EXECUTION_PENDING = new Set(['IN_PROGRESS', 'APPROVAL_PENDING']);
const TRIGGERS = new Set(['SCHEDULED', 'MANUAL', 'SEQUENCE_API', 'REMOTE_API', 'ON_FUNDS_TRANSFERRED']);
const fail = (code, review = false) => { throw new EvidenceError(code, { review }); };
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const cents = value => Number.isSafeInteger(value) && value >= 0;
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && UUID.test(left) && left.toLowerCase() === right.toLowerCase();
const canonical = value => Array.isArray(value) ? value.map(canonical) : isRecord(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function shape(value, required, optional = []) {
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('ROTH_EVIDENCE_INVALID', true);
}

function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail('ROTH_EVIDENCE_TIME_INVALID', true);
  }
  return new Date(Date.parse(value)).toISOString();
}

function reference(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) fail('ROTH_EVIDENCE_INVALID', true);
  return value.trim();
}

/** Private attestations remain separate from the statutory dollar policy. */
export function parseRothEvidence(input) {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 20_000) fail('ROTH_EVIDENCE_INVALID', true);
    try { value = JSON.parse(value); } catch { fail('ROTH_EVIDENCE_INVALID', true); }
  }
  shape(value, ['schemaVersion', 'updatedAt', 'route', 'upstream']);
  if (value.schemaVersion !== 1) fail('ROTH_EVIDENCE_INVALID', true);
  const updatedAt = iso(value.updatedAt);
  let route, upstream;
  if (value.route?.status === 'unverified') { shape(value.route, ['status']); route = { status: 'unverified' }; }
  else {
    shape(value.route, ['status', 'sourceAccountId', 'destinationAccountId', 'custodian', 'contributionYear', 'verifiedAt', 'reference']);
    if (value.route.status !== 'verified' || !UUID.test(value.route.sourceAccountId) || !UUID.test(value.route.destinationAccountId) ||
        sameId(value.route.sourceAccountId, value.route.destinationAccountId) || value.route.custodian !== 'fidelity' ||
        value.route.contributionYear !== 'current_calendar_year') fail('ROTH_ROUTE_INVALID', true);
    route = { ...value.route, sourceAccountId: value.route.sourceAccountId.toLowerCase(), destinationAccountId: value.route.destinationAccountId.toLowerCase(),
      verifiedAt: iso(value.route.verifiedAt), reference: reference(value.route.reference) };
  }
  if (value.upstream?.status === 'unverified') { shape(value.upstream, ['status']); upstream = { status: 'unverified' }; }
  else {
    shape(value.upstream, ['status', 'ruleId', 'definitionHash', 'verifiedAt', 'reference']);
    if (value.upstream.status !== 'verified' || !UUID.test(value.upstream.ruleId) ||
        typeof value.upstream.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.upstream.definitionHash)) fail('ROTH_NATIVE_PROOF_INVALID', true);
    upstream = { ...value.upstream, ruleId: value.upstream.ruleId.toLowerCase(), verifiedAt: iso(value.upstream.verifiedAt), reference: reference(value.upstream.reference) };
  }
  if ([route, upstream].some(proof => proof.status === 'verified' && Date.parse(proof.verifiedAt) > Date.parse(updatedAt))) fail('ROTH_EVIDENCE_TIME_INVALID', true);
  return { schemaVersion: 1, updatedAt, route, upstream };
}

/** An explicitly attested retirement destination is not a spendable cash account. */
export function validateRothDestination(account, expectedId) {
  if (!account || !sameId(account.id, expectedId) || account.deletedAt !== null) fail('ROTH_DESTINATION_IDENTITY_INVALID', true);
  if (account.type !== 'EXTERNAL_ACCOUNT' || account.externalAccountType !== 'INVESTMENT') fail('ROTH_DESTINATION_NOT_INVESTMENT', true);
  if (account.canBeDestination !== true) fail('ROTH_DESTINATION_CANNOT_RECEIVE', true);
  if (account.institutionName !== 'Fidelity') fail('ROTH_CUSTODIAN_MISMATCH', true);
  // Neither market value nor available brokerage buying power proves IRA room.
  return account;
}

function accountRef(value) {
  if (!isRecord(value) || Object.keys(value).some(key => !['id', 'type', 'name'].includes(key)) || !UUID.test(value.id ?? '') ||
      !['POD', 'INCOME_SOURCE', 'EXTERNAL_ACCOUNT'].includes(value.type)) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
  return { id: value.id.toLowerCase(), type: value.type };
}

function definition(rule) {
  const trigger = rule?.trigger;
  if (!isRecord(trigger) || Object.keys(trigger).some(key => !['type', 'scheduleType', 'startDate', 'accountId'].includes(key)) ||
      trigger.type !== 'SCHEDULED' || trigger.scheduleType !== 'BI_WEEKLY' || !UUID.test(trigger.accountId ?? '') ||
      !Array.isArray(rule.steps) || rule.steps.length < 1 || rule.steps.length > 10) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
  const startDate = iso(trigger.startDate), date = new Date(startDate);
  if (![1, 15].includes(date.getUTCDate()) || date.getUTCHours() !== 14 || date.getUTCMinutes() !== 0 ||
      date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) fail('ROTH_NATIVE_SCHEDULE_UNSUPPORTED', true);
  const steps = rule.steps.map(step => {
    if (!isRecord(step) || Object.keys(step).some(key => !['conditions', 'actions'].includes(key)) ||
        !Array.isArray(step.actions) || step.actions.length < 1 || step.actions.length > 10) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
    const destinations = new Set();
    const actions = step.actions.map(action => {
      if (!isRecord(action) || Object.keys(action).some(key => !['type', 'source', 'destination', 'groupIndex', 'upToEnabled', 'limit',
        'achDescription', 'isDirectDeposit', 'percentageValue', 'percentageTarget'].includes(key)) ||
          action.type !== 'PERCENTAGE' || action.percentageTarget !== 'SOURCE_ACCOUNT' ||
          !Number.isFinite(action.percentageValue) || action.percentageValue <= 0 || action.percentageValue > 100 ||
          action.upToEnabled !== false || action.limit !== null || action.isDirectDeposit !== false ||
          !Number.isSafeInteger(action.groupIndex) || action.groupIndex < 0) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
      const source = accountRef(action.source), destination = accountRef(action.destination);
      if (!sameId(source.id, trigger.accountId) || source.type !== 'EXTERNAL_ACCOUNT' || sameId(source.id, destination.id) ||
          destinations.has(destination.id)) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
      destinations.add(destination.id);
      return { ...action, source, destination };
    });
    if (actions.reduce((total, action) => total + action.percentageValue, 0) > 100) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
    return { ...(Object.hasOwn(step, 'conditions') ? { conditions: step.conditions } : {}), actions };
  });
  return { trigger: { ...trigger, accountId: trigger.accountId.toLowerCase(), startDate }, steps };
}

/** Pin financial trigger/steps, while allowing provider labels and enablement to change. */
export function nativeRuleFingerprint(rule) {
  return createHash('sha256').update(JSON.stringify(canonical(definition(rule)))).digest('hex');
}

function cycleAt(now, startAt) {
  const date = new Date(now), day = date.getUTCDate();
  const result = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day >= 15 ? 15 : 1, 14);
  // On a funding date, an early invocation must not spend against the previous
  // cycle while today's percentage-based commitments remain uncalculated.
  if (result > now || startAt > now || result < startAt) fail('ROTH_NATIVE_CYCLE_NOT_STARTED');
  return result;
}

function summary(run, ruleId, lower, now) {
  if (!run || !sameId(run.ruleId, ruleId) || !UUID.test(run.id ?? '') || run.executionMode !== 'LIVE') fail('ROTH_NATIVE_EXECUTION_INVALID', true);
  const created = validTime(run.createdAt, now, 'ROTH_NATIVE_EXECUTION_TIME_INVALID');
  if (created < lower) fail('ROTH_NATIVE_EXECUTION_TIME_INVALID', true);
  if (FAILED.has(run.status)) fail('ROTH_NATIVE_EXECUTION_FAILED', true);
  if (run.status !== 'EXECUTED' && !EXECUTION_PENDING.has(run.status)) fail('ROTH_NATIVE_EXECUTION_STATUS_UNKNOWN', true);
  return created;
}

function transferIdentity(transfer, run, action, now) {
  if (!transfer || !UUID.test(transfer.id ?? '') || transfer.executionMode !== 'LIVE' || transfer.origin !== 'RULE' ||
      !sameId(transfer.ruleId, run.ruleId) || !sameId(transfer.ruleExecutionId, run.id) ||
      !sameId(transfer.source?.id, action.source.id) || !sameId(transfer.destination?.id, action.destination.id) ||
      transfer.source.type !== action.source.type || transfer.destination.type !== action.destination.type ||
      transfer.source.isDeleted !== false || transfer.destination.isDeleted !== false ||
      !cents(transfer.amountInCents) || transfer.amountInCents === 0 || transfer.errorCode !== null) fail('ROTH_NATIVE_TRANSFER_INVALID', true);
  const created = validTime(transfer.createdAt, now, 'ROTH_NATIVE_TRANSFER_TIME_INVALID');
  if (created < Date.parse(run.createdAt)) fail('ROTH_NATIVE_TRANSFER_TIME_INVALID', true);
  if (transfer.status === 'COMPLETE') {
    if (validTime(transfer.completedAt, now, 'ROTH_NATIVE_TRANSFER_TIME_INVALID') < created) fail('ROTH_NATIVE_TRANSFER_TIME_INVALID', true);
  } else if (!PENDING.has(transfer.status) || transfer.completedAt !== null) fail('ROTH_NATIVE_TRANSFER_FAILED', true);
}

async function nativeCommitments(client, config, proof, now) {
  const ruleId = config.rules?.funding;
  if (!sameId(ruleId, proof.ruleId)) fail('ROTH_NATIVE_PROOF_MISMATCH', true);
  const rule = await client.getRule(ruleId);
  if (!rule || !sameId(rule.id, ruleId) || rule.deletedAt !== null) fail('ROTH_NATIVE_RULE_INVALID', true);
  if (rule.status !== 'ENABLED') fail('ROTH_NATIVE_RULE_DISABLED');
  const pinned = definition(rule);
  if (!sameId(pinned.trigger.accountId, config.accounts.income) ||
      pinned.steps.some(step => step.actions.some(action => sameId(action.destination.id, config.roth.accountId)))) fail('ROTH_NATIVE_DEFINITION_UNSUPPORTED', true);
  if (nativeRuleFingerprint(rule) !== proof.definitionHash) fail('ROTH_NATIVE_RULE_CHANGED', true);
  const start = Date.parse(pinned.trigger.startDate), cycle = cycleAt(now, start);
  // Activation at 14:30 still needs today's 14:00 savings commitments. This
  // lookback only reads evidence; the monthly policy decides contribution dates.
  const lower = Math.min(cycle, Math.max(start,
    config.activationAt ? validTime(config.activationAt, now, 'ROTH_ACTIVATION_TIME_INVALID') : start));
  const history = await client.listRuleExecutions({ ruleId, executionMode: 'LIVE', from: new Date(lower).toISOString(), to: new Date(now).toISOString() });
  if (history?.complete !== true || !Array.isArray(history.items)) fail('ROTH_NATIVE_HISTORY_INCOMPLETE');
  if (history.items.length > 200) fail('ROTH_NATIVE_HISTORY_TOO_LARGE');
  const seen = new Set(), needed = [];
  for (const item of history.items) {
    const created = summary(item, ruleId, lower, now), id = item.id.toLowerCase();
    if (seen.has(id)) fail('ROTH_NATIVE_HISTORY_CHANGED');
    seen.add(id);
    if (created >= cycle || item.status !== 'EXECUTED') needed.push(item);
  }
  if (needed.length > 20) fail('ROTH_NATIVE_HISTORY_TOO_LARGE');
  const verified = new Map(), executionIds = [];
  let currentScheduled = false;
  for (const item of needed) {
    const run = await client.getRuleExecution(ruleId, item.id);
    const created = summary(run, ruleId, lower, now);
    if (!sameId(run.id, item.id) || created !== Date.parse(item.createdAt) || item.status === 'EXECUTED' && run.status !== 'EXECUTED' ||
        !TRIGGERS.has(run.triggerDetails?.type)) fail('ROTH_NATIVE_EXECUTION_CHANGED', true);
    if (['transfersAttempted', 'transfersCompleted', 'transfersPending', 'transfersFailed'].some(key => !cents(run[key])) ||
        !Array.isArray(run.transferIds) || run.transferIds.some(id => !UUID.test(id)) || new Set(run.transferIds).size !== run.transferIds.length ||
        typeof run.conditionsNotMet !== 'boolean') fail('ROTH_NATIVE_COUNTS_INVALID', true);
    if (run.transfersFailed !== 0 || run.errorMessage !== null) fail('ROTH_NATIVE_EXECUTION_FAILED', true);
    if (run.nextAttemptAt !== null) fail('ROTH_NATIVE_RETRY_UNRESOLVED');
    if (run.conditionsNotMet) {
      if (run.status !== 'EXECUTED' || run.stepIndexMatched !== null || run.transfersAttempted !== 0 || run.transferIds.length !== 0 ||
          run.transfersCompleted !== 0 || run.transfersPending !== 0) fail('ROTH_NATIVE_COUNTS_INVALID', true);
    } else {
      if (!Number.isSafeInteger(run.stepIndexMatched) || run.stepIndexMatched < 0 || run.stepIndexMatched >= pinned.steps.length) fail('ROTH_NATIVE_STEP_INVALID', true);
      const actions = pinned.steps[run.stepIndexMatched].actions;
      if (run.transferIds.length !== actions.length || run.transfersAttempted !== actions.length ||
          run.transfersCompleted + run.transfersPending !== actions.length ||
          run.status === 'EXECUTED' && run.transfersPending !== 0 || run.status !== 'EXECUTED' && run.transfersPending === 0) {
        fail('ROTH_NATIVE_ACTIONS_INCOMPLETE');
      }
      const remaining = actions.slice();
      let completed = 0, pending = 0;
      for (const transferId of run.transferIds) {
        const transfer = await client.getTransfer(transferId);
        if (!sameId(transfer?.id, transferId)) fail('ROTH_NATIVE_TRANSFER_INVALID', true);
        const index = remaining.findIndex(action => sameId(action.source.id, transfer.source?.id) && sameId(action.destination.id, transfer.destination?.id));
        if (index < 0) fail('ROTH_NATIVE_TRANSFER_INVALID', true);
        transferIdentity(transfer, run, remaining[index], now);
        remaining.splice(index, 1);
        completed += transfer.status === 'COMPLETE' ? 1 : 0;
        pending += transfer.status === 'COMPLETE' ? 0 : 1;
        const key = transfer.id.toLowerCase();
        if (verified.has(key)) fail('ROTH_NATIVE_TRANSFER_REUSED', true);
        verified.set(key, transfer);
      }
      if (completed !== run.transfersCompleted || pending !== run.transfersPending) fail('ROTH_NATIVE_COUNTS_CHANGED');
    }
    executionIds.push(run.id);
    currentScheduled ||= created >= cycle && run.triggerDetails.type === 'SCHEDULED';
  }
  if (!currentScheduled) fail('ROTH_NATIVE_SCHEDULED_RUN_NOT_OBSERVED');
  return { transfers: verified, executionIds, cycleAt: new Date(cycle).toISOString() };
}

function sum(...values) {
  let result = 0;
  for (const value of values) {
    if (!cents(value) || !Number.isSafeInteger(result + value)) fail('ROTH_CASH_OVERFLOW', true);
    result += value;
  }
  return result;
}

function immutableTransferMatches(left, right) {
  return sameId(left.id, right.id) && sameId(left.source?.id, right.source?.id) && sameId(left.destination?.id, right.destination?.id) &&
    left.amountInCents === right.amountInCents && left.origin === right.origin && sameId(left.ruleId, right.ruleId) &&
    sameId(left.ruleExecutionId, right.ruleExecutionId) && left.executionMode === right.executionMode && left.createdAt === right.createdAt;
}

function ownContributionRecords(records, config, now) {
  if (!Array.isArray(records)) fail('ROTH_OWN_CONTRIBUTIONS_INVALID', true);
  const known = new Map();
  for (const record of records) {
    if (!record || !UUID.test(record.transferId ?? '') || !sameId(record.sourceAccountId, config.accounts.income) ||
        !sameId(record.destinationAccountId, config.roth.accountId) || !cents(record.amountInCents) || record.amountInCents === 0 ||
        !['SUBMITTING', 'PENDING', 'COMPLETE', 'REVIEW'].includes(record.status)) fail('ROTH_OWN_CONTRIBUTIONS_INVALID', true);
    const key = record.transferId.toLowerCase();
    if (known.has(key)) fail('ROTH_OWN_CONTRIBUTIONS_INVALID', true);
    const firstAttemptAt = validTime(record.firstAttemptAt, now, 'ROTH_OWN_CONTRIBUTIONS_INVALID');
    if (record.status === 'COMPLETE' && validTime(record.completedAt, now, 'ROTH_OWN_CONTRIBUTIONS_INVALID') < firstAttemptAt) {
      fail('ROTH_OWN_CONTRIBUTIONS_INVALID', true);
    }
    known.set(key, record);
  }
  return known;
}

function verifyOwnedContribution(transfer, own, now) {
  if (!sameId(transfer.id, own.transferId) || !sameId(transfer.source?.id, own.sourceAccountId) ||
      !sameId(transfer.destination?.id, own.destinationAccountId) || transfer.source.type !== 'EXTERNAL_ACCOUNT' ||
      transfer.destination.type !== 'EXTERNAL_ACCOUNT' || transfer.amountInCents !== own.amountInCents ||
      transfer.origin !== 'USER' || transfer.ruleId !== null || transfer.ruleExecutionId !== null ||
      validTime(transfer.createdAt, now, 'ROTH_OWN_CONTRIBUTION_CHANGED') < Date.parse(own.firstAttemptAt)) {
    fail('ROTH_OWN_CONTRIBUTION_CHANGED', true);
  }
  if (transfer.status === 'COMPLETE' && (own.status !== 'COMPLETE' ||
      Date.parse(transfer.completedAt) !== Date.parse(own.completedAt))) fail('ROTH_OWN_CONTRIBUTION_UNRECONCILED');
  if (own.status === 'COMPLETE' && transfer.status !== 'COMPLETE') fail('ROTH_OWN_CONTRIBUTION_CHANGED', true);
}

/** Plan a full cash contribution after savings commitments exist, without waiting
 * for the routing Pod to empty or for a refund. All native pending debits and
 * pending Income credits are conservatively subtracted from cash evidence. */
export async function rothFundingPlan(client, config, input, requestedAmountInCents,
  { now = Date.now(), lastSettledAt = null, outsideContributionsVerifiedAt = null, ownTransfers = [] } = {}) {
  const evidence = parseRothEvidence(input);
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || !cents(requestedAmountInCents) || requestedAmountInCents === 0 ||
      !UUID.test(config.roth?.accountId ?? '') || !cents(config.incomeReserveCents) ||
      !Number.isSafeInteger(config.maxBalanceAgeMs) || config.maxBalanceAgeMs <= 0) fail('ROTH_PLAN_CONFIGURATION_INVALID', true);
  validTime(evidence.updatedAt, now, 'ROTH_EVIDENCE_TIME_INVALID');
  if (evidence.route.status !== 'verified') fail('ROTH_ROUTE_UNVERIFIED', true);
  if (evidence.upstream.status !== 'verified') fail('ROTH_NATIVE_PROOF_UNVERIFIED', true);
  if (!sameId(evidence.route.sourceAccountId, config.accounts.income) || !sameId(evidence.route.destinationAccountId, config.roth.accountId) ||
      Object.values(config.accounts).some(id => sameId(id, config.roth.accountId))) fail('ROTH_ROUTE_MISMATCH', true);
  const outsideBaseline = validTime(outsideContributionsVerifiedAt, now, 'ROTH_CONTRIBUTION_BASELINE_UNVERIFIED');
  const ownContributions = ownContributionRecords(ownTransfers, config, now);
  const billsTarget = calculatedBillsTarget(config);
  const native = await nativeCommitments(client, config, evidence.upstream, now);
  const history = await client.listTransfers({ accountIds: [config.accounts.income, config.accounts.bills, config.roth.accountId],
    executionMode: 'LIVE', to: new Date(now).toISOString() });
  if (history?.complete !== true || !Array.isArray(history.items)) fail('ROTH_TRANSFER_HISTORY_INCOMPLETE');
  const seen = new Set();
  let sourceAfter = lastSettledAt ? validTime(lastSettledAt, now, 'ROTH_SETTLEMENT_TIME_INVALID') : -Infinity, billsAfter = -Infinity;
  let pendingNativeCents = 0, pendingIncomeCreditsCents = 0, pendingBillsCents = 0;
  for (const transfer of history.items) {
    if (transfer?.executionMode !== 'LIVE') fail('ROTH_TRANSFER_HISTORY_INVALID', true);
    const sourceIncome = sameId(transfer.source?.id, config.accounts.income), toIncome = sameId(transfer.destination?.id, config.accounts.income);
    const sourceBills = sameId(transfer.source?.id, config.accounts.bills), toBills = sameId(transfer.destination?.id, config.accounts.bills);
    const toRoth = sameId(transfer.destination?.id, config.roth.accountId);
    if (!sourceIncome && !toIncome && !sourceBills && !toBills && !toRoth) continue;
    if (!UUID.test(transfer.id ?? '') || !cents(transfer.amountInCents) || transfer.amountInCents === 0 ||
        transfer.source?.isDeleted !== false || transfer.destination?.isDeleted !== false) fail('ROTH_TRANSFER_HISTORY_INVALID', true);
    const id = transfer.id.toLowerCase();
    if (seen.has(id)) fail('ROTH_TRANSFER_HISTORY_CHANGED');
    seen.add(id);
    const created = validTime(transfer.createdAt, now, 'ROTH_TRANSFER_TIME_INVALID');
    const matchingNative = native.transfers.get(id);
    if (matchingNative && !immutableTransferMatches(transfer, matchingNative)) fail('ROTH_NATIVE_TRANSFER_CHANGED', true);
    const ownContribution = ownContributions.get(id);
    if (ownContribution) verifyOwnedContribution(transfer, ownContribution, now);
    if (transfer.status === 'COMPLETE') {
      const completed = validTime(transfer.completedAt, now, 'ROTH_TRANSFER_TIME_INVALID');
      if (completed < created || transfer.errorCode !== null) fail('ROTH_TRANSFER_TIME_INVALID', true);
      // An outside-contribution attestation is no longer enough when newer
      // provider evidence shows an unfamiliar completed retirement credit.
      if (toRoth && completed > outsideBaseline && !ownContribution) fail('ROTH_OUTSIDE_CONTRIBUTIONS_CHANGED', true);
      if (sourceIncome || toIncome) sourceAfter = Math.max(sourceAfter, completed);
      if (sourceBills || toBills) billsAfter = Math.max(billsAfter, completed);
    } else if (PENDING.has(transfer.status)) {
      if (transfer.completedAt !== null || transfer.errorCode !== null) fail('ROTH_TRANSFER_HISTORY_INVALID', true);
      if (sourceIncome) {
        if (!matchingNative || !PENDING.has(matchingNative.status)) fail('ROTH_UNKNOWN_INCOME_OUTGOING');
        pendingNativeCents = sum(pendingNativeCents, transfer.amountInCents);
      }
      if (toRoth) fail('ROTH_UNKNOWN_CONTRIBUTION_PENDING');
      if (toIncome) pendingIncomeCreditsCents = sum(pendingIncomeCreditsCents, transfer.amountInCents);
      if (sourceBills || toBills) pendingBillsCents = sum(pendingBillsCents, transfer.amountInCents);
    } else if (TRANSFER_FAILED.has(transfer.status)) {
      if (matchingNative || sameId(transfer.ruleId, config.rules.funding)) fail('ROTH_NATIVE_TRANSFER_FAILED', true);
    } else fail('ROTH_TRANSFER_STATUS_UNKNOWN', true);
  }
  // The exhaustive Income history must contain every inspected commitment. A
  // disappearing row is not evidence that a debit vanished or was canceled.
  for (const [id, transfer] of native.transfers) {
    if (!seen.has(id)) fail('ROTH_NATIVE_TRANSFER_MISSING');
    if (transfer.status === 'COMPLETE') sourceAfter = Math.max(sourceAfter, Date.parse(transfer.completedAt));
  }
  const [income, bills, destination] = await Promise.all([
    client.getAccount(config.accounts.income), client.getAccount(config.accounts.bills), client.getAccount(config.roth.accountId),
  ]);
  validateAccount(income, config.accounts.income, 'source');
  validateAccount(bills, config.accounts.bills, 'reserve');
  validateRothDestination(destination, config.roth.accountId);
  const sourceCash = cashBalance(income, { now, after: sourceAfter, maxAgeMs: config.maxBalanceAgeMs });
  const billsCash = cashBalance(bills, { now, after: billsAfter, maxAgeMs: config.maxBalanceAgeMs });
  const conservativeBillsCash = Math.max(0, billsCash.cents - pendingBillsCents);
  const billsShortfallCents = Math.max(0, billsTarget - conservativeBillsCash);
  const protectedIncomeCents = sum(config.incomeReserveCents, billsShortfallCents, pendingNativeCents, pendingIncomeCreditsCents);
  const usableIncomeCents = Math.max(0, sourceCash.cents - protectedIncomeCents);
  const reason = requestedAmountInCents < 100 ? 'BELOW_PROVIDER_MINIMUM' : usableIncomeCents < requestedAmountInCents ? 'CASH_INSUFFICIENT' : 'READY';
  return {
    allocationId: 'roth-ira', requestedAmountInCents, amountInCents: reason === 'READY' ? requestedAmountInCents : 0,
    usableIncomeCents, protectedIncomeCents, billsTargetCents: billsTarget, billsShortfallCents,
    pendingNativeCents, pendingIncomeCreditsCents, pendingBillsCents,
    sourceBalanceAt: sourceCash.observedAt, billsBalanceAt: billsCash.observedAt,
    nativeCycleAt: native.cycleAt, nativeExecutionIds: native.executionIds,
    nativeRuleHash: evidence.upstream.definitionHash, evidenceUpdatedAt: evidence.updatedAt, reason,
  };
}
