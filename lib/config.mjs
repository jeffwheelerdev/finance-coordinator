import { createHash } from 'node:crypto';

export const VERSION = '0.4.0';
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOCATION_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const ACCOUNT_KEYS = ['income', 'pod', 'general', 'bills'];
const RULE_KEYS = ['payout', 'funding', 'legacyGeneral'];

export class ConfigError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function invalid(code, message) {
  throw new ConfigError(code, message);
}

/** Convert an exact dollar string to cents without floating-point arithmetic. */
export function parseMoney(value, label = 'amount') {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    invalid('INVALID_MONEY', `${label} must be a nonnegative dollar string with at most two decimals`);
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_SAFE) invalid('INVALID_MONEY', `${label} exceeds the safe integer cents limit`);
  return Number(cents);
}

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) {
    invalid('MISSING_CONFIG', `${name} is required`);
  }
  return env[name];
}

function parseJSON(value, label) {
  if (typeof value !== 'string') invalid('INVALID_JSON', `${label} must be a JSON string`);
  try {
    return JSON.parse(value);
  } catch {
    // JSON.parse diagnostics can echo private identifiers or configuration.
    invalid('INVALID_JSON', `${label} must contain valid JSON`);
  }
}

function shape(value, requiredKeys, optionalKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('INVALID_CONFIG', `${label} must be an object`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    invalid('INVALID_CONFIG', `${label} contains an unsupported field`);
  }
  if (requiredKeys.some(key => !Object.hasOwn(value, key))) {
    invalid('INVALID_CONFIG', `${label} is missing a required field`);
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    invalid('INVALID_UUID', `${label} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

function idMap(env, name, keys) {
  const input = parseJSON(required(env, name), name);
  shape(input, keys, [], name);
  const output = Object.fromEntries(keys.map(key => [key, uuid(input[key], `${name}.${key}`)]));
  if (new Set(Object.values(output)).size !== keys.length) {
    invalid('DUPLICATE_ID', `${name} must use distinct identifiers`);
  }
  return output;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid('INVALID_INTEGER', `${label} must be a positive safe integer`);
  }
  return value;
}

function integerText(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    invalid('INVALID_INTEGER', `${label} must be a positive integer string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE) invalid('INVALID_INTEGER', `${label} exceeds the safe integer limit`);
  return positiveInteger(Number(parsed), label);
}

function target(monthlyBudgetCents, reserveMonths, label) {
  const result = BigInt(monthlyBudgetCents) * BigInt(reserveMonths);
  if (result > MAX_SAFE) invalid('INVALID_TARGET', `${label} exceeds the safe integer cents limit`);
  return Number(result);
}

function iso(value, label) {
  if (typeof value !== 'string') invalid('INVALID_TIMESTAMP', `${label} must be a timezone-qualified ISO datetime`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) invalid('INVALID_TIMESTAMP', `${label} must be a timezone-qualified ISO datetime`);
  const [, y, m, d, h, minute, second, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    invalid('INVALID_TIMESTAMP', `${label} must contain a valid calendar datetime`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid('INVALID_TIMESTAMP', `${label} must contain a valid datetime`);
  return new Date(parsed).toISOString();
}

function balanceAge(value) {
  if (value === undefined) return 26 * 3_600_000;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    invalid('INVALID_BALANCE_AGE', 'MAX_BALANCE_AGE_HOURS must be a positive decimal no greater than 26');
  }
  const hours = Number(value), milliseconds = hours * 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 26 || !Number.isSafeInteger(milliseconds)) {
    invalid('INVALID_BALANCE_AGE', 'MAX_BALANCE_AGE_HOURS must be positive, at most 26, and expressible in whole milliseconds');
  }
  return milliseconds;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function loadConfig(env = process.env) {
  const mode = required(env, 'APP_MODE');
  if (mode !== 'observe' && mode !== 'live') invalid('INVALID_MODE', 'APP_MODE must be observe or live');
  const liveFlag = env.LIVE_TRANSFERS_ENABLED === undefined ? 'false' : env.LIVE_TRANSFERS_ENABLED;
  if (liveFlag !== 'true' && liveFlag !== 'false') {
    invalid('INVALID_BOOLEAN', 'LIVE_TRANSFERS_ENABLED must be true or false');
  }
  const activationValue = env.AUTOMATION_START_AT;
  const activationAt = activationValue === undefined || activationValue === ''
    ? null : iso(activationValue, 'AUTOMATION_START_AT');
  if (mode === 'live' && activationAt === null) {
    invalid('MISSING_ACTIVATION', 'AUTOMATION_START_AT is required in live mode');
  }

  const accounts = idMap(env, 'FINANCE_ACCOUNT_IDS_JSON', ACCOUNT_KEYS);
  const rules = idMap(env, 'FINANCE_RULE_IDS_JSON', RULE_KEYS);
  const monthlyBudgetCents = parseMoney(required(env, 'GENERAL_SPENDING_MONTHLY_BUDGET'), 'GENERAL_SPENDING_MONTHLY_BUDGET');
  const reserveMonths = integerText(required(env, 'GENERAL_SPENDING_RESERVE_MONTHS'), 'GENERAL_SPENDING_RESERVE_MONTHS');
  const allocations = [{
    id: 'bills', destinationAccountId: accounts.bills,
    monthlyBudgetCents: null, reserveMonths: null, targetCents: null,
    priority: 0, enabled: true, startsAt: null,
  }, {
    id: 'general-spending', destinationAccountId: accounts.general,
    monthlyBudgetCents, reserveMonths,
    targetCents: target(monthlyBudgetCents, reserveMonths, 'General Spending target'),
    priority: 1, enabled: true, startsAt: null,
  }];

  if (env.FINANCE_ALLOCATIONS_JSON !== undefined) {
    const extras = parseJSON(env.FINANCE_ALLOCATIONS_JSON, 'FINANCE_ALLOCATIONS_JSON');
    if (!Array.isArray(extras) || extras.length > 9) {
      invalid('INVALID_ALLOCATIONS', 'FINANCE_ALLOCATIONS_JSON must be an array; at most nine additional allocations are permitted');
    }
    for (const [index, item] of extras.entries()) {
      const label = `FINANCE_ALLOCATIONS_JSON[${index}]`;
      shape(item, ['id', 'destinationAccountId', 'monthlyBudget', 'reserveMonths', 'priority'], ['enabled', 'startsAt'], label);
      if (typeof item.id !== 'string' || !ALLOCATION_ID.test(item.id) || Object.hasOwn(Object.prototype, item.id)) {
        invalid('INVALID_ALLOCATION_ID', `${label}.id must be a stable lowercase identifier of at most 64 characters`);
      }
      if (!Number.isSafeInteger(item.priority) || item.priority < 1 || item.priority >= Number.MAX_SAFE_INTEGER) {
        invalid('INVALID_PRIORITY', `${label}.priority must be a positive integer with room for the Bills priority offset`);
      }
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
        invalid('INVALID_BOOLEAN', `${label}.enabled must be a boolean`);
      }
      const cents = parseMoney(item.monthlyBudget, `${label}.monthlyBudget`);
      const months = positiveInteger(item.reserveMonths, `${label}.reserveMonths`);
      allocations.push({
        id: item.id, destinationAccountId: uuid(item.destinationAccountId, `${label}.destinationAccountId`),
        monthlyBudgetCents: cents, reserveMonths: months,
        targetCents: target(cents, months, `${label}.target`),
        // Existing optional-recipient ranks stay compatible: old rank 1 becomes
        // effective priority 2, after mandatory Bills and General Spending.
        priority: item.priority + 1, enabled: item.enabled ?? true,
        startsAt: item.startsAt === undefined || item.startsAt === null ? null : iso(item.startsAt, `${label}.startsAt`),
      });
    }
  }

  if (new Set(allocations.map(item => item.id)).size !== allocations.length ||
      new Set(allocations.map(item => item.destinationAccountId)).size !== allocations.length) {
    invalid('DUPLICATE_ALLOCATION', 'Allocation identifiers and destination accounts must be unique');
  }
  const protectedAccounts = new Set([accounts.income, accounts.pod, accounts.bills]);
  if (allocations.some(item => item.id !== 'bills' && protectedAccounts.has(item.destinationAccountId))) {
    invalid('INVALID_DESTINATION', 'Allocation destinations must be distinct from Income, the routing Pod, and Bills');
  }
  allocations.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const financial = {
    activationAt, accounts, rules, allocations,
    // The former fixed BILLS_BUFFER_TARGET environment value is intentionally
    // ignored. A validated private bill forecast must resolve this every run.
    billsBufferCents: null, calculatedBillsTarget: null,
    incomeReserveCents: parseMoney(required(env, 'INCOME_RESERVE'), 'INCOME_RESERVE'),
    maxBalanceAgeMs: balanceAge(env.MAX_BALANCE_AGE_HOURS),
  };
  const configHash = createHash('sha256').update(JSON.stringify(canonical(financial))).digest('hex');
  return { mode, liveEnabled: mode === 'live' && liveFlag === 'true', ...financial, configHash };
}

/** Attach a freshly calculated private-catalog forecast without exposing bill rows. */
export function withCalculatedBillsTarget(config, forecast) {
  if (!forecast || !Number.isSafeInteger(forecast.targetCents) || forecast.targetCents <= 0 ||
      forecast.targetCents % 50000 !== 0 || typeof forecast.catalogHash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(forecast.catalogHash) || !Number.isInteger(forecast.year) ||
      forecast.year < 1 || forecast.year > 9999 ||
      !Array.isArray(config?.allocations) || config.allocations[0]?.id !== 'bills' ||
      config.allocations[0].destinationAccountId !== config.accounts?.bills) {
    invalid('BILLS_TARGET_UNAVAILABLE', 'A valid calculated Bills target is required');
  }
  const calculatedBillsTarget = {
    targetCents: forecast.targetCents, catalogHash: forecast.catalogHash.toLowerCase(), year: forecast.year,
    catalogUpdatedAt: iso(forecast.catalogUpdatedAt, 'Bills catalog timestamp'),
    effectiveDate: typeof forecast.effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(forecast.effectiveDate)
      ? iso(`${forecast.effectiveDate}T00:00:00Z`, 'Bills forecast effective date').slice(0, 10)
      : invalid('BILLS_FORECAST_DATE_INVALID', 'Bills forecast requires a valid local calendar date'),
    ...(Number.isSafeInteger(forecast.peakMonthCents) && forecast.peakMonthCents >= 0
      ? { peakMonthCents: forecast.peakMonthCents } : {}),
  };
  const next = { ...config, billsBufferCents: forecast.targetCents, calculatedBillsTarget,
    allocations: config.allocations.map((allocation) => allocation.id === 'bills'
      ? { ...allocation, targetCents: forecast.targetCents } : { ...allocation }) };
  const { mode: _mode, liveEnabled: _live, configHash: _hash, ...financial } = next;
  next.configHash = createHash('sha256').update(JSON.stringify(canonical(financial))).digest('hex');
  return next;
}

/** Safe for an authenticated administration response: no provider IDs or secrets. */
export function summarizeConfig(config) {
  return {
    version: VERSION, mode: config.mode, liveEnabled: config.liveEnabled,
    activationAt: config.activationAt, configHash: config.configHash,
    accountAliases: ACCOUNT_KEYS.slice(), ruleAliases: RULE_KEYS.slice(),
    billsBufferCents: config.billsBufferCents, incomeReserveCents: config.incomeReserveCents,
    calculatedBillsTarget: config.calculatedBillsTarget,
    maxBalanceAgeMs: config.maxBalanceAgeMs,
    allocations: config.allocations.map(({ id, monthlyBudgetCents, reserveMonths, targetCents, priority, enabled, startsAt }) =>
      ({ id, monthlyBudgetCents, reserveMonths, targetCents, priority, enabled, startsAt })),
  };
}
