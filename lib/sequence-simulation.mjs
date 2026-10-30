/** Explicit provider dry runs only. This adapter has no live-request method,
 * caller-supplied request body, ledger access, rule trigger, or retry loop. */
import { randomUUID } from 'node:crypto';
import { forecastRoth } from './roth.mjs';

const ENDPOINT = 'https://api.getsequence.io/platform/v1/transfers';
const MAX_BODY_BYTES = 65_536;
const MAX_REQUESTS = 7;
const MAX_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODES = new Set([
  'SIMULATION_OPT_IN_REQUIRED', 'SIMULATION_INACTIVE_MODE_REQUIRED',
  'SIMULATION_CONFIGURATION_INVALID', 'SIMULATION_CREDENTIAL_REQUIRED',
  'SIMULATION_BILLS_POLICY_UNAVAILABLE', 'SIMULATION_ROTH_POLICY_UNVERIFIED',
  'SIMULATION_INPUT_INVALID', 'SIMULATION_TIME_INVALID', 'SIMULATION_DEADLINE_EXCEEDED',
  'SIMULATION_IDEMPOTENCY_INVALID', 'SIMULATION_NETWORK_ERROR', 'SIMULATION_REQUEST_TIMEOUT',
  'SIMULATION_REDIRECT_REJECTED', 'SIMULATION_RESPONSE_TOO_LARGE',
  'SIMULATION_RESPONSE_INVALID', 'SIMULATION_MODE_MISMATCH', 'SIMULATION_IDENTITY_MISMATCH',
  'SIMULATION_STATUS_INVALID', 'SIMULATION_PROVIDER_REJECTED', 'SIMULATION_TRANSFER_FAILED',
  'SIMULATION_FAILED',
]);
const PROVIDER_CODES = new Set([
  'ACCESS_DENIED', 'UNAUTHORIZED', 'KYC_REQUIRED', 'MAXIMUM_AMOUNT_EXCEEDED',
  'INSUFFICIENT_FUNDS', 'RATE_LIMIT_EXCEEDED', 'IDEMPOTENCY_KEY_MISMATCH',
  'INVALID_REQUEST', 'VALIDATION_ERROR', 'UNEXPECTED_ERROR', 'INTERNAL_SERVER_ERROR',
]);

export class SequenceSimulationError extends Error {
  constructor(code, { status = null, uncertain = false, providerCode = null } = {}) {
    const safe = CODES.has(code) ? code : 'SIMULATION_FAILED';
    super(safe);
    this.name = 'SequenceSimulationError';
    this.code = safe;
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    this.uncertain = uncertain === true;
    this.providerCode = PROVIDER_CODES.has(providerCode) ? providerCode : null;
  }
}
const fail = (code, details) => { throw new SequenceSimulationError(code, details); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function optionsShape(value, fields) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('SIMULATION_INPUT_INVALID');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('SIMULATION_INPUT_INVALID');
  }
}

/** Exact environment strings are deliberate: a missing/implicit false is not
 * authorization to POST, and the production financial gate must be off. */
export function assertSequenceSimulationAllowed(env, config) {
  if (!env || env.RUN_SEQUENCE_SIMULATION !== 'true') fail('SIMULATION_OPT_IN_REQUIRED');
  if (env.APP_MODE !== 'observe' || env.LIVE_TRANSFERS_ENABLED !== 'false' ||
      config && (config.mode !== 'observe' || config.liveEnabled !== false)) fail('SIMULATION_INACTIVE_MODE_REQUIRED');
}

function clock(now) {
  let value;
  try { value = now(); } catch { fail('SIMULATION_TIME_INVALID'); }
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) fail('SIMULATION_TIME_INVALID');
  return value;
}

function accountId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('SIMULATION_CONFIGURATION_INVALID');
  return value.toLowerCase();
}

function probeAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('SIMULATION_CONFIGURATION_INVALID');
  // A zero target still needs a $1 synthetic scope probe; never call it a plan.
  return Math.max(100, value);
}

