/** Pure, cent-exact monthly priority arithmetic. No provider or ledger writes.
 *
 * availableRegularCents is BEFORE the explicit incomeReserveCents deduction.
 * openingRegularCents is the frozen opening regular pool, excluding windfalls;
 * both percentage targets use this same unchanged base. Pending/unavailable
 * cash must already be excluded by the caller. Funded/reserved month totals
 * refer only to coordinator obligations; verified outside IRA contributions
 * are accounted for in roth.annualRemainingCents, not counted again here.
 *
 * Every eligible month of this calendar year is represented. A missed Project
 * basis is null, never an invented zero. Prior targets are frozen ledger facts.
 * The engine enforces first-day timing and firstEligibleMonth prospectively.
 */

export const MONTHLY_ALLOCATION_IDS = Object.freeze([
  'bills', 'general-spending', 'emergency-fund', 'roth-ira', 'project-savings', 'personal-investment',
]);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export class MonthlyPlanError extends Error {
  constructor(code) { super(code); this.name = 'MonthlyPlanError'; this.code = code; }
}
const fail = code => { throw new MonthlyPlanError(code); };

function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('MONTHLY_PLAN_INPUT_INVALID');
}
function cents(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('MONTHLY_PLAN_AMOUNT_INVALID');
  return value;
}
function sum(...values) {
  const total = values.reduce((result, value) => result + BigInt(cents(value)), 0n);
  if (total > MAX_SAFE) fail('MONTHLY_PLAN_AMOUNT_OVERFLOW');
  return Number(total);
}
function month(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) ||
      Number(value.slice(0, 4)) < 2000 || Number(value.slice(0, 4)) > 9998) {
    fail('MONTHLY_PLAN_MONTH_INVALID');
  }
  return value;
}
function cashTarget(value) {
  shape(value, ['targetCents', 'balanceCents']);
  const targetCents = cents(value.targetCents), balanceCents = cents(value.balanceCents);
  return { targetCents, balanceCents, gapCents: Math.max(0, targetCents - balanceCents) };
}

export function monthlyPercentageTargets(openingRegularCents) {
  const opening = BigInt(cents(openingRegularCents));
  return { emergencyCents: Number(opening * 75n / 1000n), projectCents: Number(opening * 5n / 100n) };
}

function obligations(values, expectedMonths) {
  if (!Array.isArray(values) || values.length !== expectedMonths.length) fail('MONTHLY_PLAN_MONTH_COVERAGE_INVALID');
  const rows = values.map(value => {
    shape(value, ['monthKey', 'targetCents', 'fundedCents', 'reservedCents']);
    const monthKey = month(value.monthKey), targetCents = value.targetCents === null ? null : cents(value.targetCents);
    const fundedCents = cents(value.fundedCents), reservedCents = cents(value.reservedCents);
    const used = sum(fundedCents, reservedCents);
    if (targetCents !== null && used > targetCents) fail('MONTHLY_PLAN_OBLIGATION_OVERFUNDED');
    return { monthKey, targetCents, fundedCents, reservedCents,
      outstandingCents: targetCents === null ? null : targetCents - used, plannedCents: 0 };
  }).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  if (rows.some((row, index) => row.monthKey !== expectedMonths[index])) fail('MONTHLY_PLAN_MONTH_COVERAGE_INVALID');
  // Bound aggregates before any allocation arithmetic.
  sum(...rows.map(row => row.targetCents ?? 0));
  sum(...rows.map(row => row.fundedCents));
  sum(...rows.map(row => row.reservedCents));
  sum(...rows.flatMap(row => [row.fundedCents, row.reservedCents]));
  return rows;
}

function totals(rows, currentMonth) {
  const unknownMonths = rows.filter(row => row.targetCents === null).map(row => row.monthKey);
  const prior = rows.filter(row => row.monthKey < currentMonth);
  const knownOutstandingCents = sum(...rows.map(row => row.outstandingCents ?? 0));
  return {
    monthlyTargetCents: rows.find(row => row.monthKey === currentMonth).targetCents,
    annualTargetCents: unknownMonths.length ? null : sum(...rows.map(row => row.targetCents)),
    knownAnnualTargetCents: sum(...rows.map(row => row.targetCents ?? 0)),
    fundedCents: sum(...rows.map(row => row.fundedCents)),
    reservedCents: sum(...rows.map(row => row.reservedCents)),
    priorOutstandingCents: prior.some(row => row.targetCents === null) ? null : sum(...prior.map(row => row.outstandingCents)),
    knownOutstandingCents,
    outstandingBeforeCents: unknownMonths.length ? null : knownOutstandingCents,
    unknownMonths,
  };
}

