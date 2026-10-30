/** Read-only evidence for one monthly allocation cycle. No money moves here. */
import { EvidenceError, PENDING, cashBalance, validTime } from './evidence.mjs';
import { parseRothEvidence, validateRothDestination } from './roth-evidence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = new Set(['INCOMPLETE', 'ERROR', 'CANCELLED', 'APPROVAL_DENIED']);
const CASH_ROLES = ['income', 'bills', 'general', 'emergency', 'project'];
const KNOWN_STATUSES = new Set(['SUBMITTING', 'PENDING', 'COMPLETE', 'REVIEW']);
const MAX_ROWS = 10000;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const cents = value => Number.isSafeInteger(value) && value >= 0;
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && UUID.test(left) && left.toLowerCase() === right.toLowerCase();
const fail = (code, review = false) => { throw new EvidenceError(code, { review }); };
const iso = value => new Date(value).toISOString();

function add(...values) {
  let total = 0;
  for (const value of values) {
    if (!cents(value) || !Number.isSafeInteger(total + value)) fail('MONTHLY_CASH_OVERFLOW', true);
    total += value;
  }
  return total;
}

function rolesFor(config) {
  const roles = { income: config.accounts?.income, bills: config.accounts?.bills, general: config.accounts?.general,
    emergency: config.accounts?.emergency, project: config.monthly?.projectAccountId,
    personalInvestment: config.monthly?.personalAccountId, roth: config.roth?.accountId };
  if (Object.values(roles).some(id => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(Object.values(roles).map(id => id.toLowerCase())).size !== Object.keys(roles).length ||
      Object.values(roles).some(id => sameId(id, config.accounts?.pod))) fail('MONTHLY_ACCOUNT_MAPPING_INVALID', true);
  return Object.fromEntries(Object.entries(roles).map(([role, id]) => [role, id.toLowerCase()]));
}

function knownRecords(items, roles, now) {
  if (!Array.isArray(items) || items.length > MAX_ROWS) fail('MONTHLY_OWN_TRANSFERS_INVALID', true);
  const allowed = new Set(Object.entries(roles).filter(([role]) => role !== 'income').map(([, id]) => `${roles.income}:${id}`));
  allowed.add(`${roles.emergency}:${roles.income}`);
  const records = new Map();
  for (const item of items) {
    if (!record(item) || typeof item.transferId !== 'string' || !UUID.test(item.transferId) ||
        typeof item.sourceAccountId !== 'string' || !UUID.test(item.sourceAccountId) ||
        typeof item.destinationAccountId !== 'string' || !UUID.test(item.destinationAccountId) ||
        !cents(item.amountInCents) || item.amountInCents < 100 || !KNOWN_STATUSES.has(item.status)) {
      fail('MONTHLY_OWN_TRANSFERS_INVALID', true);
    }
    const source = item.sourceAccountId.toLowerCase(), destination = item.destinationAccountId.toLowerCase();
    const id = item.transferId.toLowerCase();
    if (!allowed.has(`${source}:${destination}`) || records.has(id)) fail('MONTHLY_OWN_TRANSFERS_INVALID', true);
    const firstAttempt = validTime(item.firstAttemptAt, now, 'MONTHLY_OWN_TRANSFER_TIME_INVALID');
    if (item.status === 'COMPLETE' && validTime(item.completedAt, now, 'MONTHLY_OWN_TRANSFER_TIME_INVALID') < firstAttempt) {
      fail('MONTHLY_OWN_TRANSFER_TIME_INVALID', true);
    }
    records.set(id, { ...item, transferId: id, sourceAccountId: source, destinationAccountId: destination });
  }
  return records;
}

function validateOwnedTransfer(transfer, own, now) {
  if (!sameId(transfer.id, own.transferId) || !sameId(transfer.source?.id, own.sourceAccountId) ||
      !sameId(transfer.destination?.id, own.destinationAccountId) || transfer.amountInCents !== own.amountInCents ||
      transfer.source.type !== 'EXTERNAL_ACCOUNT' || transfer.destination.type !== 'EXTERNAL_ACCOUNT' ||
      transfer.origin !== 'USER' || transfer.ruleId !== null || transfer.ruleExecutionId !== null ||
      validTime(transfer.createdAt, now, 'MONTHLY_OWN_TRANSFER_TIME_INVALID') < Date.parse(own.firstAttemptAt)) {
    fail('MONTHLY_OWN_TRANSFER_CHANGED', true);
  }
  if (FAILED.has(transfer.status)) fail('MONTHLY_OWN_TRANSFER_FAILED', true);
  if (transfer.status === 'COMPLETE' && (own.status !== 'COMPLETE' ||
      Date.parse(transfer.completedAt) !== Date.parse(own.completedAt))) fail('MONTHLY_OWN_TRANSFER_UNRECONCILED');
  if (own.status === 'COMPLETE' && transfer.status !== 'COMPLETE') fail('MONTHLY_OWN_TRANSFER_CHANGED', true);
}

function validateTransfer(item, accountIds, now) {
  if (!record(item) || typeof item.id !== 'string' || !UUID.test(item.id) || item.executionMode !== 'LIVE' ||
      !cents(item.amountInCents) || item.amountInCents === 0 ||
      ![item.source, item.destination].every(actor => record(actor) && typeof actor.id === 'string' && UUID.test(actor.id) &&
        ['EXTERNAL_ACCOUNT', 'INCOME_SOURCE', 'POD'].includes(actor.type) && actor.isDeleted === false) ||
      ![item.source.id, item.destination.id].some(id => accountIds.has(id.toLowerCase())) ||
      sameId(item.source.id, item.destination.id)) fail('MONTHLY_TRANSFER_HISTORY_INVALID', true);
  const created = validTime(item.createdAt, now, 'MONTHLY_TRANSFER_TIME_INVALID');
  if (item.status === 'COMPLETE') {
    if (validTime(item.completedAt, now, 'MONTHLY_TRANSFER_TIME_INVALID') < created || item.errorCode !== null) {
      fail('MONTHLY_TRANSFER_TIME_INVALID', true);
    }
  } else if (PENDING.has(item.status)) {
    if (item.completedAt !== null || item.errorCode !== null) fail('MONTHLY_TRANSFER_HISTORY_INVALID', true);
  } else if (!FAILED.has(item.status)) fail('MONTHLY_TRANSFER_STATUS_UNKNOWN', true);
  return item.id.toLowerCase();
}

function validateAccount(account, id, role) {
  if (!record(account) || !sameId(account.id, id) || account.deletedAt !== null || account.type !== 'EXTERNAL_ACCOUNT') {
    fail('MONTHLY_ACCOUNT_IDENTITY_INVALID', true);
  }
  if (role === 'roth') return validateRothDestination(account, id);
  if (account.externalAccountType !== (role === 'personalInvestment' ? 'INVESTMENT' : 'DEPOSITORY')) {
    fail(role === 'personalInvestment' ? 'MONTHLY_PERSONAL_ACCOUNT_NOT_INVESTMENT' : 'MONTHLY_ACCOUNT_NOT_CASH', true);
  }
  if (role !== 'income' && account.canBeDestination !== true) fail('MONTHLY_ACCOUNT_CANNOT_RECEIVE', true);
  if ((role === 'income' || role === 'emergency') && account.canBeSource !== true) fail('MONTHLY_ACCOUNT_CANNOT_SEND', true);
  // Income must also receive the independently verified Emergency excess return.
  if (role === 'income' && account.canBeDestination !== true) fail('MONTHLY_ACCOUNT_CANNOT_RECEIVE', true);
  return account;
}

async function disabledRules(client, config) {
  if (!record(config.rules)) fail('MONTHLY_LEGACY_RULES_UNVERIFIED', true);
  const entries = Object.entries(config.rules);
  if (entries.length < 1 || entries.some(([, id]) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(entries.map(([, id]) => id.toLowerCase())).size !== entries.length) fail('MONTHLY_LEGACY_RULES_UNVERIFIED', true);
  const statuses = {};
  for (const [name, id] of entries) {
    const rule = await client.getRule(id);
    if (!record(rule) || !sameId(rule.id, id) || rule.deletedAt !== null || !['DISABLED', 'ENABLED'].includes(rule.status)) {
      fail('MONTHLY_LEGACY_RULE_IDENTITY_INVALID', true);
    }
    if (rule.status !== 'DISABLED') fail('MONTHLY_LEGACY_RULE_ENABLED', true);
    statuses[name] = rule.status;
  }
  return statuses;
}

function externalHistory(result, incomeId, from, now) {
  if (result?.complete !== true || !Array.isArray(result.items) || result.items.length > MAX_ROWS ||
      !record(result.window) || result.window.truncated !== false) fail('MONTHLY_EXTERNAL_HISTORY_INCOMPLETE');
  const lower = validTime(result.window.from, now, 'MONTHLY_EXTERNAL_WINDOW_INVALID');
  const upper = validTime(result.window.to, now, 'MONTHLY_EXTERNAL_WINDOW_INVALID');
  if (lower !== from || upper !== now || lower > upper) fail('MONTHLY_EXTERNAL_WINDOW_INVALID', true);
  const seen = new Set();
  let last = Infinity;
  for (const item of result.items) {
    if (!record(item) || typeof item.id !== 'string' || !UUID.test(item.id) || !sameId(item.accountId, incomeId) ||
        !cents(item.amountInCents) || !['MONEY_IN', 'MONEY_OUT'].includes(item.direction) || !['PENDING', 'COMPLETE'].includes(item.status) ||
        ![item.description, item.merchantName, item.category].every(value => value === null || typeof value === 'string')) {
      fail('MONTHLY_EXTERNAL_TRANSACTION_INVALID', true);
    }
    const at = validTime(item.transactionDate, now, 'MONTHLY_EXTERNAL_TRANSACTION_TIME_INVALID');
    const id = item.id.toLowerCase();
    if (at < lower || at > upper || at > last) fail('MONTHLY_EXTERNAL_WINDOW_INVALID', true);
    if (seen.has(id)) fail('MONTHLY_EXTERNAL_HISTORY_CHANGED');
    seen.add(id); last = at;
  }
  return result;
}

/** Reading the bank feed never classifies a deposit as salary, windfall, or a
 * returned Emergency allocation. That requires the private durable income ledger. */
export async function readMonthlyEvidence(client, config,
  { now = Date.now(), knownTransfers = [], lastSettledAt = null, externalFrom } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) ||
      !Number.isSafeInteger(config.maxBalanceAgeMs) || config.maxBalanceAgeMs <= 0 || config.maxBalanceAgeMs > 26 * 3600000) {
    fail('MONTHLY_EVIDENCE_CONFIGURATION_INVALID', true);
  }
  const roles = rolesFor(config), ids = new Set(Object.values(roles));
  const known = knownRecords(knownTransfers, roles, now);
  const lower = validTime(externalFrom, now, 'MONTHLY_EXTERNAL_COVERAGE_REQUIRED');
  const nativeRuleStatuses = await disabledRules(client, config);
  const history = await client.listTransfers({ accountIds: [...ids], executionMode: 'LIVE', to: iso(now) });
  if (history?.complete !== true || !Array.isArray(history.items) || history.items.length > MAX_ROWS) fail('MONTHLY_TRANSFER_HISTORY_INCOMPLETE');
  const seen = new Set(), after = Object.fromEntries(Object.keys(roles).map(role => [role, -Infinity]));
  if (lastSettledAt !== null) after.income = validTime(lastSettledAt, now, 'MONTHLY_SETTLEMENT_TIME_INVALID');
  const pendingIncoming = Object.fromEntries(Object.keys(roles).map(role => [role, 0]));
  const pendingOutgoing = Object.fromEntries(Object.keys(roles).map(role => [role, 0]));
  for (const transfer of history.items) {
    const id = validateTransfer(transfer, ids, now);
    if (seen.has(id)) fail('MONTHLY_TRANSFER_HISTORY_CHANGED');
    seen.add(id);
    const own = known.get(id);
    if (own) validateOwnedTransfer(transfer, own, now);
    if (PENDING.has(transfer.status) && !own &&
        [roles.income, roles.emergency].some(source => sameId(transfer.source.id, source))) {
      fail('MONTHLY_UNKNOWN_OUTGOING', true);
    }
    for (const [role, accountId] of Object.entries(roles)) {
      const outgoing = sameId(transfer.source.id, accountId), incoming = sameId(transfer.destination.id, accountId);
      if (transfer.status === 'COMPLETE' && (incoming || outgoing)) after[role] = Math.max(after[role], Date.parse(transfer.completedAt));
      if (PENDING.has(transfer.status)) {
        if (incoming) pendingIncoming[role] = add(pendingIncoming[role], transfer.amountInCents);
        if (outgoing) pendingOutgoing[role] = add(pendingOutgoing[role], transfer.amountInCents);
      }
    }
  }
  // A missing owned row is an evidence gap, not permission to release its cash.
  for (const id of known.keys()) if (!seen.has(id)) fail('MONTHLY_OWN_TRANSFER_MISSING');
  const accounts = await Promise.all(Object.entries(roles).map(async ([role, id]) => [role, validateAccount(await client.getAccount(id), id, role)]));
  const snapshots = {};
  for (const [role, account] of accounts) {
    const identity = { accountId: roles[role], type: account.type, externalAccountType: account.externalAccountType,
      institutionName: account.institutionName ?? null, deletedAt: account.deletedAt,
      canBeSource: account.canBeSource, canBeDestination: account.canBeDestination };
    if (!CASH_ROLES.includes(role)) { snapshots[role] = identity; continue; }
    const balance = cashBalance(account, { now, after: after[role], maxAgeMs: config.maxBalanceAgeMs });
    snapshots[role] = { ...identity, balanceCents: account.balance.balanceInCents, availableBalanceCents: account.balance.availableBalanceInCents,
      cashCents: balance.cents, observedAt: balance.observedAt, pendingIncomingCents: pendingIncoming[role], pendingOutgoingCents: pendingOutgoing[role],
      spendableCents: Math.max(0, balance.cents - add(pendingIncoming[role], pendingOutgoing[role])),
      // Known incoming commitments count toward a balance target, never toward
      // source cash. This can underfund while pending; it cannot duplicate them.
      fundingBalanceCents: add(balance.cents, pendingIncoming[role]) };
  }
  const external = externalHistory(await client.listExternalTransactions({ accountIds: [roles.income], from: iso(lower), to: iso(now) }), roles.income, lower, now);
  const incomeAt = Date.parse(snapshots.income.observedAt);
  let pendingExternalIncomeDebitCents = 0, pendingExternalIncomeCreditCents = 0;
  for (const item of external.items) {
    if (item.status === 'COMPLETE' && Date.parse(item.transactionDate) > incomeAt) fail('INCOME_BALANCE_BEFORE_POSTED_ACTIVITY');
    if (item.status === 'PENDING') {
      if (item.direction === 'MONEY_OUT') pendingExternalIncomeDebitCents = add(pendingExternalIncomeDebitCents, item.amountInCents);
      else pendingExternalIncomeCreditCents = add(pendingExternalIncomeCreditCents, item.amountInCents);
    }
  }
  const pendingExternalIncomeCents = add(pendingExternalIncomeDebitCents, pendingExternalIncomeCreditCents);
  snapshots.income.spendableCents = Math.max(0, snapshots.income.spendableCents - pendingExternalIncomeCents);
  return { observedAt: iso(now), accountSnapshots: snapshots, transfers: history.items, externalTransactions: external,
    sourceBalanceCents: snapshots.income.balanceCents, sourceCashCents: snapshots.income.cashCents,
    sourceSpendableCents: snapshots.income.spendableCents, incomeBalanceUpdatedAt: snapshots.income.observedAt,
    pendingSourceDebitCents: pendingOutgoing.income, pendingIncomeCreditCents: pendingIncoming.income,
    pendingExternalIncomeDebitCents, pendingExternalIncomeCreditCents,
    targetPendingIncomingCents: Object.fromEntries(CASH_ROLES.filter(role => role !== 'income').map(role => [role, pendingIncoming[role]])),
    nativeRuleStatuses };
}

