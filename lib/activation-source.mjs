/** Private, reviewed operational evidence. Configuration syntax alone does not
 * prove unattended provider authority or an email arriving at its recipient. */
export class ActivationPolicyError extends Error {
  constructor(code) { super(code); this.name = 'ActivationPolicyError'; this.code = code; }
}
const fail = code => { throw new ActivationPolicyError(code); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function shape(value, fields) {
  if (!record(value) || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) fail('ACTIVATION_POLICY_INVALID');
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) fail('ACTIVATION_POLICY_TEXT_INVALID');
  return value.trim();
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('ACTIVATION_POLICY_TIME_INVALID');
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('ACTIVATION_POLICY_TIME_INVALID');
  return new Date(value).toISOString();
}
function address(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/.test(value)) fail('ACTIVATION_EMAIL_INVALID');
  return value;
}
function sender(value) {
  text(value);
  const match = /^([A-Za-z0-9 ._-]{1,70}) <([^<>]+)>$/.exec(value);
  address(match ? match[2] : value);
  return value;
}

export function parseActivationPolicy(input) {
  try { if (Buffer.byteLength(typeof input === 'string' ? input : JSON.stringify(input)) > 50_000) fail('ACTIVATION_POLICY_TOO_LARGE'); }
  catch (error) { if (error instanceof ActivationPolicyError) throw error; fail('ACTIVATION_POLICY_INVALID'); }
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { fail('ACTIVATION_POLICY_JSON_INVALID'); }
  }
  shape(input, ['schemaVersion', 'updatedAt', 'sequenceAuthority', 'emailDelivery']);
  if (input.schemaVersion !== 1) fail('ACTIVATION_POLICY_VERSION_INVALID');
  const updatedAt = timestamp(input.updatedAt);
  let sequenceAuthority, emailDelivery;
  if (input.sequenceAuthority?.status === 'unverified') {
    shape(input.sequenceAuthority, ['status']); sequenceAuthority = { status: 'unverified' };
  } else {
    const row = input.sequenceAuthority;
    shape(row, ['status', 'verifiedAt', 'reference', 'automaticApproval', 'accountPairs', 'maxAmountCents']);
    if (row.status !== 'verified' || typeof row.automaticApproval !== 'boolean' || !Array.isArray(row.accountPairs) || row.accountPairs.length < 1 || row.accountPairs.length > 20 ||
        row.maxAmountCents !== null && (!Number.isSafeInteger(row.maxAmountCents) || row.maxAmountCents < 100)) fail('ACTIVATION_AUTHORITY_INVALID');
    const accountPairs = row.accountPairs.map(pair => {
      shape(pair, ['sourceAccountId', 'destinationAccountId']);
      if (!UUID.test(pair.sourceAccountId) || !UUID.test(pair.destinationAccountId) || pair.sourceAccountId.toLowerCase() === pair.destinationAccountId.toLowerCase()) fail('ACTIVATION_AUTHORITY_PAIR_INVALID');
      return { sourceAccountId: pair.sourceAccountId.toLowerCase(), destinationAccountId: pair.destinationAccountId.toLowerCase() };
    });
    if (new Set(accountPairs.map(pair => `${pair.sourceAccountId}/${pair.destinationAccountId}`)).size !== accountPairs.length) fail('ACTIVATION_AUTHORITY_PAIR_DUPLICATE');
    sequenceAuthority = { status: 'verified', verifiedAt: timestamp(row.verifiedAt), reference: text(row.reference),
      automaticApproval: row.automaticApproval, accountPairs, maxAmountCents: row.maxAmountCents };
  }
  if (input.emailDelivery?.status === 'unverified') {
    shape(input.emailDelivery, ['status']); emailDelivery = { status: 'unverified' };
  } else {
    const row = input.emailDelivery;
    shape(row, ['status', 'verifiedAt', 'reference', 'provider', 'recipient', 'sender', 'providerAccepted', 'recipientConfirmed']);
    if (row.status !== 'verified' || row.provider !== 'resend' || row.providerAccepted !== true || row.recipientConfirmed !== true) fail('ACTIVATION_EMAIL_UNCONFIRMED');
    emailDelivery = { status: 'verified', verifiedAt: timestamp(row.verifiedAt), reference: text(row.reference), provider: 'resend',
      recipient: address(row.recipient), sender: sender(row.sender), providerAccepted: true, recipientConfirmed: true };
  }
  if ([sequenceAuthority, emailDelivery].some(row => row.verifiedAt && Date.parse(row.verifiedAt) > Date.parse(updatedAt))) fail('ACTIVATION_EVIDENCE_NEWER_THAN_POLICY');
  return { schemaVersion: 1, updatedAt, sequenceAuthority, emailDelivery };
}

export async function resolveActivationPolicy(config, { connectionString, getAll, now = Date.now(), timeoutMs = 10000 } = {}) {
  if (!config.monthly?.enabled) return { readinessEvidence: null, readinessEvidenceError: null };
  let timer;
  try {
    if (!Number.isFinite(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || getAll !== undefined && typeof getAll !== 'function') fail('ACTIVATION_SOURCE_CONFIGURATION_INVALID');
    if (!getAll) {
      if (typeof connectionString !== 'string' || !connectionString) fail('ACTIVATION_POLICY_SOURCE_REQUIRED');
      const { createClient } = await import('@vercel/global-config');
      const client = createClient(connectionString, { cache: 'no-store', staleIfError: false, disableDevelopmentCache: true });
      getAll = keys => client.getAll(keys, { consistentRead: true });
    }
    const result = await Promise.race([getAll(['activation_policy'], { consistentRead: true }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ActivationPolicyError('ACTIVATION_SOURCE_TIMEOUT')), timeoutMs);
    })]);
    const policy = parseActivationPolicy(result?.activation_policy);
    if (Date.parse(policy.updatedAt) > now) fail('ACTIVATION_POLICY_FROM_FUTURE');
    return { readinessEvidence: policy, readinessEvidenceError: null };
  } catch (error) {
    return { readinessEvidence: null, readinessEvidenceError: error instanceof ActivationPolicyError ? error.code : 'ACTIVATION_POLICY_UNAVAILABLE' };
  } finally { clearTimeout(timer); }
}
