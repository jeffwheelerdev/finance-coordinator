import { createHash } from 'node:crypto';
import { parseMonthlyPolicy, classifyIncomeCredit, monthlyPolicyHash } from './monthly-source.mjs';

export class IncomeLedgerError extends Error {
  constructor(code) { super(code); this.name = 'IncomeLedgerError'; this.code = code; }
}
const fail = code => { throw new IncomeLedgerError(code); };
const cents = x => { if (!Number.isSafeInteger(x) || x < 0) fail('INCOME_AMOUNT_INVALID'); return x; };
const sum = xs => { const n = xs.reduce((a, b) => a + BigInt(cents(b)), 0n); if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('INCOME_AMOUNT_OVERFLOW'); return Number(n); };
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const time = x => { const n = typeof x === 'string' ? Date.parse(x) : NaN; if (!Number.isFinite(n)) fail('INCOME_TIME_INVALID'); return n; };
const yearAt = x => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(time(x)));

export function incomeScanFrom(policy, ledger) {
  if (policy?.opening?.status !== 'verified') return null;
  const openingAt = time(policy.opening.asOf);
  return new Date(Math.max(openingAt, ledger?.scannedThrough ? time(ledger.scannedThrough) - 7 * 86400000 : openingAt)).toISOString();
}

/** Cash is fungible, its authorization is not. This ledger preserves all
 * posted bank rows and explicitly classified receipts. Bank debits reconcile
 * the total cash; immutable coordinator intents separately reserve their pool.
 * Unknown or manual debits can reduce the regular pool, but cannot authorize
 * spending the protected windfall or unclassified pools. */
