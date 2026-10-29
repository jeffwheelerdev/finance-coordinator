import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBillCatalog, forecastBills, calculateBillsTarget, applyBillObservations,
  BillsError, BILLS_ROUNDING_CENTS, BILLS_TIME_ZONE,
} from '../lib/bills.mjs';

// Synthetic obligations only. No actual merchants, account IDs or bill catalog.
const NOW = '2030-06-01T12:00:00.000Z';
const PROOF_AT = '2030-05-01T12:00:00.000Z';
const REVISION = '2030-05-02T12:00:00.000Z';
const evidence = (type = 'invoice', observedAt = PROOF_AT) => ({ type, reference: 'synthetic-invoice', observedAt });
const bill = (id = 'monthly-service', overrides = {}) => ({
  id, name: 'Example service', kind: 'expense', status: 'active',
  amountCents: 10000, frequency: 'monthly', evidence: evidence(), ...overrides,
});
const catalog = (bills = [bill()], overrides = {}) => ({
  schemaVersion: 1, timeZone: BILLS_TIME_ZONE, updatedAt: REVISION, bills, ...overrides,
});
const forecast = (input, options = {}) => forecastBills(input, { now: NOW, ...options });
const code = expected => error => error instanceof BillsError && error.code === expected;
const cancel = (effectiveOn = '2030-05-15') => ({ confirmed: true, effectiveOn, reference: 'explicit synthetic cancellation' });
const update = (input, observations) => applyBillObservations(input, observations, { updatedAt: NOW });
const observation = (billId, changes = {}, type = 'invoice', observedAt = '2030-05-31T12:00:00Z') => ({
  billId, ...changes, evidence: evidence(type, observedAt),
});

test('highest actual calendar month determines the exact $500 ceiling', () => {
  const input = catalog([
    bill('recurring', { amountCents: 325000 }),
    bill('annual', { frequency: 'annual', amountCents: 25000, anchorDate: '2028-04-30' }),
  ]);
  const result = forecast(input);
  assert.equal(result.peakMonthCents, 350000);
  assert.equal(result.targetCents, 350000);
  assert.equal(result.capCents, 350000);
  assert.equal(result.peakMonth, '2030-04');
  assert.equal(BILLS_ROUNDING_CENTS, 50000);
  assert.equal(result.annualTotalCents, 325000 * 12 + 25000);
  input.bills[1].amountCents += 1;
  assert.equal(forecast(input).targetCents, 400000);
});

test('unknown annual renewals conservatively share the already-largest known month', () => {
  const result = forecast(catalog([
    bill('base', { amountCents: 240000 }),
    bill('spring', { frequency: 'annual', amountCents: 12000, anchorDate: '2028-04-30' }),
    bill('summer', { frequency: 'annual', amountCents: 9000, anchorDate: '2028-06-15' }),
    bill('unknown-a', { frequency: 'annual', amountCents: 5000 }),
    bill('unknown-b', { frequency: 'annual', amountCents: 3000 }),
  ]));
  assert.equal(result.peakMonth, '2030-04');
  assert.equal(result.peakMonthCents, 260000);
  assert.equal(result.targetCents, 300000);
  assert.equal(result.months[5].totalCents, 249000);
  assert.equal(result.unknownAnnualCents, 8000);
  assert.equal(result.annualTotalCents, 240000 * 12 + 12000 + 9000 + 8000);
  assert.deepEqual(result.warnings.map(x => x.code), ['ANNUAL_DATE_UNKNOWN', 'ANNUAL_DATE_UNKNOWN']);
});

test('all-undated annual bills still produce one positive conservative month', () => {
  const result = forecast(catalog([bill('annual', { frequency: 'annual', amountCents: 12345 })]));
  assert.equal(result.peakMonth, '2030-01');
  assert.equal(result.annualTotalCents, 12345);
  assert.equal(result.targetCents, 50000);
  assert.equal(result.months.filter(x => x.totalCents > 0).length, 1);
});

