import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { monthlyFixture } from '../test/monthly-fixture.mjs';
import { makeConfig, makeRothPolicy } from '../test/fixtures.mjs';
import { monthlyOwnedTransfers, summarizeMonthlyState } from '../lib/monthly-engine.mjs';
import { MONTHLY_ALLOCATION_IDS } from '../lib/monthly-plan.mjs';
import { VERSION } from '../lib/config.mjs';

// Future dates and IRA limits below are synthetic test inputs, not tax advice
// or claims about a future IRS limit. This runner has no production credentials.
function fixture(options = {}) {
  const s = monthlyFixture({ bills: 350000, general: 225000, emergency: 1000000, ...options });
  s.config = makeConfig({ ...s.config, incomeReserveCents: 0, billsBufferCents: 350000,
    allocations: s.config.allocations.map(row => row.id === 'bills' ? { ...row, targetCents: 350000 }
      : { ...row, monthlyBudgetCents: 75000, reserveMonths: 3, targetCents: 225000 }),
    calculatedBillsTarget: { ...s.config.calculatedBillsTarget, targetCents: 350000, peakMonthCents: 340000 } });
  return s;
}
const cycle = (s, key) => s.store.value.monthly.cycles[key];
const amount = (s, key, id) => cycle(s, key).children[id].amountInCents;
const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
function submittedOrder(s, from) {
  const ids = Object.fromEntries(MONTHLY_ALLOCATION_IDS.map(id => [id, id === 'bills' ? s.config.accounts.bills
    : id === 'general-spending' ? s.config.accounts.general : id === 'emergency-fund' ? s.config.accounts.emergency
      : id === 'roth-ira' ? s.config.roth.accountId : id === 'project-savings' ? s.config.monthly.projectAccountId : s.config.monthly.personalAccountId]));
  const order = s.client.creates.slice(from).map(row => Object.keys(ids).find(id => ids[id] === row.request.destinationAccountId));
  assert.deepEqual(order, [...order].sort((a, b) => MONTHLY_ALLOCATION_IDS.indexOf(a) - MONTHLY_ALLOCATION_IDS.indexOf(b)));
  return order;
}

async function fullYear() {
  const receipts = [50000, 90000, 20000, 120000, 100000, 100000, 100000, 100000, 100000, 100000, 100000, 20000];
  const s = fixture({ regular: receipts[0] }), months = [];
  for (let month = 1; month <= 12; month += 1) {
    const key = `2030-${String(month).padStart(2, '0')}`;
    s.advance(`${key}-01T15:00:00.000Z`);
    if (month > 1) s.deposit(receipts[month - 1]);
    if (month === 3) s.deposit(300000, 'BONUS');
    if (month === 11) s.deposit(100000, 'BONUS');
    const before = s.client.creates.length;
    assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
    const current = cycle(s, key), ids = submittedOrder(s, before);
    assert.equal(current.plan.openingRegularCents, receipts[month - 1]);
    assert.equal(current.plan.percentageTargets.projectCents, Math.floor(receipts[month - 1] * 0.05));
    const owned = monthlyOwnedTransfers(s.store.value).filter(row => row.monthKey === key);
    if (month < 12) assert.equal(total(owned, 'windfallCents'), 0);
    months.push({ monthKey: key, normalOpeningCents: current.plan.openingRegularCents, order: ids,
      rothCents: amount(s, key, 'roth-ira'), projectCents: amount(s, key, 'project-savings'),
      personalCents: amount(s, key, 'personal-investment'), windfallUsedCents: total(owned, 'windfallCents') });
    await s.run(); assert.equal(s.client.creates.length, before + ids.length);
    s.settleAll(); assert.equal((await s.run()).code, 'MONTHLY_CYCLE_COMPLETE');
  }
  assert.equal(amount(s, '2030-01', 'roth-ira'), 50000);
  assert.equal(amount(s, '2030-02', 'roth-ira'), 75000);
  assert.deepEqual(cycle(s, '2030-02').children['roth-ira'].obligations.map(row => [row.monthKey, row.amountInCents]),
    [['2030-01', 12500], ['2030-02', 62500]]);
  const summary = summarizeMonthlyState({ config: s.config, state: s.store.value, now: s.clock.value });
  assert.deepEqual([summary.roth.targetCents, summary.roth.settledCents, summary.roth.reservedCents], [750000, 750000, 0]);
  assert.deepEqual([summary.project.targetCents, summary.project.settledCents, summary.project.reservedCents], [50000, 50000, 0]);
  const december = cycle(s, '2030-12');
  assert.equal(december.children['roth-ira'].windfallCents, 42500);
  assert.equal(december.children['project-savings'].windfallCents, 4500);
  assert.equal(december.children['personal-investment'].windfallCents, 353000);
  assert.equal(summary.windfallHeldCents, 0);
  assert.equal(s.client.accounts.get(s.config.accounts.income).balance.balanceInCents, 0);
  assert.ok(s.sent.some(row => row.code === 'ROTH_CASH_SHORTFALL'));
  return { s, receipt: { id: 'full_year_carry_and_december_close', status: 'passed', syntheticYear: 2030, months,
    annualRothCents: summary.roth.settledCents, annualProjectCents: summary.project.settledCents,
    decemberWindfallCents: { roth: 42500, project: 4500, personal: 353000 },
    duplicateRequests: 0, doubleCountedShortfalls: 0 } };
}