export function reconcileIncome({ policy: rawPolicy, ledger = null, evidence, ownedTransfers = [] }) {
  const policy = parseMonthlyPolicy(rawPolicy);
  if (policy.opening.status !== 'verified') fail('INCOME_OPENING_UNVERIFIED');
  const openingHash = monthlyPolicyHash(policy.opening);
  const policyHash = monthlyPolicyHash(policy);
  const openingAt = time(policy.opening.asOf);
  const observedAt = time(evidence.observedAt);
  if (time(policy.updatedAt) > observedAt || openingAt > observedAt) fail('INCOME_POLICY_FROM_FUTURE');
  let next;
  if (ledger) {
    if (ledger.schemaVersion !== 1 || ledger.openingHash !== openingHash || !ledger.rows || Array.isArray(ledger.rows)) fail('INCOME_OPENING_CHANGED');
    if (time(policy.updatedAt) < time(ledger.policyUpdatedAt) ||
      (time(policy.updatedAt) === time(ledger.policyUpdatedAt) && policyHash !== ledger.policyHash)) fail('INCOME_POLICY_ROLLBACK');
    next = structuredClone(ledger);
  } else next = { schemaVersion: 1, openingHash, rows: {}, scannedThrough: policy.opening.asOf };
  if (Object.keys(next.rows).length > 20000) fail('INCOME_LEDGER_FULL');
  const input = evidence.externalTransactions;
  if (!input || input.complete !== true || !Array.isArray(input.items) || !input.window || input.window.truncated !== false) fail('INCOME_HISTORY_INCOMPLETE');
  const from = time(input.window.from), to = time(input.window.to);
  if (from > time(next.scannedThrough) || to < time(next.scannedThrough) || to > observedAt + 300000 || from > to) fail('INCOME_HISTORY_GAP');
  // A ninety-day API cap cannot be treated as proof of an earlier gap.
  if (observedAt - time(next.scannedThrough) > 89 * 86400000) fail('INCOME_HISTORY_GAP');
  const balanceAt = time(evidence.incomeBalanceUpdatedAt);
  const observedIds = new Set();
  for (const tx of input.items) {
    if (typeof tx.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tx.id) ||
      !['MONEY_IN', 'MONEY_OUT'].includes(tx.direction) || !['PENDING', 'COMPLETE'].includes(tx.status)) fail('INCOME_TRANSACTION_INVALID');
    const txAt = time(tx.transactionDate);
    if (txAt < from || txAt > to || observedIds.has(tx.id)) fail('INCOME_TRANSACTION_WINDOW_INVALID');
    observedIds.add(tx.id);
    cents(tx.amountInCents);
    if (tx.status !== 'COMPLETE' || txAt <= openingAt) continue;
    if (txAt > balanceAt) fail('INCOME_BALANCE_BEFORE_POSTED_ACTIVITY');
    const identity = hash([tx.id, tx.accountId, tx.amountInCents, tx.direction, tx.description, tx.transactionDate, tx.merchantName]);
    const old = next.rows[tx.id];
    if (old && old.hash !== identity) fail('INCOME_TRANSACTION_CHANGED');
    const classification = tx.direction === 'MONEY_IN' ? classifyIncomeCredit(tx, policy) : { regularCents: 0, windfallCents: 0, unknownCents: 0, basis: 'debit' };
    if (old && old.unknownCents === 0 && (old.regularCents !== classification.regularCents || old.windfallCents !== classification.windfallCents)) fail('INCOME_CLASSIFICATION_CHANGED');
    next.rows[tx.id] = { hash: identity, amountInCents: tx.amountInCents, direction: tx.direction, transactionDate: tx.transactionDate,
      ...classification };
  }
  // If a previously observed row disappears from a fully returned overlapping
  // interval, do not silently erase it or continue with stale arithmetic.
  for (const [id, row] of Object.entries(next.rows)) {
    const at = time(row.transactionDate);
    if (at >= from && at <= to && !observedIds.has(id)) fail('INCOME_TRANSACTION_DISAPPEARED');
  }
  const rows = Object.values(next.rows);
  const inflow = sum(rows.filter(r => r.direction === 'MONEY_IN').map(r => r.amountInCents));
  const outflow = sum(rows.filter(r => r.direction === 'MONEY_OUT').map(r => r.amountInCents));
  const expected = BigInt(policy.opening.incomeBalanceCents) + BigInt(inflow) - BigInt(outflow);
  const current = cents(evidence.sourceBalanceCents);
  if (expected !== BigInt(current)) fail('INCOME_BALANCE_RECONCILIATION_REQUIRED');
  const unknownHeldCents = sum([policy.opening.unknownCents, ...rows.map(r => r.unknownCents)]);
  const windfallReceivedCents = sum([policy.opening.windfallCents, ...rows.map(r => r.windfallCents)]);
  const windfallReceivedByYear = { [yearAt(policy.opening.asOf)]: policy.opening.windfallCents };
  for (const row of rows) if (row.windfallCents) {
    const y = yearAt(row.transactionDate);
    windfallReceivedByYear[y] = sum([windfallReceivedByYear[y] ?? 0, row.windfallCents]);
  }
  const windfallReservedByYear = {};
  const requestIds = new Set();
  let windfallReservedCents = 0;
  for (const transfer of ownedTransfers) {
    if (typeof transfer.id !== 'string' || requestIds.has(transfer.id)) fail('INCOME_REQUEST_DUPLICATE');
    requestIds.add(transfer.id);
    const regular = cents(transfer.regularCents), windfall = cents(transfer.windfallCents);
    if (regular === 0 && windfall === 0) continue; // Emergency → Income excess return.
    if (sum([regular, windfall]) !== cents(transfer.amountInCents)) fail('INCOME_REQUEST_PARTITION_INVALID');
    windfallReservedCents = sum([windfallReservedCents, windfall]);
    if (windfall) {
      const monthKey = transfer.monthKey ?? (typeof transfer.id === 'string' ? transfer.id.slice(0, 7) : '');
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) fail('INCOME_REQUEST_YEAR_REQUIRED');
      const year = Number(monthKey.slice(0, 4));
      windfallReservedByYear[year] = sum([windfallReservedByYear[year] ?? 0, windfall]);
    }
  }
  if (windfallReservedCents > windfallReceivedCents) fail('INCOME_WINDFALL_OVERCOMMITTED');
  for (const [year, amount] of Object.entries(windfallReservedByYear)) if (amount > (windfallReceivedByYear[year] ?? 0)) fail('INCOME_WINDFALL_YEAR_OVERCOMMITTED');
  const allWindfallHeldCents = windfallReceivedCents - windfallReservedCents;
  const currentYear = yearAt(evidence.observedAt);
  const windfallHeldCents = (windfallReceivedByYear[currentYear] ?? 0) - (windfallReservedByYear[currentYear] ?? 0);
  const priorYearWindfallHeldCents = allWindfallHeldCents - windfallHeldCents;
  const spendable = cents(evidence.sourceSpendableCents);
  if (spendable > current) fail('INCOME_SPENDABLE_EXCEEDS_BALANCE');
  const protectedCents = sum([unknownHeldCents, allWindfallHeldCents]);
  if (protectedCents > spendable) fail('INCOME_PROTECTED_CASH_MISSING');
  const availableRegularCents = spendable - protectedCents;
  // Percentages are frozen by the monthly engine; pending credits never form
  // part of the eligible opening pool even if a provider shows them in current.
  const openingRegularCents = availableRegularCents;
  Object.assign(next, { policyHash, policyUpdatedAt: policy.updatedAt, scannedThrough: new Date(to).toISOString(),
    reconciledAt: new Date(observedAt).toISOString(), lastBalanceAt: new Date(balanceAt).toISOString(), lastBalanceCents: current,
    windfallReceivedCents, windfallReservedCents, unknownHeldCents, windfallReceivedByYear, windfallReservedByYear });
  return { ledger: next, openingRegularCents, availableRegularCents, windfallHeldCents, priorYearWindfallHeldCents, unknownHeldCents,
    alerts: [...(unknownHeldCents ? [{ code: 'INCOME_CLASSIFICATION_REQUIRED', amountInCents: unknownHeldCents }] : []),
      ...(priorYearWindfallHeldCents ? [{ code: 'PRIOR_YEAR_WINDFALL_REVIEW_REQUIRED', amountInCents: priorYearWindfallHeldCents }] : [])] };
}
