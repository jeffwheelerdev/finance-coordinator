import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMonthlyPolicy, classifyIncomeCredit, resolveMonthlyPolicy } from '../lib/monthly-source.mjs';
import { reconcileIncome, incomeScanFrom } from '../lib/income-ledger.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const openingAt = '2030-01-01T12:00:00.000Z', at = '2030-01-15T12:00:00.000Z', now = '2030-02-01T15:00:00.000Z';
const policy = () => ({ schemaVersion: 1, id: 'monthly-priority', updatedAt: openingAt,
  opening: { status: 'verified', asOf: openingAt, incomeBalanceCents: 0, regularCents: 0, windfallCents: 0, unknownCents: 0, reference: 'Reviewed empty synthetic opening balance' },
  classification: { rules: [
    { id: 'navy', kind: 'navy-pay', excludesBonuses: true, descriptionEquals: 'SYNTHETIC NAVY PAY', merchantEquals: 'Synthetic Payroll', minAmountCents: 200000, maxAmountCents: 500000, verifiedAt: openingAt, reference: 'Synthetic reviewed regular payroll evidence' },
    { id: 'refund', kind: 'windfall', descriptionEquals: 'SYNTHETIC TAX REFUND', merchantEquals: 'Synthetic Tax Agency', minAmountCents: 1, maxAmountCents: 10000000, verifiedAt: openingAt, reference: 'Synthetic reviewed tax refund evidence' },
  ], overrides: [] } });
const tx = (n, amount, description = 'SYNTHETIC NAVY PAY', merchantName = 'Synthetic Payroll', direction = 'MONEY_IN') => ({ id: id(n), accountId: id(100), amountInCents: amount, direction, status: 'COMPLETE', description, merchantName, transactionDate: at });
const evidence = (items, balance, options = {}) => ({ observedAt: now, incomeBalanceUpdatedAt: now, sourceBalanceCents: balance, sourceSpendableCents: balance,
  pendingIncomeCreditCents: 0, externalTransactions: { items, complete: true, window: { from: openingAt, to: now, truncated: false } }, ...options });
const error = (fn, code) => assert.throws(fn, e => e.code === code);