test('quarterly and semiannual schedules keep their calendar phase', () => {
  const result = forecast(catalog([
    bill('quarter', { frequency: 'quarterly', amountCents: 1000, anchorDate: '2024-05-31' }),
    bill('half-year', { frequency: 'semiannual', amountCents: 2000, anchorDate: '2027-06-30' }),
  ]));
  assert.deepEqual(result.months.map(x => x.totalCents), [0,1000,0,0,1000,2000,0,1000,0,0,1000,2000]);
  assert.equal(result.annualTotalCents, 8000);
});

test('weekly and biweekly include a real 53rd or 27th payment instead of 52/12 averaging', () => {
  const weekly = forecast(catalog([bill('weekly', { frequency: 'weekly', anchorDate: '2026-01-01', amountCents: 100 })]), { year: 2026 });
  assert.equal(weekly.annualTotalCents, 5300);
  assert.deepEqual(weekly.months.map(x => x.totalCents), [500,400,400,500,400,400,500,400,400,500,400,500]);
  const biweekly = forecast(catalog([bill('biweekly', { frequency: 'biweekly', anchorDate: '2026-01-01', amountCents: 100 })]), { year: 2026 });
  assert.equal(biweekly.annualTotalCents, 2700);
  assert.deepEqual(biweekly.months.map(x => x.totalCents), [300,200,200,200,200,200,300,200,200,200,200,300]);
});

test('weekly calendar dates do not drift across daylight saving time', () => {
  const result = forecast(catalog([bill('weekly', { frequency: 'weekly', anchorDate: '2026-01-04', amountCents: 100 })]), { year: 2026 });
  assert.equal(result.annualTotalCents, 5200);
  assert.equal(result.months[2].totalCents, 500);
  assert.equal(result.months[10].totalCents, 500);
});

test('semimonthly means two payments every month, not biweekly', () => {
  const result = forecast(catalog([bill('twice-monthly', { frequency: 'semimonthly', dueDays: [15,31], amountCents: 100 })]), { year: 2026 });
  assert.equal(result.annualTotalCents, 2400);
  assert.ok(result.months.every(x => x.totalCents === 200));
});

test('leap-day annual renewal remains in February in a non-leap year', () => {
  const result = forecast(catalog([bill('annual', { frequency: 'annual', anchorDate: '2024-02-29' })]), { year: 2030 });
  assert.equal(result.peakMonth, '2030-02');
  assert.equal(result.annualTotalCents, 10000);
});

test('default year uses New York calendar boundaries and accepts an explicit valid year', () => {
  assert.equal(forecast(catalog(), { now: '2030-01-01T02:00:00Z' }).year, 2029);
  assert.equal(forecast(catalog(), { now: '2030-01-01T06:00:00Z' }).year, 2030);
  assert.equal(forecast(catalog(), { now: Date.parse(NOW), year: 2032 }).year, 2032);
  assert.equal(forecast(catalog(), { now: new Date(NOW) }).year, 2030);
  assert.equal(calculateBillsTarget, forecastBills);
});

test('explicit malformed years and instants cannot silently use the default', async t => {
  for (const year of [null, '2030', 0, 1999, 9999, 2030.1, NaN, Infinity, undefined]) {
    await t.test(`year ${String(year)}`, () => assert.throws(() => forecast(catalog(), { year }), code('INVALID_BILLS_YEAR')));
  }
  for (const now of [null, undefined, NaN, Infinity, new Date('invalid'), '2030-02-30T00:00:00Z', '2030-01-01']) {
    await t.test(`now ${String(now)}`, () => assert.throws(() => forecast(catalog(), { now }), error => error instanceof BillsError));
  }
});

test('uncertain bills and budget allowances stay included and carry explicit warnings', () => {
  const result = forecast(catalog([bill('uncertain', { status: 'uncertain', amountCents: 60000, evidence: evidence('budget_allowance') })]));
  assert.equal(result.targetCents, 100000);
  assert.deepEqual(result.warnings.map(x => x.code), ['UNCERTAIN_BILL_INCLUDED', 'BUDGET_ALLOWANCE_USED']);
});

test('card repayments and own transfers are excluded without excluding genuine loan expenses', () => {
  const result = forecast(catalog([
    bill('loan', { name: 'Example loan payment', amountCents: 25000 }),
    bill('card', { kind: 'card_payment', amountCents: 90000 }),
    bill('own-transfer', { kind: 'internal_transfer', amountCents: 90000 }),
  ]));
  assert.equal(result.peakMonthCents, 25000);
  assert.equal(result.includedBillCount, 1);
  assert.equal(result.warnings.filter(x => x.code === 'NON_EXPENSE_EXCLUDED').length, 2);
});

