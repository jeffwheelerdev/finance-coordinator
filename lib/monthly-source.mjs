import { createHash } from 'node:crypto';

export class MonthlyPolicyError extends Error {
  constructor(code) { super(code); this.name = 'MonthlyPolicyError'; this.code = code; }
}
const fail = code => { throw new MonthlyPolicyError(code); };
const record = x => x && typeof x === 'object' && !Array.isArray(x);
const cents = x => { if (!Number.isSafeInteger(x) || x < 0) fail('MONTHLY_POLICY_AMOUNT_INVALID'); return x; };
const text = x => { if (typeof x !== 'string' || !x.trim() || x.length > 1000 || /[\x00-\x1f\x7f]/.test(x)) fail('MONTHLY_POLICY_TEXT_INVALID'); return x.trim(); };
const uuid = x => { if (typeof x !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x)) fail('MONTHLY_POLICY_TRANSACTION_ID_INVALID'); return x.toLowerCase(); };
function shape(x, required, optional = []) {
  if (!record(x) || required.some(k => !Object.hasOwn(x, k)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k))) fail('MONTHLY_POLICY_INVALID');
}
function stamp(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(x) || !Number.isFinite(Date.parse(x))) fail('MONTHLY_POLICY_TIME_INVALID');
  const d = x.slice(0, 10); if (new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) fail('MONTHLY_POLICY_TIME_INVALID');
  return new Date(x).toISOString();
}
function sum(...xs) {
  const n = xs.reduce((a, b) => a + BigInt(cents(b)), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('MONTHLY_POLICY_AMOUNT_OVERFLOW'); return Number(n);
}
const canonical = x => Array.isArray(x) ? x.map(canonical) : record(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const monthlyPolicyHash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');

/** Reviewed source evidence is private configuration. A merchant name alone is
 * never an authority to label a DFAS deposit as ordinary salary. */
export function parseMonthlyPolicy(input) {
  try { if (Buffer.byteLength(typeof input === 'string' ? input : JSON.stringify(input)) > 500_000) fail('MONTHLY_POLICY_TOO_LARGE'); }
  catch (error) { if (error instanceof MonthlyPolicyError) throw error; fail('MONTHLY_POLICY_INVALID'); }
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 500_000) fail('MONTHLY_POLICY_TOO_LARGE');
    try { input = JSON.parse(input); } catch { fail('MONTHLY_POLICY_JSON_INVALID'); }
  }
  shape(input, ['schemaVersion', 'id', 'updatedAt', 'opening', 'classification']);
  if (input.schemaVersion !== 1 || input.id !== 'monthly-priority') fail('MONTHLY_POLICY_IDENTITY_INVALID');
  const updatedAt = stamp(input.updatedAt);
  let opening;
  if (input.opening?.status === 'unverified') {
    shape(input.opening, ['status']); opening = { status: 'unverified' };
  } else {
    shape(input.opening, ['status', 'asOf', 'incomeBalanceCents', 'regularCents', 'windfallCents', 'unknownCents', 'reference']);
    if (input.opening.status !== 'verified') fail('MONTHLY_OPENING_INVALID');
    opening = { status: 'verified', asOf: stamp(input.opening.asOf), incomeBalanceCents: cents(input.opening.incomeBalanceCents),
      regularCents: cents(input.opening.regularCents), windfallCents: cents(input.opening.windfallCents), unknownCents: cents(input.opening.unknownCents), reference: text(input.opening.reference) };
    if (sum(opening.regularCents, opening.windfallCents, opening.unknownCents) !== opening.incomeBalanceCents) fail('MONTHLY_OPENING_PARTITION_INVALID');
    if (opening.unknownCents !== 0) fail('MONTHLY_OPENING_CLASSIFICATION_REQUIRED');
  }
  shape(input.classification, ['rules', 'overrides']);
  if (!Array.isArray(input.classification.rules) || input.classification.rules.length > 100 || !Array.isArray(input.classification.overrides) || input.classification.overrides.length > 1000) fail('MONTHLY_CLASSIFICATION_INVALID');
  const rules = input.classification.rules.map(r => {
    shape(r, ['id', 'kind', 'descriptionEquals', 'merchantEquals', 'minAmountCents', 'maxAmountCents', 'verifiedAt', 'reference'], ['excludesBonuses']);
    if (!['navy-pay', 'own-transfer', 'interest', 'windfall'].includes(r.kind) || !/^[a-z][a-z0-9-]{0,63}$/.test(r.id ?? '')) fail('MONTHLY_CLASSIFICATION_INVALID');
    const result = { id: r.id, kind: r.kind, descriptionEquals: text(r.descriptionEquals), merchantEquals: r.merchantEquals === null ? null : text(r.merchantEquals),
      minAmountCents: cents(r.minAmountCents), maxAmountCents: cents(r.maxAmountCents), verifiedAt: stamp(r.verifiedAt), reference: text(r.reference),
      ...(r.kind === 'navy-pay' ? { excludesBonuses: r.excludesBonuses } : {}) };
    if (r.kind === 'navy-pay' && r.excludesBonuses !== true) fail('MONTHLY_PAYROLL_SIGNATURE_UNVERIFIED');
    if (result.minAmountCents > result.maxAmountCents) fail('MONTHLY_CLASSIFICATION_INVALID');
    return result;
  });
  const overrides = input.classification.overrides.map(r => {
    shape(r, ['transactionId', 'amountInCents', 'regularCents', 'windfallCents', 'verifiedAt', 'reference']);
    const result = { transactionId: uuid(r.transactionId), amountInCents: cents(r.amountInCents), regularCents: cents(r.regularCents),
      windfallCents: cents(r.windfallCents), verifiedAt: stamp(r.verifiedAt), reference: text(r.reference) };
    if (sum(result.regularCents, result.windfallCents) !== result.amountInCents) fail('MONTHLY_OVERRIDE_PARTITION_INVALID');
    return result;
  });
  if (new Set(rules.map(r => r.id)).size !== rules.length || new Set(overrides.map(r => r.transactionId)).size !== overrides.length) fail('MONTHLY_CLASSIFICATION_DUPLICATE');
  if ([...(opening.asOf ? [opening.asOf] : []), ...rules.map(r => r.verifiedAt), ...overrides.map(r => r.verifiedAt)].some(t => Date.parse(t) > Date.parse(updatedAt))) fail('MONTHLY_EVIDENCE_NEWER_THAN_POLICY');
  return { schemaVersion: 1, id: 'monthly-priority', updatedAt, opening, classification: { rules, overrides } };
}

