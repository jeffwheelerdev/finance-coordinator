import test from 'node:test';
import assert from 'node:assert/strict';
import { planMonthlyFunding, monthlyPercentageTargets, MONTHLY_ALLOCATION_IDS } from '../lib/monthly-plan.mjs';

const obligation = (monthKey, targetCents, fundedCents = 0, reservedCents = 0) => ({ monthKey, targetCents, fundedCents, reservedCents });
function fixture(overrides = {}) {
  return {
    monthKey: '2026-11', firstEligibleMonth: '2026-11', openingRegularCents: 500000,
    availableRegularCents: 500000, windfallHeldCents: 400000,
    bills: { targetCents: 350000, balanceCents: 250000 },
    general: { targetCents: 225000, balanceCents: 125000 },
    emergency: { targetCents: 1000000, balanceCents: 900000 },
    roth: { eligible: true, annualRemainingCents: 750000, months: [obligation('2026-11', 62500)] },
    project: { months: [obligation('2026-11', 25000)] }, ...overrides,
  };
}
const line = (plan, id) => plan.allocations.find(item => item.allocationId === id);
const amounts = plan => plan.allocations.map(item => item.amountInCents);
const hasAlert = (plan, code) => plan.alerts.some(alert => alert.code === code);

test('$9,000 split into $5,000 regular plus $4,000 windfall uses only the regular percentage base', () => {
  const input = fixture(), before = structuredClone(input), plan = planMonthlyFunding(input);
  assert.deepEqual(input, before);
  assert.deepEqual(plan.allocations.map(item => item.allocationId), MONTHLY_ALLOCATION_IDS);
  assert.deepEqual(plan.percentageTargets, { emergencyCents: 37500, projectCents: 25000 });
  assert.deepEqual(amounts(plan), [100000, 100000, 37500, 62500, 25000, 175000]);
  assert.equal(plan.heldWindfallCents, 400000);
  assert.equal(plan.heldRegularCents, 0);
  assert.equal(plan.totalPlannedCents, 500000);
  assert.deepEqual(plan.blockers, []);
});

test('Bills outrank General and essential shortfalls hold annual-close windfalls', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-12', firstEligibleMonth: '2026-12',
    availableRegularCents: 150000,
    roth: { eligible: true, annualRemainingCents: 750000, months: [obligation('2026-12', 62500)] },
    project: { months: [obligation('2026-12', 25000)] } }));
  assert.deepEqual(amounts(plan), [100000, 50000, 0, 0, 0, 0]);
  assert.equal(plan.essentialShortfall, true);
  assert.equal(plan.generalShortfallCents, 50000);
  assert.equal(plan.heldWindfallCents, 400000);
  assert.ok(hasAlert(plan, 'GENERAL_CASH_SHORTFALL'));
  assert.ok(hasAlert(plan, 'ROTH_CASH_SHORTFALL'));
});

test('Emergency is capped by its balance gap and the 7.5% monthly amount', () => {
  const nearlyFull = planMonthlyFunding(fixture({ emergency: { targetCents: 1000000, balanceCents: 990000 } }));
  assert.equal(line(nearlyFull, 'emergency-fund').amountInCents, 10000);
  const empty = planMonthlyFunding(fixture({ emergency: { targetCents: 1000000, balanceCents: 0 } }));
  assert.equal(line(empty, 'emergency-fund').amountInCents, 37500);
  assert.equal(line(empty, 'roth-ira').amountInCents, 62500);
});

test('partial Roth uses remaining cash and leaves Project unpaid until a later opportunity', () => {
  const plan = planMonthlyFunding(fixture({ availableRegularCents: 270000 }));
  assert.deepEqual(amounts(plan), [100000, 100000, 37500, 32500, 0, 0]);
  assert.equal(plan.roth.outstandingAfterCents, 30000);
  assert.equal(plan.roth.payableOutstandingAfterCents, 30000);
  assert.equal(plan.project.outstandingAfterCents, 25000);
  assert.ok(hasAlert(plan, 'ROTH_CASH_SHORTFALL'));
  assert.ok(hasAlert(plan, 'PROJECT_ROTH_PRIORITY_UNMET'));
});

