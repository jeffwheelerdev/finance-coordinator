/** The shared monthly calendar. Settings change future opportunities, never
 * the identity of a calendar month's already-frozen financial cycle. */
export const MONTHLY_TIME_ZONE = 'America/New_York';
export const MONTHLY_CHECK_HOUR_UTC = 15;
const MONTH = /^(?:[2-9]\d{3})-(?:0[1-9]|1[0-2])$/;
const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: MONTHLY_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit' });
const timeParts = new Intl.DateTimeFormat('en-CA', { timeZone: MONTHLY_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fail = code => { throw Object.assign(new Error(code), { name: 'MonthlyScheduleError', code }); };
const iso = value => new Date(value).toISOString();
const part = (parts, key) => Number(parts.find(row => row.type === key)?.value);

export function validateMonthlySchedule(schedule = {}) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) fail('MONTHLY_SCHEDULE_INVALID');
  const executionDay = schedule.executionDay ?? 1, decemberDay = schedule.decemberDay ?? 1;
  if (!Number.isSafeInteger(executionDay) || executionDay < 1 || executionDay > 28 ||
      !Number.isSafeInteger(decemberDay) || decemberDay < 1 || decemberDay > 15 ||
      schedule.timeZone !== undefined && schedule.timeZone !== MONTHLY_TIME_ZONE ||
      schedule.dueHourUTC !== undefined && schedule.dueHourUTC !== MONTHLY_CHECK_HOUR_UTC) fail('MONTHLY_SCHEDULE_INVALID');
  return { executionDay, decemberDay, timeZone: MONTHLY_TIME_ZONE, dueHourUTC: MONTHLY_CHECK_HOUR_UTC };
}

export function nextMonthKey(monthKey) {
  if (!MONTH.test(monthKey ?? '')) fail('MONTHLY_SCHEDULE_MONTH_INVALID');
  const year = Number(monthKey.slice(0, 4)), month = Number(monthKey.slice(5));
  if (year >= 9998 && month === 12) fail('MONTHLY_SCHEDULE_MONTH_INVALID');
  return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
}

function localMidnight(year, month, day) {
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall;
  // New York midnight is unambiguous, including its spring/autumn transition
  // dates. Use Intl's actual zone data instead of a hardcoded UTC offset.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = timeParts.formatToParts(instant);
    const observed = Date.UTC(part(p, 'year'), part(p, 'month') - 1, part(p, 'day'), part(p, 'hour'), part(p, 'minute'), part(p, 'second'));
    const difference = wall - observed;
    if (difference === 0) return instant;
    instant += difference;
  }
  fail('MONTHLY_SCHEDULE_TIME_INVALID');
}

export function monthlySlot(monthKey, schedule = {}) {
  if (!MONTH.test(monthKey ?? '') || Number(monthKey.slice(0, 4)) > 9998) fail('MONTHLY_SCHEDULE_MONTH_INVALID');
  const parsed = validateMonthlySchedule(schedule), year = Number(monthKey.slice(0, 4)), month = Number(monthKey.slice(5));
  const dayOfMonth = month === 12 ? parsed.decemberDay : parsed.executionDay;
  const due = Date.UTC(year, month - 1, dayOfMonth, MONTHLY_CHECK_HOUR_UTC);
  const following = new Date(Date.UTC(year, month - 1, dayOfMonth + 1));
  const close = localMidnight(following.getUTCFullYear(), following.getUTCMonth() + 1, following.getUTCDate());
  return { monthKey, year, dayOfMonth, dueAt: iso(due), closesAt: iso(close),
    timeZone: MONTHLY_TIME_ZONE, checkHourUTC: MONTHLY_CHECK_HOUR_UTC };
}

export function monthlyClock(now = Date.now(), schedule = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) fail('MONTHLY_SCHEDULE_TIME_INVALID');
  const p = dateParts.formatToParts(now), year = part(p, 'year'), month = part(p, 'month'), day = part(p, 'day');
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, day, ...monthlySlot(monthKey, schedule) };
}

export function monthlyWindow(monthKey, now, schedule = {}) {
  const slot = monthlySlot(monthKey, schedule);
  return Number.isFinite(now) && now >= Date.parse(slot.dueAt) && now < Date.parse(slot.closesAt);
}

export function firstEligibleMonth(activationAt, schedule = {}) {
  const at = typeof activationAt === 'string' ? Date.parse(activationAt) : NaN;
  if (!Number.isFinite(at)) fail('MONTHLY_ACTIVATION_REQUIRED');
  const current = monthlyClock(at, schedule);
  return at <= Date.parse(current.dueAt) ? current.monthKey : nextMonthKey(current.monthKey);
}
