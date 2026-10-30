import { parseRothPolicy } from './roth.mjs';
import { parseRothEvidence } from './roth-evidence.mjs';

export const ROTH_CONFIG_KEYS = ['roth_policy'];
const MAX_CONFIG_BYTES = 256_000;

export class RothSourceError extends Error {
  constructor(code) { super(code); this.name = 'RothSourceError'; this.code = code; }
}

function invalid(code) { throw new RothSourceError(code); }

/** Private annual policy is independent of bill-catalog freshness. Missing
 * personal evidence blocks Roth only; it must not disable cash-account funding.
 * No account value, inferred income, or prior-year limit supplies a fallback.
 */
export async function readRothPolicy({ connectionString, getAll, now = Date.now(), timeoutMs = 10_000 } = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000 ||
      (getAll !== undefined && typeof getAll !== 'function')) invalid('ROTH_SOURCE_CONFIGURATION_INVALID');
  if (!getAll && (typeof connectionString !== 'string' || !connectionString)) invalid('ROTH_SOURCE_CONFIGURATION_REQUIRED');
  let timer, input;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RothSourceError('ROTH_SOURCE_TIMEOUT')), timeoutMs);
  });
  try {
    input = await Promise.race([(async () => {
      if (getAll) return getAll(ROTH_CONFIG_KEYS.slice(), { consistentRead: true });
      const { createClient } = await import('@vercel/global-config');
      const client = createClient(connectionString, { cache: 'no-store', staleIfError: false, disableDevelopmentCache: true });
      return client.getAll(ROTH_CONFIG_KEYS, { consistentRead: true });
    })(), timeout]);
  } catch (error) {
    if (error instanceof RothSourceError) throw error;
    // SDK diagnostics may contain a private connection string.
    invalid('ROTH_SOURCE_UNAVAILABLE');
  } finally { clearTimeout(timer); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('ROTH_SOURCE_INVALID');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input), 'utf8'); } catch { invalid('ROTH_SOURCE_INVALID'); }
  if (bytes > MAX_CONFIG_BYTES) invalid('ROTH_SOURCE_TOO_LARGE');
  const value = input.roth_policy;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some(key => !['schemaVersion', 'policy', 'evidence'].includes(key))) {
    invalid('ROTH_SOURCE_INVALID');
  }
  const policy = parseRothPolicy(value.policy);
  if (Date.parse(policy.updatedAt) > now + 300_000) invalid('ROTH_SOURCE_FUTURE_VERSION');
  const evidence = parseRothEvidence(value.evidence);
  return { policy, evidence };
}

/** Resolving an optional contribution policy never suppresses existing Bills
 * and General funding. The engine independently forbids Roth submissions and
 * retries when this result includes a policy error.
 */
export async function resolveRothPolicy(config, options) {
  if (!config.roth?.enabled) return { rothPolicy: null, rothEvidence: null };
  try {
    const { policy, evidence } = await readRothPolicy(options);
    return { rothPolicy: policy, rothEvidence: evidence };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code : 'ROTH_SOURCE_INVALID';
    return { rothPolicy: null, rothEvidence: null, rothPolicyError: code };
  }
}