test('confirmed cancellation is excluded only once its local effective date arrives', () => {
  const input = catalog([
    bill('base', { amountCents: 1000 }),
    bill('ending', { amountCents: 90000, status: 'canceled', cancellation: cancel('2030-06-01') }),
  ]);
  const before = forecast(input, { now: '2030-06-01T02:00:00Z' });
  assert.equal(before.peakMonthCents, 91000);
  assert.equal(before.effectiveDate, '2030-05-31');
  assert.ok(before.warnings.some(x => x.code === 'FUTURE_CANCELLATION_RETAINED'));
  const after = forecast(input, { now: '2030-06-01T04:00:00Z' });
  assert.equal(after.effectiveDate, '2030-06-01');
  assert.equal(after.peakMonthCents, 1000);
  assert.equal(after.catalogHash, before.catalogHash);
  assert.equal(after.catalogUpdatedAt, before.catalogUpdatedAt);
});

test('an empty or fully excluded catalog never supplies a zero target', () => {
  assert.throws(() => forecast(catalog([])), code('INVALID_BILLS_COUNT'));
  assert.throws(() => forecast(catalog([bill('card', { kind: 'card_payment' })])), code('NO_ACTIVE_BILLS'));
  assert.throws(() => forecast(catalog([bill('ended', { status: 'canceled', cancellation: cancel() })])), code('NO_ACTIVE_BILLS'));
});