function probesFor(config, rothPolicy, now) {
  if (!record(config) || config.monthly?.enabled !== true || config.roth?.enabled !== true ||
      !Array.isArray(config.allocations) || config.allocations.length !== 2) fail('SIMULATION_CONFIGURATION_INVALID');
  const roles = Object.fromEntries(Object.entries({ income: config.accounts?.income, bills: config.accounts?.bills,
    general: config.accounts?.general, emergency: config.accounts?.emergency, roth: config.roth.accountId,
    project: config.monthly.projectAccountId, personal: config.monthly.personalAccountId }).map(([key, id]) => [key, accountId(id)]));
  if (new Set(Object.values(roles)).size !== 7 ||
      config.accounts?.pod && Object.values(roles).includes(accountId(config.accounts.pod))) fail('SIMULATION_CONFIGURATION_INVALID');
  const allocation = (id, destination) => {
    const rows = config.allocations.filter(item => item.id === id);
    if (rows.length !== 1 || rows[0].enabled !== true || accountId(rows[0].destinationAccountId) !== destination) fail('SIMULATION_CONFIGURATION_INVALID');
    return rows[0].targetCents;
  };
  const bills = allocation('bills', roles.bills), general = allocation('general-spending', roles.general);
  if (!Number.isSafeInteger(bills) || bills < 50_000 || bills % 50_000 !== 0 ||
      config.calculatedBillsTarget?.targetCents !== bills) fail('SIMULATION_CONFIGURATION_INVALID');
  let roth;
  try { roth = forecastRoth(rothPolicy, { now }); }
  catch { fail('SIMULATION_ROTH_POLICY_UNVERIFIED'); }
  if (!Number.isSafeInteger(roth.statutoryBaseLimitCents) || roth.statutoryBaseLimitCents <= 0 ||
      !roth.statutoryVerifiedAt || !Number.isSafeInteger(roth.monthlyAmountCents) || roth.monthlyAmountCents < 0) {
    fail('SIMULATION_ROTH_POLICY_UNVERIFIED');
  }
  const rows = [
    ['income_to_bills', 'income', 'bills', bills, 'configured_full_target'],
    ['income_to_general', 'income', 'general', general, 'configured_full_target_minimum_one_dollar'],
    ['income_to_emergency', 'income', 'emergency', config.monthly.emergencyTargetCents, 'configured_cap_minimum_one_dollar'],
    ['income_to_roth', 'income', 'roth', roth.monthlyAmountCents, 'indicative_installment_minimum_one_dollar'],
    ['income_to_project', 'income', 'project', 25_000, 'synthetic_250_dollars'],
    ['income_to_personal', 'income', 'personal', 400_000, 'synthetic_4000_dollars'],
    ['emergency_to_income', 'emergency', 'income', 2500, 'synthetic_25_dollars'],
  ];
  return { rothYear: roth.year, probes: rows.map(([label, source, destination, amount, amountBasis]) => Object.freeze({
    label, sourceAccountId: roles[source], destinationAccountId: roles[destination],
    amountInCents: probeAmount(amount), amountBasis,
  })) };
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10);
}

async function readBounded(response) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    void response.body?.cancel?.().catch(() => {});
    fail('SIMULATION_RESPONSE_TOO_LARGE', { uncertain: true });
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('SIMULATION_RESPONSE_INVALID', { uncertain: true });
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('SIMULATION_RESPONSE_INVALID', { uncertain: true });
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        fail('SIMULATION_RESPONSE_TOO_LARGE', { uncertain: true });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function providerCode(value, apiKey) {
  return PROVIDER_CODES.has(value) && !value.includes(apiKey) ? value : null;
}

async function postSimulation({ probe, idempotencyKey, apiKey, fetchImpl, timeoutMs }) {
  // These fields are assembled here, never spread from caller input. There is
  // intentionally no boolean option or alternate branch for a live transfer.
  const body = JSON.stringify({
    sourceAccountId: probe.sourceAccountId,
    destinationAccountId: probe.destinationAccountId,
    amountInCents: probe.amountInCents,
    description: 'SIM TEST',
    simulation: true,
    simulatedSourceBalance: probe.amountInCents,
  });
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-called-reason': 'Explicit inactive finance-coordinator synthetic simulation; no real money movement' }, body });
    } catch { fail('SIMULATION_NETWORK_ERROR', { uncertain: true }); }
    const status = response?.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) fail('SIMULATION_RESPONSE_INVALID', { uncertain: true });
    let unexpectedUrl = false;
    if (response.url) {
      try { unexpectedUrl = new URL(response.url).href !== ENDPOINT; } catch { unexpectedUrl = true; }
    }
    if (response.redirected || unexpectedUrl || status >= 300 && status < 400) {
      void response.body?.cancel?.().catch(() => {});
      fail('SIMULATION_REDIRECT_REJECTED', { status, uncertain: true });
    }
    let payload;
    try { payload = JSON.parse(await readBounded(response)); }
    catch (error) {
      if (error instanceof SequenceSimulationError) throw error;
      fail('SIMULATION_RESPONSE_INVALID', { status, uncertain: true });
    }
    if (status < 200 || status >= 300) fail('SIMULATION_PROVIDER_REJECTED', {
      status, uncertain: status >= 500 || status === 409,
      providerCode: providerCode(payload?.error?.code, apiKey),
    });
    const data = payload?.data;
    if (status !== 201 || !record(data)) fail('SIMULATION_RESPONSE_INVALID', { status, uncertain: true });
    if (data.executionMode !== 'SIMULATION') fail('SIMULATION_MODE_MISMATCH', { status, uncertain: true });
    if (typeof data.id !== 'string' || !UUID.test(data.id) ||
        data.source?.id?.toLowerCase?.() !== probe.sourceAccountId ||
        data.destination?.id?.toLowerCase?.() !== probe.destinationAccountId || data.amountInCents !== probe.amountInCents) {
      fail('SIMULATION_IDENTITY_MISMATCH', { status, uncertain: true });
    }
    if (!['COMPLETE', 'INCOMPLETE', 'ERROR'].includes(data.status)) fail('SIMULATION_STATUS_INVALID', { status, uncertain: true });
    if (data.status !== 'COMPLETE') fail('SIMULATION_TRANSFER_FAILED', {
      status, providerCode: providerCode(data.errorCode, apiKey),
    });
    if (!validTimestamp(data.completedAt) || data.errorCode != null) fail('SIMULATION_RESPONSE_INVALID', { status, uncertain: true });
    return { providerId: data.id.toLowerCase(), executionMode: 'SIMULATION', providerStatus: 'COMPLETE' };
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SequenceSimulationError('SIMULATION_REQUEST_TIMEOUT', { uncertain: true }));
    }, timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

