import { parseBillCatalog, forecastBills } from './bills.mjs';
import { withCalculatedBillsTarget } from './config.mjs';

export const BILLS_CONFIG_KEYS = ['bills_catalog', 'bills_monitor'];
export const MAX_MONITOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONFIG_BYTES = 1_000_000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export class BillsSourceError extends Error {
  constructor(code) { super(code); this.name = 'BillsSourceError'; this.code = code; }
}

function invalid(code) { throw new BillsSourceError(code); }

function instant(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) invalid(code);
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString().replace('.000Z', 'Z') !== value.replace(/\.0{1,3}Z$/, 'Z')) {
    // Nonzero fractional seconds can have fewer than three digits.
    if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid(code);
  }
  return result;
}

function validateMonitor(value, catalog, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      value.source !== 'chatgpt_finances' || value.status !== 'ok' ||
      !Array.isArray(value.reviewCodes) || value.reviewCodes.length > 50 ||
      value.reviewCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code))) {
    invalid('BILLS_MONITOR_INVALID');
  }
  const checkedAt = instant(value.checkedAt, 'BILLS_MONITOR_TIME_INVALID');
  const catalogTime = Date.parse(catalog.updatedAt);
  if (value.catalogUpdatedAt !== catalog.updatedAt) invalid('BILLS_MONITOR_CATALOG_MISMATCH');
  if (checkedAt < catalogTime || checkedAt > now + CLOCK_TOLERANCE_MS || catalogTime > now + CLOCK_TOLERANCE_MS) {
    invalid('BILLS_MONITOR_TIME_INVALID');
  }
  if (now - checkedAt > MAX_MONITOR_AGE_MS) invalid('BILLS_MONITOR_STALE');
  return { checkedAt: new Date(checkedAt).toISOString(), reviewCodes: [...new Set(value.reviewCodes)] };
}

/** Read derived bill configuration, never bank statements or credentials.
 * Global Config is not an execution lock. The private Blob ledger owns all
 * transfer serialization, immutable intents and catalog regression guards.
 */
export async function readBillsPolicy({ connectionString, getAll, now = Date.now(), timeoutMs = 10_000 } = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    invalid('BILLS_SOURCE_CONFIGURATION_INVALID');
  }
  if (getAll !== undefined && typeof getAll !== 'function') invalid('BILLS_SOURCE_CONFIGURATION_INVALID');
  if (!getAll && (typeof connectionString !== 'string' || !connectionString)) invalid('BILLS_SOURCE_CONFIGURATION_REQUIRED');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BillsSourceError('BILLS_SOURCE_TIMEOUT')), timeoutMs);
  });
  let input;
  try {
    input = await Promise.race([(async () => {
      if (getAll) return getAll(BILLS_CONFIG_KEYS.slice(), { consistentRead: true });
      const { createClient } = await import('@vercel/global-config');
      const client = createClient(connectionString, { cache: 'no-store', staleIfError: false, disableDevelopmentCache: true });
      return client.getAll(BILLS_CONFIG_KEYS, { consistentRead: true });
    })(), timeout]);
  } catch (error) {
    if (error instanceof BillsSourceError) throw error;
    // SDK errors can contain the connection string. Never propagate their text.
    invalid('BILLS_SOURCE_UNAVAILABLE');
  } finally { clearTimeout(timer); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('BILLS_SOURCE_INVALID');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { invalid('BILLS_SOURCE_INVALID'); }
  if (bytes > MAX_CONFIG_BYTES) invalid('BILLS_SOURCE_TOO_LARGE');
  const catalog = parseBillCatalog(input.bills_catalog);
  const monitor = validateMonitor(input.bills_monitor, catalog, now);
  const forecast = forecastBills(catalog, { now });
  return { catalog, forecast, monitor };
}

export async function resolveBillsConfiguration(config, options) {
  const policy = await readBillsPolicy(options);
  return { config: withCalculatedBillsTarget(config, policy.forecast), policy };
}

/** Authenticated status can report aggregate costs without exposing bill rows. */
export function summarizeBillsPolicy(policy) {
  return {
    targetCents: policy.forecast.targetCents,
    peakMonthCents: policy.forecast.peakMonthCents,
    peakMonth: policy.forecast.peakMonth,
    year: policy.forecast.year,
    effectiveDate: policy.forecast.effectiveDate,
    catalogHash: policy.forecast.catalogHash,
    catalogUpdatedAt: policy.forecast.catalogUpdatedAt,
    monitorCheckedAt: policy.monitor.checkedAt,
    reviewCodes: policy.monitor.reviewCodes,
    warningCodes: [...new Set(policy.forecast.warnings.map(warning => warning.code))],
  };
}