/** Feature-specific retirement attestation. A missing IRA eligibility proof must
 * not disable ordinary Bills funding, so the engine calls this only for Roth. */
export function checkMonthlyRothEvidence(evidence, config,
  { now = Date.now(), rothEvidence, outsideContributionsVerifiedAt, knownTransfers = [] } = {}) {
  const roles = rolesFor(config), proof = parseRothEvidence(rothEvidence);
  validTime(proof.updatedAt, now, 'ROTH_EVIDENCE_TIME_INVALID');
  if (proof.route.status !== 'verified') fail('ROTH_ROUTE_UNVERIFIED', true);
  if (!sameId(proof.route.sourceAccountId, roles.income) || !sameId(proof.route.destinationAccountId, roles.roth)) fail('ROTH_ROUTE_MISMATCH', true);
  const snapshot = evidence?.accountSnapshots?.roth;
  validateRothDestination(snapshot && { ...snapshot, id: snapshot.accountId }, roles.roth);
  const baseline = validTime(outsideContributionsVerifiedAt, now, 'ROTH_CONTRIBUTION_BASELINE_UNVERIFIED');
  const known = knownRecords(knownTransfers, roles, now);
  if (!Array.isArray(evidence.transfers)) fail('MONTHLY_TRANSFER_HISTORY_INCOMPLETE');
  for (const transfer of evidence.transfers) {
    if (!sameId(transfer.destination?.id, roles.roth)) continue;
    validateTransfer(transfer, new Set(Object.values(roles)), now);
    const own = known.get(transfer.id.toLowerCase());
    if (own) validateOwnedTransfer(transfer, own, now);
    else if (PENDING.has(transfer.status)) fail('ROTH_UNKNOWN_CONTRIBUTION_PENDING', true);
    else if (transfer.status === 'COMPLETE' && Date.parse(transfer.completedAt) > baseline) fail('ROTH_OUTSIDE_CONTRIBUTIONS_CHANGED', true);
  }
  return { routeVerified: true, outsideContributionsVerifiedAt: iso(baseline), evidenceUpdatedAt: proof.updatedAt };
}