async function shortage() {
  const s = fixture({ regular: 600000, bills: 0, general: 0, emergency: 900000 });
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(submittedOrder(s, 0), ['bills', 'general-spending', 'emergency-fund']);
  assert.deepEqual(s.client.creates.map(row => row.request.amountInCents), [350000, 225000, 25000]);
  assert.equal(amount(s, '2030-01', 'roth-ira'), 0);
  assert.ok(s.sent.some(row => row.code === 'ROTH_CASH_SHORTFALL' && row.shortfallCents === 62500));

  const partial = fixture({ regular: 45000 });
  let attempts = 0;
  const sender = partial.sendAlert;
  partial.sendAlert = async row => { attempts += 1; if (attempts === 1) throw new Error('Synthetic mail timeout'); return sender(row); };
  await partial.run();
  assert.equal(amount(partial, '2030-01', 'roth-ira'), 45000);
  assert.equal(partial.client.creates.length, 1);
  const pending = Object.values(partial.store.value.monthly.alerts).find(row => row.code === 'ROTH_CASH_SHORTFALL');
  assert.equal(pending.shortfallCents, 17500);
  await partial.run();
  assert.equal(partial.client.creates.length, 1);
  assert.equal(partial.sent.filter(row => row.id === pending.id).length, 1);
  return { id: 'priority_shortage_and_partial_roth', status: 'passed',
    orderedEssentialPaymentsCents: [350000, 225000, 25000], partialRothCents: 45000,
    rothShortfallCents: 17500, lowerInvestmentRequests: 0, emailOutagePreventedPartial: false };
}

async function uncertainty() {
  const s = fixture({ regular: 1000000, bills: 300000, general: 200000, emergency: 900000 });
  s.client.onCreate = () => { throw new Error('Synthetic response missing before provider acceptance'); };
  assert.equal((await s.run()).code, 'MONTHLY_SUBMISSION_UNKNOWN');
  assert.equal(s.client.creates.length, 1);
  const intent = structuredClone(s.client.creates[0]);
  s.clock.advance(61000); s.client.onCreate = null;
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  assert.deepEqual(s.client.creates[1], intent);
  assert.equal(s.client.accepted.size, 6);

  const accepted = fixture({ regular: 1000000, bills: 300000 });
  accepted.client.onCreate = row => { accepted.client.acceptIntent(row); throw new Error('Synthetic accepted response lost'); };
  await accepted.run(); accepted.clock.advance(61000);
  await accepted.run();
  assert.equal(accepted.client.creates.length, 1);
  assert.equal(accepted.client.accepted.size, 1);

  const failed = fixture({ regular: 1000000, bills: 300000 });
  failed.client.onCreate = row => ({ ...failed.client.acceptIntent(row), status: 'ERROR', errorCode: 'SYNTHETIC_FAILURE' });
  assert.equal((await failed.run()).code, 'MONTHLY_TRANSFER_FAILED');
  assert.equal(failed.client.creates.length, 1);
  return { id: 'provider_uncertain_and_failed_outcomes', status: 'passed', exactRecoveryBodyAndKey: true,
    acceptedUnknownRequests: 1, laterRequestsAfterUnknown: 0, laterRequestsAfterFailure: 0 };
}

