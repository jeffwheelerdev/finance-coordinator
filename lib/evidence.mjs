/** Read-only evidence and funding arithmetic. No provider writes live here. */
export class EvidenceError extends Error {
  constructor(code, { review = false } = {}) {
    super(code);
    this.name = 'EvidenceError';
    this.code = code;
    this.review = review;
  }
}

export const PENDING = new Set(['APPROVAL_PENDING', 'PROCESSING', 'PENDING']);
const FAILED = new Set(['INCOMPLETE', 'ERROR', 'CANCELLED', 'APPROVAL_DENIED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function iso(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return false;
  if (m[7] !== 'Z' && (Number(m[7].slice(1, 3)) > 23 || Number(m[7].slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
const cents = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, review = false) => { throw new EvidenceError(code, { review }); };

export function validTime(value, now, code = 'INVALID_TIMESTAMP') {
  if (!iso(value) || Date.parse(value) > now) fail(code);
  return Date.parse(value);
}

export function validateAccount(account, expectedId, role) {
  if (!account || account.id !== expectedId || account.deletedAt !== null) fail('ACCOUNT_IDENTITY_INVALID', true);
  if (account.type === 'EXTERNAL_ACCOUNT') {
    if (account.externalAccountType !== 'DEPOSITORY') fail('ACCOUNT_IS_NOT_CASH', true);
  } else if (!['POD', 'INCOME_SOURCE'].includes(account.type)) {
    fail('ACCOUNT_IS_NOT_CASH', true);
  }
  if (role === 'source' && account.canBeSource !== true) fail('ACCOUNT_CANNOT_SEND', true);
  if (role === 'destination' && account.canBeDestination !== true) fail('ACCOUNT_CANNOT_RECEIVE', true);
  return account;
}

/** Aggregated bank balances must postdate every preceding settled movement. */
export function cashBalance(account, { after, now, maxAgeMs }) {
  const balance = account.balance;
  if (!balance || balance.error !== null || !cents(balance.balanceInCents) || !cents(balance.availableBalanceInCents)) {
    fail('BALANCE_UNAVAILABLE');
  }
  let observedAt;
  if (account.type === 'EXTERNAL_ACCOUNT') {
    observedAt = validTime(balance.balanceLastUpdatedAt, now, 'BALANCE_TIMESTAMP_UNAVAILABLE');
    if (now - observedAt > maxAgeMs) fail('BALANCE_TOO_OLD');
    if (observedAt <= after) fail('WAITING_FOR_POST_SETTLEMENT_BALANCE');
  } else {
    // Sequence-managed accounts are read directly. Their timestamp may be null.
    if (!cents(balance.holdInCents) || balance.balanceInCents !== balance.availableBalanceInCents + balance.holdInCents) {
      fail('MANAGED_BALANCE_INCONSISTENT');
    }
    observedAt = now;
  }
  return {
    // Available credit/overdraft is not cash. Pending card holds reduce the target balance.
    cents: Math.min(balance.balanceInCents, balance.availableBalanceInCents),
    observedAt: new Date(observedAt).toISOString(),
  };
}

export async function checkRules(client, config, { requireEnabled = false } = {}) {
  const rows = {};
  for (const name of ['payout', 'funding', 'legacyGeneral']) {
    const id = config.rules[name];
    if (!id) continue;
    const rule = await client.getRule(id);
    if (rule.id !== id || rule.deletedAt !== null || !['ENABLED', 'DISABLED'].includes(rule.status)) fail('RULE_IDENTITY_INVALID', true);
    rows[name] = rule.status;
    if (name === 'legacyGeneral' && rule.status !== 'DISABLED') fail('LEGACY_TOPUP_RULE_MUST_BE_DISABLED', true);
    if (requireEnabled && name !== 'legacyGeneral' && rule.status !== 'ENABLED') fail('UPSTREAM_RULE_DISABLED');
  }
  return rows;
}

export async function discoverEvents(client, config, { now, activationAt = null } = {}) {
  const accountIds = [...new Set([
    config.accounts.income, config.accounts.pod, config.accounts.bills,
    ...config.allocations.filter((a) => a.enabled).map((a) => a.destinationAccountId),
  ])];
  // Full, bounded pagination intentionally includes old pending transfers. A createdAt
  // cursor alone would miss a transfer that settles days after its creation.
  const result = await client.listTransfers({ accountIds, executionMode: 'LIVE', to: new Date(now).toISOString() });
  if (result.complete !== true || !Array.isArray(result.items)) fail('INCOMPLETE_TRANSFER_HISTORY');
  const cutoff = activationAt ? Date.parse(activationAt) : -Infinity;
  const groups = new Map();
  const seen = new Map();
  for (const transfer of result.items) {
    if (!transfer || !UUID.test(transfer.id ?? '')) fail('TRANSFER_IDENTITY_INVALID', true);
    if (seen.has(transfer.id)) {
      if (JSON.stringify(seen.get(transfer.id)) !== JSON.stringify(transfer)) fail('TRANSFER_HISTORY_CHANGED');
      continue;
    }
    seen.set(transfer.id, transfer);
    if (transfer.executionMode !== 'LIVE' || transfer.origin !== 'RULE' ||
        transfer.source?.id !== config.accounts.pod || transfer.destination?.id !== config.accounts.income ||
        transfer.ruleId !== config.rules.payout || transfer.status !== 'COMPLETE') continue;
    if (!UUID.test(transfer.ruleExecutionId ?? '') || !cents(transfer.amountInCents) || transfer.amountInCents === 0) fail('REFUND_IDENTITY_INVALID', true);
    const created = validTime(transfer.createdAt, now);
    const completed = validTime(transfer.completedAt, now);
    if (completed < created) fail('REFUND_TIMESTAMPS_INVALID', true);
    if (created < cutoff) continue;
    const key = `${config.rules.payout}:${transfer.ruleExecutionId}`;
    const group = groups.get(key) ?? { key, executionId: transfer.ruleExecutionId, refundIds: [], startedAt: transfer.createdAt, completedAt: transfer.completedAt };
    group.refundIds.push(transfer.id);
    if (created < Date.parse(group.startedAt)) group.startedAt = transfer.createdAt;
    if (completed > Date.parse(group.completedAt)) group.completedAt = transfer.completedAt;
    groups.set(key, group);
  }
  return {
    transfers: [...seen.values()],
    events: [...groups.values()].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.key.localeCompare(b.key)),
  };
}

export async function verifyRefund(client, config, candidate, { now, activationAt = null } = {}) {
  const run = await client.getRuleExecution(config.rules.payout, candidate.executionId);
  if (run.id !== candidate.executionId || run.ruleId !== config.rules.payout || run.executionMode !== 'LIVE') fail('PAYOUT_EXECUTION_IDENTITY_INVALID', true);
  const started = validTime(run.createdAt, now);
  if (activationAt && started < Date.parse(activationAt)) fail('PAYOUT_PREDATES_ACTIVATION');
  if (['FAILED', 'PARTIAL', 'APPROVAL_DENIED'].includes(run.status)) fail('PAYOUT_REQUIRES_REVIEW', true);
  if (run.status !== 'EXECUTED' || run.transfersPending !== 0) fail('PAYOUT_NOT_SETTLED');
  if (!Array.isArray(run.transferIds) || run.transferIds.length === 0 || run.transferIds.length > 100 ||
      new Set(run.transferIds).size !== run.transferIds.length || run.transferIds.some((id) => !UUID.test(id)) ||
      run.transfersFailed !== 0 || run.transfersCompleted !== run.transferIds.length ||
      !Number.isSafeInteger(run.transfersAttempted) || run.transfersAttempted < run.transferIds.length ||
      run.conditionsNotMet !== false || run.nextAttemptAt !== null || run.errorMessage !== null) {
    fail('PAYOUT_COUNTS_INCONSISTENT', true);
  }
  const refunds = [];
  let completed = started;
  for (const id of run.transferIds) {
    const transfer = await client.getTransfer(id);
    if (transfer.id !== id || transfer.ruleId !== run.ruleId || transfer.ruleExecutionId !== run.id ||
        transfer.executionMode !== 'LIVE' || transfer.origin !== 'RULE' ||
        transfer.source?.isDeleted !== false || transfer.destination?.isDeleted !== false ||
        !cents(transfer.amountInCents) || transfer.amountInCents === 0) fail('PAYOUT_TRANSFER_IDENTITY_INVALID', true);
    if (FAILED.has(transfer.status)) fail('PAYOUT_REQUIRES_REVIEW', true);
    if (transfer.status !== 'COMPLETE') fail('PAYOUT_NOT_SETTLED');
    const transferCreated = validTime(transfer.createdAt, now);
    const transferCompleted = validTime(transfer.completedAt, now);
    if (transferCreated < started || transferCompleted < transferCreated || transfer.errorCode !== null) fail('PAYOUT_TRANSFER_INCONSISTENT', true);
    completed = Math.max(completed, transferCompleted);
    if (transfer.source.id === config.accounts.pod && transfer.destination.id === config.accounts.income) refunds.push(id);
  }
  if (refunds.length === 0 || candidate.refundIds.some((id) => !refunds.includes(id))) fail('REFUND_LINKAGE_INVALID', true);
  return {
    ...candidate,
    refundIds: refunds.sort(),
    startedAt: run.createdAt,
    completedAt: new Date(completed).toISOString(),
  };
}

export async function fundingPlan(client, config, allocation, event, transfers, { now, lastSettledAt = null } = {}) {
  const relevant = new Set([config.accounts.income, config.accounts.pod, config.accounts.bills, allocation.destinationAccountId]);
  let latestRelatedSettlement = -Infinity;
  for (const transfer of transfers) {
    if (transfer.executionMode !== 'LIVE' || (!relevant.has(transfer.source?.id) && !relevant.has(transfer.destination?.id))) continue;
    if (PENDING.has(transfer.status)) fail('RELATED_TRANSFER_PENDING');
    if (transfer.status !== 'COMPLETE' && !FAILED.has(transfer.status)) fail('UNKNOWN_TRANSFER_STATUS', true);
    if (FAILED.has(transfer.status) && transfer.ruleId === config.rules.funding &&
        transfer.source?.id === config.accounts.income &&
        (!config.activationAt || validTime(transfer.createdAt, now) >= Date.parse(config.activationAt))) {
      fail('UPSTREAM_FUNDING_FAILURE_REQUIRES_REVIEW', true);
    }
    if (transfer.status === 'COMPLETE') latestRelatedSettlement = Math.max(latestRelatedSettlement, validTime(transfer.completedAt, now));
  }
  const [income, destination, bills, pod] = await Promise.all([
    client.getAccount(config.accounts.income), client.getAccount(allocation.destinationAccountId),
    client.getAccount(config.accounts.bills), client.getAccount(config.accounts.pod),
  ]);
  validateAccount(income, config.accounts.income, 'source');
  validateAccount(destination, allocation.destinationAccountId, 'destination');
  validateAccount(bills, config.accounts.bills, 'reserve');
  validateAccount(pod, config.accounts.pod, 'source');
  if (pod.type !== 'POD' || !pod.balance || pod.balance.error !== null ||
      pod.balance.balanceInCents !== 0 || pod.balance.availableBalanceInCents !== 0 || pod.balance.holdInCents !== 0) fail('POD_NOT_EMPTY');
  const after = Math.max(validTime(event.completedAt, now), latestRelatedSettlement, lastSettledAt ? validTime(lastSettledAt, now) : -Infinity);
  const options = { after, now, maxAgeMs: config.maxBalanceAgeMs };
  const sourceCash = cashBalance(income, options);
  const destinationCash = cashBalance(destination, options);
  const billsCash = cashBalance(bills, options);
  const billsShortfallCents = Math.max(0, config.billsBufferCents - billsCash.cents);
  if (!Number.isSafeInteger(config.incomeReserveCents + billsShortfallCents)) fail('RESERVE_OVERFLOW', true);
  const protectedIncomeCents = config.incomeReserveCents + billsShortfallCents;
  const usableIncomeCents = Math.max(0, sourceCash.cents - protectedIncomeCents);
  const gapCents = Math.max(0, allocation.targetCents - destinationCash.cents);
  const amountInCents = Math.min(gapCents, usableIncomeCents);
  const reason = gapCents === 0 ? 'TARGET_ALREADY_MET' : usableIncomeCents === 0 ? 'NO_UNCOMMITTED_INCOME' : amountInCents < 100 ? 'BELOW_PROVIDER_MINIMUM' : 'READY';
  return {
    allocationId: allocation.id, monthlyBudgetCents: allocation.monthlyBudgetCents,
    reserveMonths: allocation.reserveMonths, targetCents: allocation.targetCents,
    destinationCashCents: destinationCash.cents, gapCents, usableIncomeCents,
    protectedIncomeCents, billsShortfallCents, amountInCents: reason === 'READY' ? amountInCents : 0,
    reason, sourceBalanceAt: sourceCash.observedAt, destinationBalanceAt: destinationCash.observedAt,
  };
}