test('strict parser rejects malformed money, status, schedule and cancellation data', async t => {
  const cases = [
    [{ amountCents: 0 }, 'INVALID_BILL_AMOUNT'],
    [{ amountCents: -1 }, 'INVALID_BILL_AMOUNT'],
    [{ amountCents: 99.99 }, 'INVALID_BILL_AMOUNT'],
    [{ amountCents: '10000' }, 'INVALID_BILL_AMOUNT'],
    [{ amountCents: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_BILL_AMOUNT'],
    [{ status: false }, 'INVALID_BILL_STATUS'],
    [{ status: 'inactive' }, 'INVALID_BILL_STATUS'],
    [{ kind: 'unknown' }, 'INVALID_BILL_KIND'],
    [{ frequency: 'MONTHLY' }, 'INVALID_BILL_FREQUENCY'],
    [{ frequency: 'weekly' }, 'MISSING_BILL_ANCHOR'],
    [{ frequency: 'biweekly' }, 'MISSING_BILL_ANCHOR'],
    [{ frequency: 'quarterly' }, 'MISSING_BILL_ANCHOR'],
    [{ frequency: 'semiannual' }, 'MISSING_BILL_ANCHOR'],
    [{ frequency: 'semimonthly', dueDays: [15,15] }, 'INVALID_BILL_DUE_DAYS'],
    [{ frequency: 'semimonthly', dueDays: [0,15] }, 'INVALID_BILL_DUE_DAYS'],
    [{ dueDays: [1,15] }, 'INVALID_BILL_DUE_DAYS'],
    [{ anchorDate: '2030-02-29' }, 'INVALID_BILL_DATE'],
    [{ status: 'canceled' }, 'UNCONFIRMED_BILL_CANCELLATION'],
    [{ status: 'canceled', cancellation: { ...cancel(), confirmed: 1 } }, 'UNCONFIRMED_BILL_CANCELLATION'],
    [{ status: 'canceled', cancellation: cancel(), evidence: evidence('posted_transaction') }, 'UNCONFIRMED_BILL_CANCELLATION'],
    [{ cancellation: cancel() }, 'INVALID_BILL_STATUS'],
    [{ id: '__proto__' }, 'INVALID_BILL_ID'],
    [{ undocumented: true }, 'INVALID_BILLS_CATALOG'],
  ];
  for (const [patch, expected] of cases) await t.test(JSON.stringify(patch), () => assert.throws(() => parseBillCatalog(catalog([bill('example', patch)])), code(expected)));
});

test('catalog schema, size, duplicate IDs and evidence timestamps are bounded', () => {
  assert.throws(() => parseBillCatalog('{invalid'), code('INVALID_BILLS_JSON'));
  assert.throws(() => parseBillCatalog(' '.repeat(1_000_001)), code('BILLS_CATALOG_TOO_LARGE'));
  assert.throws(() => parseBillCatalog(catalog([bill(), bill()])), code('DUPLICATE_BILL_ID'));
  assert.throws(() => parseBillCatalog(catalog(undefined, { schemaVersion: 2 })), code('INVALID_BILLS_VERSION'));
  assert.throws(() => parseBillCatalog(catalog(undefined, { timeZone: 'UTC' })), code('INVALID_BILLS_TIME_ZONE'));
  assert.throws(() => parseBillCatalog(catalog(Array.from({ length: 251 }, (_, i) => bill(`b-${i}`)))), code('INVALID_BILLS_COUNT'));
  assert.throws(() => parseBillCatalog(catalog([bill('new', { evidence: evidence('invoice', NOW) })])), code('INCONSISTENT_BILL_TIMESTAMP'));
  assert.throws(() => parseBillCatalog(catalog(undefined, { updatedAt: '2030-05-02T25:00:00Z' })), code('INVALID_BILL_TIMESTAMP'));
});

test('overflow in monthly accumulation, annual total and ceiling is rejected', () => {
  assert.throws(() => forecast(catalog([bill('a', { amountCents: Number.MAX_SAFE_INTEGER })])), code('BILLS_AMOUNT_OVERFLOW'));
  assert.throws(() => forecast(catalog([
    bill('a', { frequency: 'annual', amountCents: Number.MAX_SAFE_INTEGER - 100000 }),
    bill('b', { frequency: 'annual', amountCents: 200000 }),
  ])), code('BILLS_AMOUNT_OVERFLOW'));
  assert.throws(() => forecast(catalog([bill('a', { amountCents: 1_000_000_000_000_000 })])), code('BILLS_AMOUNT_OVERFLOW'));
});

test('normalization and canonical hash do not depend on input key/bill ordering', () => {
  const input = catalog([bill('z'), bill('a', { frequency: 'annual', amountCents: 1234 })]);
  const copy = structuredClone(input);
  const result = forecast(input);
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.bills = [...input.bills].reverse().map(x => Object.fromEntries(Object.entries(x).reverse()));
  assert.equal(forecast(reversed).catalogHash, result.catalogHash);
  assert.equal(forecast(JSON.stringify(reversed)).catalogHash, result.catalogHash);
  assert.equal(result.catalogUpdatedAt, REVISION);
  assert.deepEqual(input, copy);
  assert.deepEqual(parseBillCatalog(input).bills.map(x => x.id), ['a','z']);
});

test('a posted amount increase is accepted, while a smaller payment cannot lower the commitment', () => {
  const input = catalog([bill('utility', { amountCents: 14000 })]);
  const increased = update(input, [observation('utility', { amountCents: 18000 }, 'posted_transaction')]);
  assert.equal(increased.catalog.bills[0].amountCents, 18000);
  assert.deepEqual(increased.changes, [{ billId: 'utility', fields: ['amountCents'] }]);
  const decreased = update(input, [observation('utility', { amountCents: 9000 }, 'posted_transaction')]);
  assert.equal(decreased.catalog.bills[0].amountCents, 14000);
  assert.equal(decreased.warnings[0].code, 'BILL_CHANGE_REQUIRES_CONFIRMATION');
  assert.equal(decreased.changes.length, 0);
  assert.equal(input.bills[0].amountCents, 14000);
});

test('user or provider evidence can verify a decrease and propagate the lower target', async t => {
  for (const type of ['invoice', 'user_confirmation', 'provider_schedule']) {
    await t.test(type, () => {
      const input = catalog([bill('obligation', { amountCents: 60000 })]);
      const result = update(input, [observation('obligation', { amountCents: 40000 }, type)]);
      assert.equal(result.catalog.bills[0].amountCents, 40000);
      assert.equal(forecast(result.catalog).targetCents, 50000);
    });
  }
});

test('unconfirmed allowance changes preserve the previous financial policy', () => {
  const result = update(catalog(), [observation('monthly-service', { amountCents: 5000 }, 'budget_allowance')]);
  assert.equal(result.catalog.bills[0].amountCents, 10000);
  assert.equal(result.warnings[0].code, 'BILL_CHANGE_REQUIRES_CONFIRMATION');
});

test('stale and same-time conflicting observations do not overwrite newer evidence', () => {
  const stale = update(catalog(), [observation('monthly-service', { amountCents: 20000 }, 'invoice', '2030-04-01T00:00:00Z')]);
  assert.equal(stale.catalog.bills[0].amountCents, 10000);
  assert.equal(stale.warnings[0].code, 'STALE_BILL_OBSERVATION');
  const conflict = update(catalog(), [observation('monthly-service', { amountCents: 20000 }, 'invoice', PROOF_AT)]);
  assert.equal(conflict.catalog.bills[0].amountCents, 10000);
  assert.equal(conflict.warnings[0].code, 'CONFLICTING_BILL_OBSERVATION');
});

test('cancellation and later reactivation both require exact identity and explicit evidence', () => {
  const input = catalog([bill('keep'), bill('ending')]);
  const canceled = update(input, [observation('ending', { status: 'canceled', cancellation: cancel() }, 'user_confirmation')]);
  assert.equal(forecast(canceled.catalog).includedBillCount, 1);
  assert.throws(() => update(input, [observation('ending', { status: 'canceled' })]), code('UNCONFIRMED_BILL_CANCELLATION'));
  assert.throws(() => update(input, [observation('ending', { status: 'canceled', cancellation: cancel() }, 'posted_transaction')]), code('UNCONFIRMED_BILL_CANCELLATION'));
  const reactivated = applyBillObservations(canceled.catalog,
    [observation('ending', { status: 'active' }, 'user_confirmation', '2030-06-02T00:00:00Z')],
    { updatedAt: '2030-06-02T12:00:00Z' });
  assert.equal(forecast(reactivated.catalog, { now: '2030-06-02T12:00:00Z' }).includedBillCount, 2);
  assert.equal(reactivated.catalog.bills.find(x => x.id === 'ending').cancellation, undefined);
});

test('schedule changes need explicit evidence rather than guessed payment cadence', () => {
  const proposed = { frequency: 'annual', anchorDate: '2030-08-20', amountCents: 120000 };
  const review = update(catalog(), [observation('monthly-service', proposed, 'posted_transaction')]);
  assert.equal(review.catalog.bills[0].frequency, 'monthly');
  assert.equal(review.warnings[0].code, 'BILL_CHANGE_REQUIRES_CONFIRMATION');
  const accepted = update(catalog(), [observation('monthly-service', proposed, 'provider_schedule')]);
  assert.equal(forecast(accepted.catalog).peakMonth, '2030-08');
  assert.equal(forecast(accepted.catalog).annualTotalCents, 120000);
});

test('malformed update batches fail atomically without mutating the input', () => {
  const input = catalog();
  const original = structuredClone(input);
  assert.throws(() => update(input, [
    observation('monthly-service', { amountCents: 20000 }),
    observation('unknown-id', { amountCents: 20000 }),
  ]), code('UNKNOWN_BILL_ID'));
  assert.deepEqual(input, original);
  assert.throws(() => update(input, [observation('monthly-service', { amountCents: 20000 }), observation('monthly-service', { amountCents: 30000 })]), code('DUPLICATE_BILL_OBSERVATION'));
  assert.throws(() => update(input, [observation('monthly-service', { amountCents: 0 })]), code('INVALID_BILL_AMOUNT'));
  assert.throws(() => update(input, [observation('monthly-service')]), code('EMPTY_BILL_OBSERVATION'));
  assert.throws(() => update(input, []), code('INVALID_BILL_OBSERVATIONS'));
  assert.throws(() => update(input, [observation('monthly-service', { dueDays: [1,15] })]), code('INVALID_BILL_DUE_DAYS'));
  assert.throws(() => update(input, [observation('monthly-service', { cancellation: cancel() })]), code('INVALID_BILL_STATUS'));
  assert.throws(() => applyBillObservations(input, [observation('monthly-service', { amountCents: 20000 })], { updatedAt: '2030-04-01T00:00:00Z' }), code('STALE_BILLS_REVISION'));
});