/** Returns only safe labels and test amounts. It stops at the first failure and
 * never retries, polls a transfer, or persists provider IDs/idempotency keys. */
export async function runSequenceSimulation(options) {
  optionsShape(options, ['env', 'config', 'rothPolicy', 'fetchImpl', 'now', 'uuid', 'timeoutMs']);
  const { env, config, rothPolicy, fetchImpl = globalThis.fetch, now = () => Date.now(),
    uuid = randomUUID, timeoutMs = MAX_TIMEOUT_MS } = options;
  assertSequenceSimulationAllowed(env, config);
  if (!config || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof uuid !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail('SIMULATION_INPUT_INVALID');
  const apiKey = env.SEQUENCE_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) fail('SIMULATION_CREDENTIAL_REQUIRED');
  const startedAt = clock(now), { probes, rothYear } = probesFor(config, rothPolicy, startedAt);
  if (probes.length !== MAX_REQUESTS) fail('SIMULATION_CONFIGURATION_INVALID');
  const keys = probes.map(() => {
    let key;
    try { key = uuid(); } catch { fail('SIMULATION_IDEMPOTENCY_INVALID'); }
    if (typeof key !== 'string' || !UUID_V4.test(key)) fail('SIMULATION_IDEMPOTENCY_INVALID');
    return key.toLowerCase();
  });
  if (new Set(keys).size !== MAX_REQUESTS) fail('SIMULATION_IDEMPOTENCY_INVALID');
  const receipt = { schemaVersion: 1, suite: 'sequence-provider-simulation-v1', status: 'passed',
    checkedAt: new Date(startedAt).toISOString(), syntheticProbes: true, intendedExecutionMode: 'SIMULATION',
    realTransferRequested: false, requestCount: 0, expectedProbeCount: MAX_REQUESTS,
    configuredPairCount: MAX_REQUESTS, rothPreviewYear: rothYear, results: [],
    limitations: { syntheticAmountsAreNotAPlan: true, syntheticBalancesAreNotCashEvidence: true,
      authorityTestedOnlyAtReportedAmounts: true, unlimitedAuthorityProven: false,
      humanApprovalBypassedByProvider: true, unattendedApprovalProven: false,
      rothEligibilityProven: false, bankingRailsTested: false, emailDeliveryTested: false,
      applicationLedgerModified: false, automaticRetries: 0 } };
  const seenProviderIds = new Set();
  for (const [index, probe] of probes.entries()) {
    try {
      assertSequenceSimulationAllowed(env, config);
      const remaining = startedAt + TOTAL_TIMEOUT_MS - clock(now);
      if (remaining <= 0) fail('SIMULATION_DEADLINE_EXCEEDED');
      receipt.requestCount += 1;
      const result = await postSimulation({ probe, idempotencyKey: keys[index], apiKey, fetchImpl,
        timeoutMs: Math.min(timeoutMs, remaining) });
      if (seenProviderIds.has(result.providerId)) fail('SIMULATION_IDENTITY_MISMATCH', { status: 201, uncertain: true });
      seenProviderIds.add(result.providerId);
      receipt.results.push({ label: probe.label, amountInCents: probe.amountInCents, amountBasis: probe.amountBasis,
        status: 'passed', executionMode: result.executionMode, providerStatus: result.providerStatus });
    } catch (error) {
      const safe = error instanceof SequenceSimulationError ? error : new SequenceSimulationError('SIMULATION_FAILED', { uncertain: true });
      receipt.status = 'failed';
      receipt.results.push({ label: probe.label, amountInCents: probe.amountInCents, amountBasis: probe.amountBasis,
        status: 'failed', code: safe.code, httpStatus: safe.status, uncertain: safe.uncertain,
        ...(safe.providerCode ? { providerCode: safe.providerCode } : {}) });
      receipt.notAttemptedCount = MAX_REQUESTS - receipt.requestCount;
      return receipt;
    }
  }
  receipt.notAttemptedCount = 0;
  return receipt;
}