test('same-year Roth catch-up attributes oldest-first and counts funded and reserved exactly once', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-11', firstEligibleMonth: '2026-10',
    roth: { eligible: true, annualRemainingCents: 700000,
      months: [obligation('2026-11', 62500), obligation('2026-10', 62500, 20000, 10000)] },
    project: { months: [obligation('2026-10', 10000), obligation('2026-11', 25000)] } }));
  assert.equal(line(plan, 'roth-ira').amountInCents, 95000);
  assert.deepEqual(line(plan, 'roth-ira').obligations, [
    { monthKey: '2026-10', amountInCents: 32500, bucket: 'regular' },
    { monthKey: '2026-11', amountInCents: 62500, bucket: 'regular' },
  ]);
  assert.equal(plan.roth.annualTargetCents, 125000);
  assert.equal(plan.roth.fundedCents, 20000);
  assert.equal(plan.roth.reservedCents, 10000);
  assert.equal(plan.roth.outstandingAfterCents, 0);
  assert.deepEqual(line(plan, 'project-savings').obligations, [{ monthKey: '2026-11', amountInCents: 25000, bucket: 'regular' }]);
  assert.equal(plan.project.outstandingAfterCents, 10000);
});

test('December windfalls finish Roth before Project and only then release excess Personal', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-12', availableRegularCents: 270000,
    roth: { eligible: true, annualRemainingCents: 750000,
      months: [obligation('2026-11', 62500), obligation('2026-12', 62500)] },
    project: { months: [obligation('2026-11', 25000), obligation('2026-12', 25000)] } }));
  const roth = line(plan, 'roth-ira'), project = line(plan, 'project-savings');
  assert.equal(roth.regularCents, 32500);
  assert.equal(roth.windfallCents, 92500);
  assert.deepEqual(roth.obligations, [
    { monthKey: '2026-11', amountInCents: 32500, bucket: 'regular' },
    { monthKey: '2026-11', amountInCents: 30000, bucket: 'windfall' },
    { monthKey: '2026-12', amountInCents: 62500, bucket: 'windfall' },
  ]);
  assert.equal(project.regularCents, 0);
  assert.equal(project.windfallCents, 50000);
  assert.deepEqual(project.obligations, [
    { monthKey: '2026-11', amountInCents: 25000, bucket: 'windfall' },
    { monthKey: '2026-12', amountInCents: 25000, bucket: 'windfall' },
  ]);
  assert.equal(line(plan, 'personal-investment').windfallCents, 257500);
  assert.equal(plan.roth.outstandingAfterCents, 0);
  assert.equal(plan.project.outstandingAfterCents, 0);
  assert.equal(plan.totalPlannedCents, 670000);
});

test('insufficient annual windfalls leave Roth arrears and allocate no Project or Personal', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-12', availableRegularCents: 237500, windfallHeldCents: 50000,
    roth: { eligible: true, annualRemainingCents: 750000, months: [obligation('2026-11', 62500), obligation('2026-12', 62500)] },
    project: { months: [obligation('2026-11', 25000), obligation('2026-12', 25000)] } }));
  assert.equal(line(plan, 'roth-ira').amountInCents, 50000);
  assert.equal(line(plan, 'project-savings').amountInCents, 0);
  assert.equal(line(plan, 'personal-investment').amountInCents, 0);
  assert.equal(plan.roth.outstandingAfterCents, 75000);
});

test('unverified Roth permits essentials and Emergency but holds lower-priority cash', () => {
  const plan = planMonthlyFunding(fixture({ roth: { eligible: false, annualRemainingCents: null,
    months: [obligation('2026-11', 62500)] } }));
  assert.deepEqual(amounts(plan), [100000, 100000, 37500, 0, 0, 0]);
  assert.equal(plan.heldRegularCents, 262500);
  assert.equal(plan.heldRothCents, 62500);
  assert.equal(plan.heldWindfallCents, 400000);
  assert.ok(hasAlert(plan, 'ROTH_ELIGIBILITY_UNVERIFIED'));
  assert.equal(hasAlert(plan, 'ROTH_CASH_SHORTFALL'), false);
});

test('unknown statutory target is not zero and blocks lower priorities', () => {
  const plan = planMonthlyFunding(fixture({ roth: { eligible: false, annualRemainingCents: null,
    months: [obligation('2026-11', null)] } }));
  assert.equal(plan.roth.monthlyTargetCents, null);
  assert.equal(plan.roth.outstandingAfterCents, null);
  assert.equal(line(plan, 'personal-investment').amountInCents, 0);
  assert.equal(line(plan, 'project-savings').amountInCents, 0);
  assert.ok(plan.blockers.includes('ROTH_TARGET_UNVERIFIED'));
});