export function classifyIncomeCredit(transaction, policy) {
  const amount = cents(transaction.amountInCents);
  const override = policy.classification.overrides.find(r => r.transactionId === transaction.id);
  if (override) {
    if (override.amountInCents !== amount) fail('MONTHLY_OVERRIDE_AMOUNT_MISMATCH');
    return { regularCents: override.regularCents, windfallCents: override.windfallCents, unknownCents: 0, basis: `override:${override.transactionId}` };
  }
  const matches = policy.classification.rules.filter(r => transaction.description === r.descriptionEquals &&
    (r.merchantEquals === null ? transaction.merchantName === null : transaction.merchantName === r.merchantEquals) &&
    amount >= r.minAmountCents && amount <= r.maxAmountCents);
  if (matches.length !== 1) return { regularCents: 0, windfallCents: 0, unknownCents: amount, basis: matches.length ? 'ambiguous' : 'unclassified' };
  const match = matches[0];
  // A bonus can come from DFAS too. Even a reviewed ordinary-pay rule cannot
  // silently absorb a visibly marked bonus, reimbursement or refund.
  if (match.kind === 'navy-pay' && /bonus|refund|reimburse|retro|back\s*pay|separation|severance/i.test(transaction.description)) return { regularCents: 0, windfallCents: 0, unknownCents: amount, basis: 'payroll-exception' };
  return { regularCents: match.kind === 'windfall' ? 0 : amount, windfallCents: match.kind === 'windfall' ? amount : 0, unknownCents: 0, basis: `rule:${match.id}` };
}

export async function resolveMonthlyPolicy(config, { connectionString, getAll, now = Date.now(), timeoutMs = 10000 } = {}) {
  if (!config.monthly?.enabled) return { monthlyPolicy: null, monthlyPolicyError: null };
  let timer;
  try {
    if (!Number.isFinite(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || getAll !== undefined && typeof getAll !== 'function') fail('MONTHLY_SOURCE_CONFIGURATION_INVALID');
    if (!getAll) {
      if (typeof connectionString !== 'string' || !connectionString) fail('MONTHLY_POLICY_SOURCE_REQUIRED');
      const { createClient } = await import('@vercel/global-config');
      const client = createClient(connectionString, { cache: 'no-store', staleIfError: false, disableDevelopmentCache: true });
      getAll = keys => client.getAll(keys, { consistentRead: true });
    }
    const result = await Promise.race([getAll(['monthly_policy'], { consistentRead: true }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MonthlyPolicyError('MONTHLY_SOURCE_TIMEOUT')), timeoutMs);
    })]);
    const policy = parseMonthlyPolicy(result?.monthly_policy);
    if (Date.parse(policy.updatedAt) > now) fail('MONTHLY_POLICY_FROM_FUTURE');
    return { monthlyPolicy: policy, monthlyPolicyError: null };
  } catch (error) {
    return { monthlyPolicy: null, monthlyPolicyError: error instanceof MonthlyPolicyError ? error.code : 'MONTHLY_POLICY_UNAVAILABLE' };
  } finally { clearTimeout(timer); }
}