async function schedule() {
  const s = fixture({ regular: 1000000 });
  s.advance('2030-01-01T14:59:59.000Z');
  await s.run(); assert.equal(s.client.creates.length, 0);
  s.advance('2030-01-01T15:00:00.000Z'); await s.run();
  const count = s.client.creates.length; assert.ok(count > 0);
  s.deposit(500000); await s.run(); assert.equal(s.client.creates.length, count);
  assert.equal(cycle(s, '2030-01').plan.openingRegularCents, 1000000);
  s.advance('2030-01-02T15:00:00.000Z'); s.settleAll(); await s.run();
  assert.equal(s.client.creates.length, count); assert.equal(cycle(s, '2030-01').status, 'COMPLETE');
  const cutoff = fixture({ regular: 1000000, activationAt: '2030-01-01T15:00:01.000Z' });
  cutoff.advance('2030-01-01T15:05:00.000Z'); await cutoff.run();
  assert.equal(cutoff.client.creates.length, 0);
  cutoff.advance('2030-02-01T15:00:00.000Z'); await cutoff.run();
  assert.equal(amount(cutoff, '2030-02', 'roth-ira'), 62500);
  assert.deepEqual(Object.keys(cutoff.store.value.monthly.obligations), ['2030-02']);
  return { id: 'first_day_schedule_and_prospective_activation', status: 'passed',
    requestsBeforeDue: 0, duplicateWakeupRequests: 0, offDayNewRequests: 0,
    lateDepositConsumedByFrozenCycleCents: 0, historicalCatchupBeforeActivationCents: 0 };
}

async function yearTransition(s) {
  const previousTotal = s.client.creates.length;
  s.advance('2030-12-20T15:00:00.000Z'); s.deposit(20000, 'BONUS'); await s.run();
  s.advance('2031-01-01T15:00:00.000Z'); s.deposit(100000);
  s.config = makeConfig({ ...s.config, calculatedBillsTarget: { ...s.config.calculatedBillsTarget,
    year: 2031, effectiveDate: '2031-01-01', catalogUpdatedAt: '2030-12-31T00:00:00.000Z', catalogHash: 'b'.repeat(64) } });
  await s.run();
  assert.equal(s.client.creates.length, previousTotal);
  assert.ok(cycle(s, '2031-01').plan.rothBlockers.includes('ROTH_STATUTORY_LIMIT_UNVERIFIED'));
  assert.equal(cycle(s, '2031-01').plan.openingRegularCents, 100000);
  assert.equal(s.store.value.monthly.income.windfallReceivedByYear[2030] - s.store.value.monthly.income.windfallReservedByYear[2030], 20000);
  const next = makeRothPolicy(2031, { annualCents: 800000 });
  s.rothPolicy = { ...next, statutoryLimits: [...s.rothPolicy.statutoryLimits, ...next.statutoryLimits], years: [...s.rothPolicy.years, ...next.years] };
  s.advance('2031-02-01T15:00:00.000Z'); s.deposit(150000);
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED');
  const feb = cycle(s, '2031-02');
  assert.equal(feb.children['roth-ira'].amountInCents, 133333);
  assert.deepEqual(feb.children['roth-ira'].obligations.map(row => [row.monthKey, row.amountInCents]),
    [['2031-01', 66666], ['2031-02', 66667]]);
  assert.ok(monthlyOwnedTransfers(s.store.value).filter(row => row.monthKey.startsWith('2031')).every(row => row.windfallCents === 0));
  return { id: 'year_transition_and_new_annual_limit', status: 'passed', requestsWithMissingNewYearPolicy: 0,
    priorYearWindfallHeldCents: 20000, priorYearRothReplayCents: 0,
    syntheticNextYearLimitCents: 800000, newYearCatchupCents: 133333, exactCentInstallments: [66666, 66667] };
}

/** No-network rehearsal of the actual financial engine with fake providers.
 * fetch is an explicit tripwire; every provider object is in memory, and no
 * production adapter, environment reader or alert transport is constructed. */
export async function runMonthlyRehearsal() {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error('REHEARSAL_NETWORK_FORBIDDEN'); };
  try {
    const annual = await fullYear();
    const scenarios = [annual.receipt, await shortage(), await uncertainty(), await schedule(), await yearTransition(annual.s)];
    assert.equal(networkAttempts, 0);
    return { schemaVersion: 1, suite: 'monthly-activation-rehearsal-v1', softwareVersion: VERSION,
      status: 'passed', deterministic: true, syntheticDataOnly: true, networkAttempts, realTransfers: 0, realEmails: 0,
      scenarioCount: scenarios.length, scenarios,
      resultHash: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'),
      limitations: ['Synthetic provider acceptance and settlement do not prove real transfer permission.',
        'Synthetic alerts do not prove real email delivery.', 'Live activation readiness is checked separately.'] };
  } finally { globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runMonthlyRehearsal())); }
  catch { console.error(JSON.stringify({ schemaVersion: 1, suite: 'monthly-activation-rehearsal-v1', status: 'failed',
    code: 'REHEARSAL_FAILED', realTransfers: 0, realEmails: 0 })); process.exitCode = 1; }
}