test('verified annual room caps payment without fabricating funded contributions or blocking priorities forever', () => {
  const plan = planMonthlyFunding(fixture({ roth: { eligible: true, annualRemainingCents: 10000,
    months: [obligation('2026-11', 62500)] } }));
  assert.equal(line(plan, 'roth-ira').amountInCents, 10000);
  assert.equal(plan.roth.annualLimitExcludedCents, 52500);
  assert.equal(plan.roth.outstandingAfterCents, 52500);
  assert.equal(plan.roth.payableOutstandingAfterCents, 0);
  assert.equal(plan.roth.fundedCents, 0);
  assert.equal(line(plan, 'project-savings').amountInCents, 25000);
  assert.ok(line(plan, 'personal-investment').amountInCents > 0);
  assert.ok(hasAlert(plan, 'ROTH_ANNUAL_LIMIT_CONSTRAINED'));
});

test('a legally exhausted annual Roth limit requires no further contribution', () => {
  const plan = planMonthlyFunding(fixture({ roth: { eligible: true, annualRemainingCents: 0,
    months: [obligation('2026-11', 62500)] } }));
  assert.equal(line(plan, 'roth-ira').amountInCents, 0);
  assert.equal(line(plan, 'roth-ira').reason, 'ROTH_ANNUAL_LIMIT_REACHED');
  assert.equal(line(plan, 'project-savings').amountInCents, 25000);
});

test('Project remains capped at this month 5% on regular cash, with prior deficits saved for annual close', () => {
  const plan = planMonthlyFunding(fixture({ firstEligibleMonth: '2026-10',
    roth: { eligible: true, annualRemainingCents: 687500,
      months: [obligation('2026-10', 62500, 62500), obligation('2026-11', 62500)] },
    project: { months: [obligation('2026-10', 30000), obligation('2026-11', 25000, 5000, 5000)] } }));
  assert.equal(line(plan, 'project-savings').amountInCents, 15000);
  assert.equal(plan.project.outstandingAfterCents, 30000);
  assert.ok(line(plan, 'personal-investment').amountInCents > 0);
});

test('unknown historical Project basis is explicit and holds annual-close surplus', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-12',
    roth: { eligible: true, annualRemainingCents: 687500,
      months: [obligation('2026-11', 62500, 62500), obligation('2026-12', 62500)] },
    project: { months: [obligation('2026-11', null), obligation('2026-12', 25000)] } }));
  assert.equal(plan.project.annualTargetCents, null);
  assert.equal(plan.project.outstandingAfterCents, null);
  assert.deepEqual(plan.project.unknownMonths, ['2026-11']);
  assert.equal(line(plan, 'project-savings').amountInCents, 25000);
  assert.equal(line(plan, 'personal-investment').amountInCents, 0);
  assert.equal(plan.heldWindfallCents, 400000);
  assert.equal(plan.heldRegularCents, 175000);
  assert.ok(hasAlert(plan, 'PROJECT_HISTORICAL_TARGET_UNVERIFIED'));
});

test('income reserve is deducted once while percentages keep the same frozen regular base', () => {
  const plan = planMonthlyFunding(fixture({ incomeReserveCents: 100000 }));
  assert.equal(plan.reserveHeldCents, 100000);
  assert.equal(plan.heldRegularCents, 100000);
  assert.equal(line(plan, 'emergency-fund').amountInCents, 37500);
  assert.equal(line(plan, 'project-savings').amountInCents, 25000);
  assert.equal(line(plan, 'personal-investment').amountInCents, 75000);
  assert.equal(plan.totalPlannedCents, 400000);
});

test('a reserve cash deficit prevents the annual windfall from being swept out', () => {
  const plan = planMonthlyFunding(fixture({ monthKey: '2026-12', firstEligibleMonth: '2026-12',
    availableRegularCents: 50000, incomeReserveCents: 100000,
    bills: { targetCents: 350000, balanceCents: 350000 },
    general: { targetCents: 225000, balanceCents: 225000 },
    roth: { eligible: true, annualRemainingCents: 750000, months: [obligation('2026-12', 62500)] },
    project: { months: [obligation('2026-12', 25000)] } }));
  assert.equal(plan.reserveShortfallCents, 50000);
  assert.equal(plan.heldWindfallCents, 400000);
  assert.deepEqual(amounts(plan), [0, 0, 0, 0, 0, 0]);
});

test('January never attributes contributions to prior-year arrears or automatically releases held windfalls', () => {
  const input = fixture({ monthKey: '2027-01', firstEligibleMonth: '2026-11',
    roth: { eligible: false, annualRemainingCents: null, months: [obligation('2027-01', null)] },
    project: { months: [obligation('2027-01', 25000)] } });
  const plan = planMonthlyFunding(input);
  assert.equal(plan.annualClose, false);
  assert.equal(plan.heldWindfallCents, 400000);
  input.roth.months.unshift(obligation('2026-12', 62500));
  assert.throws(() => planMonthlyFunding(input), { code: 'MONTHLY_PLAN_MONTH_COVERAGE_INVALID' });
});