test('separates the requested 9000 into 5000 regular and 4000 windfall', () => {
  const result = reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 500000), tx(2, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency')], 900000) });
  assert.equal(result.openingRegularCents, 500000); assert.equal(result.availableRegularCents, 500000); assert.equal(result.windfallHeldCents, 400000);
});
test('unknown deposits remain protected while classified salary can fund essentials', () => {
  const result = reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 500000), tx(2, 400000, 'DFAS UNSPECIFIED BONUS', 'Synthetic Payroll')], 900000) });
  assert.equal(result.availableRegularCents, 500000); assert.equal(result.unknownHeldCents, 400000); assert.equal(result.alerts[0].code, 'INCOME_CLASSIFICATION_REQUIRED');
});
test('merchant name alone never establishes Navy salary', () => {
  const result = classifyIncomeCredit(tx(1, 230000, 'Unknown DFAS payment'), parseMonthlyPolicy(policy()));
  assert.equal(result.unknownCents, 230000);
});
test('pay above a reviewed amount range is not automatically ordinary pay', () => {
  assert.equal(classifyIncomeCredit(tx(1, 1000000), parseMonthlyPolicy(policy())).unknownCents, 1000000);
});
test('overlapping rules make a receipt unknown', () => {
  const p = policy(); p.classification.rules.push({ ...p.classification.rules[0], id: 'second' });
  assert.equal(classifyIncomeCredit(tx(1, 250000), parseMonthlyPolicy(p)).basis, 'ambiguous');
});
test('explicit mixed receipt classification supports a paycheck and bonus in one bank deposit', () => {
  const p = policy(); p.classification.overrides.push({ transactionId: id(1), amountInCents: 900000, regularCents: 500000, windfallCents: 400000, verifiedAt: openingAt, reference: 'Reviewed split of synthetic payroll and bonus' });
  const result = reconcileIncome({ policy: p, evidence: evidence([tx(1, 900000)], 900000) });
  assert.equal(result.availableRegularCents, 500000); assert.equal(result.windfallHeldCents, 400000);
});
test('unknown can become reviewed without replaying the original receipt', () => {
  const p = policy(); const items = [tx(1, 1000000)];
  const first = reconcileIncome({ policy: p, evidence: evidence(items, 1000000) });
  p.updatedAt = now; p.classification.overrides.push({ transactionId: id(1), amountInCents: 1000000, regularCents: 250000, windfallCents: 750000, verifiedAt: now, reference: 'Reviewed split' });
  const second = reconcileIncome({ policy: p, ledger: first.ledger, evidence: evidence(items, 1000000) });
  assert.equal(second.availableRegularCents, 250000); assert.equal(second.windfallHeldCents, 750000); assert.equal(Object.keys(second.ledger.rows).length, 1);
});
test('classified receipts cannot be retroactively reassigned to another pool', () => {
  const p = policy(), items = [tx(1, 500000)]; const first = reconcileIncome({ policy: p, evidence: evidence(items, 500000) });
  p.updatedAt = now; p.classification.overrides.push({ transactionId: id(1), amountInCents: 500000, regularCents: 0, windfallCents: 500000, verifiedAt: now, reference: 'Changed split' });
  error(() => reconcileIncome({ policy: p, ledger: first.ledger, evidence: evidence(items, 500000) }), 'INCOME_CLASSIFICATION_CHANGED');
});
test('posted debits reduce regular money, without pretending held windfalls vanished', () => {
  const items = [tx(1, 500000), tx(2, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency'), tx(3, 100000, 'External withdrawal', null, 'MONEY_OUT')];
  const result = reconcileIncome({ policy: policy(), evidence: evidence(items, 800000) });
  assert.equal(result.availableRegularCents, 400000); assert.equal(result.windfallHeldCents, 400000);
});
test('immutable windfall intents reserve their pool even before settlement', () => {
  const items = [tx(1, 500000), tx(2, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency')];
  const result = reconcileIncome({ policy: policy(), evidence: evidence(items, 900000, { sourceSpendableCents: 800000 }), ownedTransfers: [
    { id: id(8), monthKey: '2030-02', regularCents: 0, windfallCents: 100000, amountInCents: 100000, status: 'SUBMITTING' },
  ] });
  assert.equal(result.windfallHeldCents, 300000); assert.equal(result.availableRegularCents, 500000); assert.equal(result.openingRegularCents, 500000);
});
test('a settled windfall transfer is not deducted twice from windfall receipts', () => {
  const items = [tx(1, 500000), tx(2, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency'), tx(3, 100000, 'Posted coordinator debit', null, 'MONEY_OUT')];
  const result = reconcileIncome({ policy: policy(), evidence: evidence(items, 800000), ownedTransfers: [{ id: id(8), monthKey: '2030-02', regularCents: 0, windfallCents: 100000, amountInCents: 100000, status: 'COMPLETE' }] });
  assert.equal(result.availableRegularCents, 500000); assert.equal(result.windfallHeldCents, 300000);
});
test('pending credits are excluded from the percentage basis', () => {
  const result = reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 500000)], 500000, { sourceSpendableCents: 450000, pendingExternalIncomeCreditCents: 50000 }) });
  assert.equal(result.openingRegularCents, 450000); assert.equal(result.availableRegularCents, 450000);
});
for (const [name, mutate, code] of [
  ['unknown opening', p => { p.opening = { status: 'unverified' }; }, 'INCOME_OPENING_UNVERIFIED'],
  ['invalid opening partition', p => { p.opening.incomeBalanceCents = 1; }, 'MONTHLY_OPENING_PARTITION_INVALID'],
  ['future policy', p => { p.updatedAt = '2030-03-01T00:00:00Z'; }, 'INCOME_POLICY_FROM_FUTURE'],
]) test(name, () => { const p = policy(); mutate(p); error(() => reconcileIncome({ policy: p, evidence: evidence([], 0) }), code); });
for (const [name, mutate, code] of [
  ['truncated history', e => { e.externalTransactions.window.truncated = true; }, 'INCOME_HISTORY_INCOMPLETE'],
  ['incomplete history', e => { e.externalTransactions.complete = false; }, 'INCOME_HISTORY_INCOMPLETE'],
  ['unexplained balance', e => { e.sourceBalanceCents = 1; }, 'INCOME_BALANCE_RECONCILIATION_REQUIRED'],
  ['coverage gap', e => { e.externalTransactions.window.from = at; }, 'INCOME_HISTORY_GAP'],
  ['too much spendable', e => { e.sourceSpendableCents = 1; }, 'INCOME_SPENDABLE_EXCEEDS_BALANCE'],
]) test(name, () => { const e = evidence([], 0); mutate(e); error(() => reconcileIncome({ policy: policy(), evidence: e }), code); });
test('external bank activity newer than cash snapshot cannot fund a plan', () => {
  error(() => reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 500000)], 500000, { incomeBalanceUpdatedAt: openingAt }) }), 'INCOME_BALANCE_BEFORE_POSTED_ACTIVITY');
});
test('duplicate bank rows cannot count a bonus twice', () => {
  error(() => reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 500000), tx(1, 500000)], 1000000) }), 'INCOME_TRANSACTION_WINDOW_INVALID');
});
test('missing protected cash stops allocation after a manual withdrawal', () => {
  error(() => reconcileIncome({ policy: policy(), evidence: evidence([tx(1, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency'), tx(2, 100000, 'Withdrawal', null, 'MONEY_OUT')], 300000) }), 'INCOME_PROTECTED_CASH_MISSING');
});
test('immutable request partitions cannot overdraw the windfall pool', () => {
  error(() => reconcileIncome({ policy: policy(), evidence: evidence([], 0), ownedTransfers: [{ id: id(9), monthKey: '2030-02', regularCents: 0, windfallCents: 100, amountInCents: 100 }] }), 'INCOME_WINDFALL_OVERCOMMITTED');
});
test('overlap replay is idempotent and scan starts seven days before its checkpoint', () => {
  const p = policy(), e = evidence([tx(1, 500000)], 500000); const a = reconcileIncome({ policy: p, evidence: e });
  const b = reconcileIncome({ policy: p, ledger: a.ledger, evidence: e });
  assert.deepEqual(a, b); assert.equal(incomeScanFrom(p, a.ledger), '2030-01-25T15:00:00.000Z');
});
test('a previously recorded transaction missing from an overlap needs review', () => {
  const p = policy(); const a = reconcileIncome({ policy: p, evidence: evidence([tx(1, 500000)], 500000) });
  error(() => reconcileIncome({ policy: p, ledger: a.ledger, evidence: evidence([], 500000) }), 'INCOME_TRANSACTION_DISAPPEARED');
});
test('private source returns a typed blocker without exposing SDK credentials', async () => {
  const result = await resolveMonthlyPolicy({ monthly: { enabled: true } }, { getAll: async () => { throw new Error('secret credential'); } });
  assert.deepEqual(result, { monthlyPolicy: null, monthlyPolicyError: 'MONTHLY_POLICY_UNAVAILABLE' });
});
test('private source reads only its key and does not make partial policy assumptions', async () => {
  let keys; const result = await resolveMonthlyPolicy({ monthly: { enabled: true } }, { now: Date.parse(now), getAll: async k => { keys = k; return { monthly_policy: policy() }; } });
  assert.deepEqual(keys, ['monthly_policy']); assert.equal(result.monthlyPolicyError, null);
});
test('an unclassified opening must be resolved before creating the permanent baseline', () => {
  const p = policy(); Object.assign(p.opening, { incomeBalanceCents: 100, unknownCents: 100 });
  error(() => parseMonthlyPolicy(p), 'MONTHLY_OPENING_CLASSIFICATION_REQUIRED');
});
test('payroll rules require evidence that the signature excludes bonuses', () => {
  const p = policy(); delete p.classification.rules[0].excludesBonuses;
  error(() => parseMonthlyPolicy(p), 'MONTHLY_PAYROLL_SIGNATURE_UNVERIFIED');
});
test('source objects are bounded and source reads time out without leaking diagnostics', async () => {
  const p = policy(); p.padding = 'x'.repeat(500001);
  error(() => parseMonthlyPolicy(p), 'MONTHLY_POLICY_TOO_LARGE');
  const r = await resolveMonthlyPolicy({ monthly: { enabled: true } }, { timeoutMs: 2, getAll: () => new Promise(() => {}) });
  assert.equal(r.monthlyPolicyError, 'MONTHLY_SOURCE_TIMEOUT');
});
test('normalized midnight timestamps are rejected', () => {
  const p = policy(); p.updatedAt = '2030-01-01T24:00:00Z';
  error(() => parseMonthlyPolicy(p), 'MONTHLY_POLICY_TIME_INVALID');
});
test('a late December windfall stays protected after year rollover', () => {
  const p = policy(); p.updatedAt = '2030-12-20T12:00:00Z';
  p.opening.asOf = p.updatedAt;
  const receipt = { ...tx(1, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency'), transactionDate: '2030-12-28T12:00:00Z' };
  const e = evidence([receipt], 400000, { observedAt: '2031-01-01T15:00:00Z', incomeBalanceUpdatedAt: '2031-01-01T15:00:00Z' });
  e.externalTransactions.window = { from: p.updatedAt, to: e.observedAt, truncated: false };
  const r = reconcileIncome({ policy: p, evidence: e });
  assert.equal(r.windfallHeldCents, 0); assert.equal(r.priorYearWindfallHeldCents, 400000); assert.equal(r.availableRegularCents, 0);
  assert.ok(r.alerts.some(a => a.code === 'PRIOR_YEAR_WINDFALL_REVIEW_REQUIRED'));
});
test('a new-year request cannot consume prior-year windfall authorization', () => {
  const p = policy(); p.updatedAt = '2030-12-20T12:00:00Z'; p.opening.asOf = p.updatedAt;
  const e = evidence([{ ...tx(1, 400000, 'SYNTHETIC TAX REFUND', 'Synthetic Tax Agency'), transactionDate: '2030-12-28T12:00:00Z' }], 400000,
    { observedAt: '2031-01-01T15:00:00Z', incomeBalanceUpdatedAt: '2031-01-01T15:00:00Z' });
  e.externalTransactions.window = { from: p.updatedAt, to: e.observedAt, truncated: false };
  error(() => reconcileIncome({ policy: p, evidence: e, ownedTransfers: [{ id: '2031-01:roth-ira', monthKey: '2031-01', amountInCents: 100, regularCents: 0, windfallCents: 100 }] }), 'INCOME_WINDFALL_YEAR_OVERCOMMITTED');
});