function attribute(rows, amount, bucket, currentOnly = null) {
  let remaining = amount;
  const result = [];
  for (const row of rows) {
    if (row.targetCents === null || currentOnly && row.monthKey !== currentOnly) continue;
    const part = Math.min(remaining, row.outstandingCents - row.plannedCents);
    if (part > 0) {
      result.push({ monthKey: row.monthKey, amountInCents: part, bucket });
      row.plannedCents += part;
      remaining -= part;
    }
    if (remaining === 0) break;
  }
  if (remaining !== 0) fail('MONTHLY_PLAN_ATTRIBUTION_INVALID');
  return result;
}

/** One frozen plan per first-day opportunity. Annual close is month 12 by
 * default; windfalls remain held in every other month. This function never
 * assigns a January payment to a previous year's Roth contribution target.
 */
export function planMonthlyFunding(input) {
  shape(input, ['monthKey', 'firstEligibleMonth', 'openingRegularCents', 'availableRegularCents', 'windfallHeldCents',
    'bills', 'general', 'emergency', 'roth', 'project'], ['annualCloseMonth', 'incomeReserveCents']);
  const monthKey = month(input.monthKey), firstEligibleMonth = month(input.firstEligibleMonth);
  if (monthKey < firstEligibleMonth) fail('MONTHLY_PLAN_PREDATES_ACTIVATION');
  const year = Number(monthKey.slice(0, 4)), monthNumber = Number(monthKey.slice(5));
  const annualCloseMonth = Object.hasOwn(input, 'annualCloseMonth') ? input.annualCloseMonth : 12;
  if (!Number.isSafeInteger(annualCloseMonth) || annualCloseMonth < 1 || annualCloseMonth > 12) fail('MONTHLY_PLAN_CLOSE_MONTH_INVALID');
  const first = firstEligibleMonth.slice(0, 4) === monthKey.slice(0, 4) ? Number(firstEligibleMonth.slice(5)) : 1;
  const expectedMonths = Array.from({ length: monthNumber - first + 1 }, (_, index) => `${year}-${String(first + index).padStart(2, '0')}`);
  const openingRegularCents = cents(input.openingRegularCents), availableRegularCents = cents(input.availableRegularCents);
  const windfallHeldCents = cents(input.windfallHeldCents);
  const incomeReserveCents = Object.hasOwn(input, 'incomeReserveCents') ? cents(input.incomeReserveCents) : 0;
  sum(availableRegularCents, windfallHeldCents);
  const bills = cashTarget(input.bills), general = cashTarget(input.general), emergency = cashTarget(input.emergency);
  shape(input.roth, ['eligible', 'annualRemainingCents', 'months']);
  shape(input.project, ['months']);
  if (typeof input.roth.eligible !== 'boolean') fail('MONTHLY_PLAN_ROTH_ELIGIBILITY_INVALID');
  const annualRemainingCents = input.roth.annualRemainingCents === null ? null : cents(input.roth.annualRemainingCents);
  if (input.roth.eligible && annualRemainingCents === null) fail('MONTHLY_PLAN_ROTH_ROOM_UNVERIFIED');
  const rothRows = obligations(input.roth.months, expectedMonths), projectRows = obligations(input.project.months, expectedMonths);
  const roth = totals(rothRows, monthKey), project = totals(projectRows, monthKey);
  const percentages = monthlyPercentageTargets(openingRegularCents);
  if (project.monthlyTargetCents !== percentages.projectCents) fail('MONTHLY_PLAN_PROJECT_BASIS_MISMATCH');
  const annualClose = monthNumber === annualCloseMonth;
  const alerts = [], blockers = [];
  const alert = (code, allocationId, shortfallCents, severity = 'critical') => alerts.push({ code, allocationId, shortfallCents, severity });
  const lines = Object.fromEntries(MONTHLY_ALLOCATION_IDS.map(allocationId => [allocationId, {
    allocationId, regularCents: 0, windfallCents: 0, amountInCents: 0, targetCents: 0, reason: 'TARGET_SATISFIED',
  }]));
  const reserveHeldCents = Math.min(availableRegularCents, incomeReserveCents);
  const reserveShortfallCents = incomeReserveCents - reserveHeldCents;
  let regular = availableRegularCents - reserveHeldCents, windfall = windfallHeldCents;
  function useRegular(id, target) {
    const amount = Math.min(target, regular);
    lines[id].regularCents = sum(lines[id].regularCents, amount);
    regular -= amount;
    return amount;
  }
  function useWindfall(id, target) {
    const amount = Math.min(target, windfall);
    lines[id].windfallCents = sum(lines[id].windfallCents, amount);
    windfall -= amount;
    return amount;
  }
  const billsPaid = useRegular('bills', bills.gapCents), generalPaid = useRegular('general-spending', general.gapCents);
  const billsShortfallCents = bills.gapCents - billsPaid, generalShortfallCents = general.gapCents - generalPaid;
  const essentialShortfallCents = sum(billsShortfallCents, generalShortfallCents);
  const essentialShortfall = essentialShortfallCents > 0 || reserveShortfallCents > 0;
  if (billsShortfallCents) alert('BILLS_CASH_SHORTFALL', 'bills', billsShortfallCents);
  if (generalShortfallCents) alert('GENERAL_CASH_SHORTFALL', 'general-spending', generalShortfallCents);
  if (reserveShortfallCents) alert('INCOME_RESERVE_SHORTFALL', 'income', reserveShortfallCents);
  if (essentialShortfall) blockers.push('ESSENTIAL_PRIORITY_UNMET');
  lines.bills.targetCents = bills.gapCents;
  lines['general-spending'].targetCents = general.gapCents;
  const emergencyTarget = Math.min(percentages.emergencyCents, emergency.gapCents);
  const emergencyPaid = useRegular('emergency-fund', emergencyTarget);
  lines['emergency-fund'].targetCents = emergencyTarget;
  lines['emergency-fund'].monthlyTargetCents = percentages.emergencyCents;
  if (emergencyPaid < emergencyTarget) alert('EMERGENCY_CASH_SHORTFALL', 'emergency-fund', emergencyTarget - emergencyPaid);

  const unknownRothTarget = roth.unknownMonths.length > 0;
  const rothBlocked = unknownRothTarget || (!input.roth.eligible && roth.knownOutstandingCents > 0);
  const payableRoth = input.roth.eligible && !unknownRothTarget
    ? Math.min(roth.knownOutstandingCents, annualRemainingCents) : roth.knownOutstandingCents;
  const annualLimitExcludedCents = input.roth.eligible && !unknownRothTarget ? roth.knownOutstandingCents - payableRoth : 0;
  if (annualLimitExcludedCents) alert('ROTH_ANNUAL_LIMIT_CONSTRAINED', 'roth-ira', annualLimitExcludedCents, 'warning');
  if (rothBlocked) {
    const code = unknownRothTarget ? 'ROTH_TARGET_UNVERIFIED' : 'ROTH_ELIGIBILITY_UNVERIFIED';
    blockers.push(code);
    alert(code, 'roth-ira', unknownRothTarget ? null : payableRoth);
  }
  const rothAttribution = [], projectAttribution = [];
  const rothRegular = rothBlocked ? 0 : useRegular('roth-ira', payableRoth);
  rothAttribution.push(...attribute(rothRows, rothRegular, 'regular'));
  let rothUnpaid = payableRoth - rothRegular;
  const currentProjectRow = projectRows.find(row => row.monthKey === monthKey);
  const projectRegular = !rothBlocked && rothUnpaid === 0 ? useRegular('project-savings', currentProjectRow.outstandingCents) : 0;
  projectAttribution.push(...attribute(projectRows, projectRegular, 'regular', monthKey));
  let projectUnpaid = project.knownOutstandingCents - projectRegular;

  // Windfalls serve only same-year Roth/Project shortfalls, at annual close.
  // Essential deficits stop these sends; the windfall is never reassigned to Bills.
  if (annualClose && !essentialShortfall && !rothBlocked) {
    const rothWindfall = useWindfall('roth-ira', rothUnpaid);
    rothAttribution.push(...attribute(rothRows, rothWindfall, 'windfall'));
    rothUnpaid -= rothWindfall;
    if (rothUnpaid === 0) {
      const projectWindfall = useWindfall('project-savings', projectUnpaid);
      projectAttribution.push(...attribute(projectRows, projectWindfall, 'windfall'));
      projectUnpaid -= projectWindfall;
    }
  }
  const unknownProjectAtClose = annualClose && project.unknownMonths.length > 0;
  if (project.unknownMonths.length) alert('PROJECT_HISTORICAL_TARGET_UNVERIFIED', 'project-savings', null, 'warning');
  if (unknownProjectAtClose) blockers.push('PROJECT_ANNUAL_TARGET_UNVERIFIED');
  const lowerPriorityBlocked = essentialShortfall || rothBlocked || rothUnpaid > 0 || unknownProjectAtClose;
  if (!lowerPriorityBlocked) {
    useRegular('personal-investment', regular);
    if (annualClose && projectUnpaid === 0) useWindfall('personal-investment', windfall);
  }
  if (!rothBlocked && rothUnpaid > 0) alert('ROTH_CASH_SHORTFALL', 'roth-ira', rothUnpaid);
  const currentProjectUnpaid = currentProjectRow.outstandingCents - currentProjectRow.plannedCents;
  if (currentProjectUnpaid > 0) alert(rothBlocked || rothUnpaid > 0 ? 'PROJECT_ROTH_PRIORITY_UNMET' : 'PROJECT_CASH_SHORTFALL',
    'project-savings', currentProjectUnpaid, 'warning');
  if (annualClose && projectUnpaid > 0 && projectUnpaid !== currentProjectUnpaid) {
    alert('PROJECT_ANNUAL_CASH_SHORTFALL', 'project-savings', projectUnpaid, 'warning');
  }

  lines['roth-ira'].targetCents = unknownRothTarget ? null : payableRoth;
  lines['roth-ira'].monthlyTargetCents = roth.monthlyTargetCents;
  lines['roth-ira'].obligations = rothAttribution;
  lines['project-savings'].targetCents = annualClose ? project.outstandingBeforeCents : currentProjectRow.outstandingCents;
  lines['project-savings'].monthlyTargetCents = project.monthlyTargetCents;
  lines['project-savings'].obligations = projectAttribution;
  for (const line of Object.values(lines)) {
    line.amountInCents = sum(line.regularCents, line.windfallCents);
    line.reason = line.targetCents === null ? 'TARGET_UNVERIFIED' : line.targetCents === 0 ? 'TARGET_SATISFIED'
      : line.amountInCents >= line.targetCents ? 'FUNDED' : line.amountInCents > 0 ? 'PARTIALLY_FUNDED' : 'CASH_INSUFFICIENT';
  }
  if (rothBlocked) lines['roth-ira'].reason = unknownRothTarget ? 'ROTH_TARGET_UNVERIFIED' : 'ROTH_ELIGIBILITY_UNVERIFIED';
  else if (payableRoth === 0 && annualLimitExcludedCents > 0) lines['roth-ira'].reason = 'ROTH_ANNUAL_LIMIT_REACHED';
  if (rothBlocked || rothUnpaid > 0) lines['project-savings'].reason = 'ROTH_PRIORITY_UNMET';
  lines['personal-investment'].targetCents = lines['personal-investment'].amountInCents;
  lines['personal-investment'].reason = essentialShortfall ? 'ESSENTIAL_PRIORITY_UNMET' : rothBlocked || rothUnpaid > 0
    ? 'ROTH_PRIORITY_UNMET' : unknownProjectAtClose ? 'PROJECT_TARGET_UNVERIFIED'
      : lines['personal-investment'].amountInCents > 0 ? 'SURPLUS_AVAILABLE' : 'NO_SURPLUS';
  const allocations = MONTHLY_ALLOCATION_IDS.map(id => lines[id]);
  const totalPlannedCents = sum(...allocations.map(line => line.amountInCents));
  const heldRegularCents = sum(reserveHeldCents, regular), heldWindfallCents = windfall;
  if (sum(totalPlannedCents, heldRegularCents, heldWindfallCents) !== sum(availableRegularCents, windfallHeldCents)) {
    fail('MONTHLY_PLAN_CONSERVATION_INVALID');
  }
  const summary = (value, id) => ({ ...value, plannedCents: lines[id].amountInCents,
    knownOutstandingAfterCents: value.knownOutstandingCents - lines[id].amountInCents,
    outstandingAfterCents: value.unknownMonths.length ? null : value.knownOutstandingCents - lines[id].amountInCents });
  return {
    schemaVersion: 1, monthKey, year, firstEligibleMonth, annualCloseMonth, annualClose,
    openingRegularCents, availableRegularCents, windfallHeldCents, incomeReserveCents,
    percentageTargets: percentages, allocations, totalPlannedCents, heldRegularCents, heldWindfallCents,
    reserveHeldCents, reserveShortfallCents,
    heldRothCents: rothBlocked ? Math.min(regular, payableRoth) : 0,
    essentialShortfall, essentialShortfallCents, billsShortfallCents, generalShortfallCents,
    roth: { ...summary(roth, 'roth-ira'), eligible: input.roth.eligible, annualRemainingCents,
      annualLimitExcludedCents, payableOutstandingBeforeCents: unknownRothTarget ? null : payableRoth,
      payableOutstandingAfterCents: unknownRothTarget ? null : rothUnpaid },
    project: summary(project, 'project-savings'), blockers, alerts,
  };
}