test('annual-close month is explicit and configurable', () => {
  const plan = planMonthlyFunding(fixture({ annualCloseMonth: 11 }));
  assert.equal(plan.annualClose, true);
  assert.equal(line(plan, 'personal-investment').windfallCents, 400000);
  assert.throws(() => planMonthlyFunding(fixture({ annualCloseMonth: 13 })), { code: 'MONTHLY_PLAN_CLOSE_MONTH_INVALID' });
});

test('percentages use exact integer cents without intermediate floating-point overflow', () => {
  for (const base of [0, 1, 19, 20, 999, 123456789, Number.MAX_SAFE_INTEGER]) {
    const result = monthlyPercentageTargets(base);
    assert.equal(result.emergencyCents, Number(BigInt(base) * 75n / 1000n));
    assert.equal(result.projectCents, Number(BigInt(base) * 5n / 100n));
  }
});

test('invalid cents, aggregate overflow and contradictory obligation totals fail closed', () => {
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '500000', null]) {
    assert.throws(() => planMonthlyFunding(fixture({ availableRegularCents: value })), { code: 'MONTHLY_PLAN_AMOUNT_INVALID' });
  }
  assert.throws(() => planMonthlyFunding(fixture({ availableRegularCents: Number.MAX_SAFE_INTEGER, windfallHeldCents: 1 })),
    { code: 'MONTHLY_PLAN_AMOUNT_OVERFLOW' });
  const input = fixture(); input.roth.months[0].fundedCents = 62501;
  assert.throws(() => planMonthlyFunding(input), { code: 'MONTHLY_PLAN_OBLIGATION_OVERFUNDED' });
});

test('missing, duplicate, future and preactivation months cannot hide or create arrears', () => {
  assert.throws(() => planMonthlyFunding(fixture({ firstEligibleMonth: '2026-12' })), { code: 'MONTHLY_PLAN_PREDATES_ACTIVATION' });
  const missing = fixture({ firstEligibleMonth: '2026-10' });
  assert.throws(() => planMonthlyFunding(missing), { code: 'MONTHLY_PLAN_MONTH_COVERAGE_INVALID' });
  for (const wrong of ['2026-10', '2026-12', '2025-11']) {
    const input = fixture(); input.roth.months[0].monthKey = wrong;
    assert.throws(() => planMonthlyFunding(input), { code: 'MONTHLY_PLAN_MONTH_COVERAGE_INVALID' });
  }
  const duplicate = fixture({ firstEligibleMonth: '2026-10' });
  duplicate.roth.months.push(obligation('2026-11', 62500));
  duplicate.project.months.push(obligation('2026-10', 10000));
  assert.throws(() => planMonthlyFunding(duplicate), { code: 'MONTHLY_PLAN_MONTH_COVERAGE_INVALID' });
});

test('current Project basis and verified Roth room must be explicit and consistent', () => {
  const wrong = fixture(); wrong.project.months[0].targetCents = 45000;
  assert.throws(() => planMonthlyFunding(wrong), { code: 'MONTHLY_PLAN_PROJECT_BASIS_MISMATCH' });
  const unknown = fixture(); unknown.roth.annualRemainingCents = null;
  assert.throws(() => planMonthlyFunding(unknown), { code: 'MONTHLY_PLAN_ROTH_ROOM_UNVERIFIED' });
  assert.throws(() => planMonthlyFunding({ ...fixture(), hiddenOverride: true }), { code: 'MONTHLY_PLAN_INPUT_INVALID' });
});

test('all planned and held cents conserve the classified cash across meaningful shortage scenarios', () => {
  for (const availableRegularCents of [0, 1, 99999, 100000, 200000, 237500, 260000, 300000, 500000]) {
    for (const windfallHeldCents of [0, 1, 50000, 400000]) {
      const plan = planMonthlyFunding(fixture({ availableRegularCents, windfallHeldCents }));
      assert.equal(plan.totalPlannedCents + plan.heldRegularCents + plan.heldWindfallCents, availableRegularCents + windfallHeldCents);
      assert.equal(line(plan, 'project-savings').regularCents <= 25000, true);
      assert.equal(line(plan, 'roth-ira').amountInCents <= 62500, true);
    }
  }
});
