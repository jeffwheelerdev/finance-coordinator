/** Sequence REST adapter. All writes require an explicit, pre-authorized intent. */

const API_ORIGIN = 'https://api.getsequence.io';
const API_BASE = `${API_ORIGIN}/platform/v1`;
const MAX_BODY_BYTES = 2_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const TRANSFER_STATUSES = new Set([
  'APPROVAL_PENDING', 'PROCESSING', 'PENDING', 'COMPLETE',
  'INCOMPLETE', 'ERROR', 'CANCELLED', 'APPROVAL_DENIED',
]);
const EXECUTION_MODES = new Set(['LIVE', 'SIMULATION', 'ALL']);
const REQUEST_FIELDS = new Set([
  'sourceAccountId', 'destinationAccountId', 'amountInCents',
  'description', 'reasonForApproval',
]);

export class SequenceError extends Error {
  constructor(code, message, { status = null, uncertain = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'SequenceError';
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
    // Seconds, as in the HTTP Retry-After header; never an automatic retry.
    this.retryAfter = retryAfter;
  }
}

function invalid(message = 'Invalid Sequence adapter input.') {
  return new SequenceError('INVALID_INPUT', message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('A valid resource UUID is required.');
  return value.toLowerCase();
}

function timestamp(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) throw invalid('An ISO timestamp with a timezone is required.');
  const parsed = Date.parse(value);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw invalid('An ISO timestamp with a timezone is required.');
  }
  return parsed;
}

function validTimestamp(value) {
  try { timestamp(value); return true; } catch { return false; }
}

function badResponse({ status = null, uncertain = false } = {}) {
  return new SequenceError('INVALID_RESPONSE', 'Sequence returned an invalid or inconsistent response.', { status, uncertain });
}

function snapshotRequest(request) {
  if (!isRecord(request)) throw invalid('A transfer request is required.');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const result = {};
  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== 'string' || !REQUEST_FIELDS.has(key)) throw invalid('The transfer request contains unsupported fields.');
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !('value' in descriptor)) throw invalid('Transfer fields must be stored values.');
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  result.sourceAccountId = uuid(result.sourceAccountId);
  result.destinationAccountId = uuid(result.destinationAccountId);
  if (result.sourceAccountId === result.destinationAccountId) throw invalid('Source and destination must differ.');
  if (!Number.isSafeInteger(result.amountInCents) || result.amountInCents < 100) {
    throw invalid('Transfer amounts must be safe integer cents of at least one dollar.');
  }
  if ('description' in result && (typeof result.description !== 'string' || !/^[a-zA-Z0-9 ]{0,10}$/.test(result.description))) {
    throw invalid('The ACH label must contain at most ten letters, digits or spaces.');
  }
  if ('reasonForApproval' in result && typeof result.reasonForApproval !== 'string') throw invalid();
  return Object.freeze({
    sourceAccountId: result.sourceAccountId,
    destinationAccountId: result.destinationAccountId,
    amountInCents: result.amountInCents,
    ...('description' in result ? { description: result.description } : {}),
    ...('reasonForApproval' in result ? { reasonForApproval: result.reasonForApproval } : {}),
  });
}

function retryAfterSeconds(header, now) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

async function readBounded(response, failureOptions) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    void response.body?.cancel?.().catch(() => {});
    throw new SequenceError('RESPONSE_TOO_LARGE', 'Sequence response exceeded the size limit.', failureOptions);
  }
  if (response.body === null) return '';
  if (!response.body || typeof response.body.getReader !== 'function') throw badResponse(failureOptions);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw badResponse(failureOptions);
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new SequenceError('RESPONSE_TOO_LARGE', 'Sequence response exceeded the size limit.', failureOptions);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class SequenceClient {
  #apiKey;
  #fetch;
  #liveEnabled;
  #allowedPairs;
  #now;
  #timeoutMs;
  #maxRequests;
  #deadlineAt;
  #requests = 0;

  constructor({ apiKey, fetchImpl = globalThis.fetch, liveEnabled = false, allowedPairs = [],
    now = () => Date.now(), timeoutMs = 8000, maxRequests = 100, deadlineAt = Infinity } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new SequenceError('CONFIGURATION_REQUIRED', 'A server-side Sequence credential is required.');
    }
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof liveEnabled !== 'boolean' ||
        !Array.isArray(allowedPairs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isSafeInteger(maxRequests) || maxRequests < 1 ||
        !(deadlineAt === Infinity || Number.isFinite(deadlineAt))) throw invalid('Invalid adapter configuration.');
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#liveEnabled = liveEnabled;
    this.#allowedPairs = new Set(allowedPairs.map((pair) => {
      const source = Array.isArray(pair) ? pair[0] : pair?.sourceAccountId;
      const destination = Array.isArray(pair) ? pair[1] : pair?.destinationAccountId;
      if (Array.isArray(pair) && pair.length !== 2) throw invalid('Invalid allowed account pair.');
      return `${uuid(source)}:${uuid(destination)}`;
    }));
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#maxRequests = maxRequests;
    this.#deadlineAt = deadlineAt;
  }

  #clock() {
    const value = this.#now();
    if (!Number.isFinite(value)) throw invalid('The adapter clock is invalid.');
    return value;
  }

  async #request(method, path, { query, body, idempotencyKey } = {}) {
    const write = method === 'POST';
    if (this.#requests >= this.#maxRequests) {
      throw new SequenceError('REQUEST_BUDGET_EXCEEDED', 'Sequence request budget exhausted.');
    }
    const started = this.#clock();
    const timeRemaining = this.#deadlineAt - started;
    if (timeRemaining <= 0) throw new SequenceError('DEADLINE_EXCEEDED', 'Sequence request deadline reached.');
    const url = new URL(API_BASE + path);
    if (query) url.search = query.toString();
    const headers = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      'x-called-reason': write ? 'Execute an authorized, durable finance funding intent' : 'Read-only finance coordinator reconciliation',
    };
    if (write) {
      headers['Content-Type'] = 'application/json';
      headers['idempotency-key'] = idempotencyKey;
    }
    const controller = new AbortController();
    let timer;
    this.#requests += 1;
    const operation = (async () => {
      let response;
      try {
        response = await this.#fetch(url.toString(), {
          method, headers, redirect: 'error', signal: controller.signal,
          ...(write ? { body } : {}),
        });
      } catch {
        throw new SequenceError('NETWORK_ERROR', 'Sequence request failed before a reliable response was received.', { uncertain: write });
      }
      const status = response?.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) throw badResponse({ uncertain: write });
      let wrongOrigin = false;
      if (response.url) {
        try { wrongOrigin = new URL(response.url).origin !== API_ORIGIN; } catch { wrongOrigin = true; }
      }
      if (response.redirected || wrongOrigin || (status >= 300 && status < 400)) {
        void response.body?.cancel?.().catch(() => {});
        throw new SequenceError('REDIRECT_REJECTED', 'Sequence redirects are not permitted.', { status, uncertain: write });
      }
      const ok = status >= 200 && status < 300;
      const uncertain = write && (ok || status >= 500 || status === 409);
      const failureOptions = { status, uncertain };
      const retryAfter = retryAfterSeconds(response.headers?.get?.('retry-after'), this.#clock());
      let text;
      try { text = await readBounded(response, failureOptions); } catch (error) {
        if (error instanceof SequenceError) throw error;
        throw new SequenceError('RESPONSE_READ_FAILED', 'Sequence response could not be read safely.', failureOptions);
      }
      let payload;
      try { payload = JSON.parse(text); } catch {
        if (ok) throw badResponse(failureOptions);
      }
      if (!ok) {
        const candidate = payload?.error?.code;
        const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) &&
          !candidate.includes(this.#apiKey) ? candidate : 'HTTP_ERROR';
        throw new SequenceError(code, 'Sequence rejected the request.', { status, uncertain, retryAfter });
      }
      if (!isRecord(payload) || !isRecord(payload.data)) throw badResponse(failureOptions);
      return payload.data;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SequenceError('REQUEST_TIMEOUT', 'Sequence request timed out; its result is unknown.', { uncertain: write }));
      }, Math.min(this.#timeoutMs, timeRemaining));
    });
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }

  async #resource(path, id) {
    const result = await this.#request('GET', path);
    if (typeof result.id !== 'string' || result.id.toLowerCase() !== id) throw badResponse();
    return result;
  }

  getAccount(id) {
    id = uuid(id);
    return this.#resource(`/accounts/${id}`, id);
  }

  getTransfer(id) {
    id = uuid(id);
    return this.#resource(`/transfers/${id}`, id);
  }

  getRule(id) {
    id = uuid(id);
    return this.#resource(`/rules/${id}`, id);
  }

  /** Complete pagination of the unfiltered rule inventory visible to this key.
   * This does not prove the key has organization-wide visibility. A separate
   * reviewed permission record is required before retirement-mode activation. */
  async listRules(options) {
    if (options !== undefined && (!isRecord(options) || Reflect.ownKeys(options).length !== 0)) {
      throw invalid('Rule retirement requires an unfiltered inventory.');
    }
    const query = new URLSearchParams(), seen = new Set(), items = [];
    let previousPageSize;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      query.set('page', String(page)); query.set('pageSize', String(PAGE_SIZE));
      const data = await this.#request('GET', '/rules', { query });
      const pagination = data.pagination;
      if (!Array.isArray(data.items) || !isRecord(pagination) || pagination.page !== page ||
          !Number.isInteger(pagination.pageSize) || pagination.pageSize < 1 || pagination.pageSize > PAGE_SIZE ||
          data.items.length > pagination.pageSize || typeof pagination.hasNextPage !== 'boolean' ||
          pagination.hasNextPage && data.items.length === 0 ||
          previousPageSize !== undefined && previousPageSize !== pagination.pageSize) throw badResponse();
      previousPageSize = pagination.pageSize;
      const now = this.#clock();
      for (const item of data.items) {
        if (!isRecord(item) || typeof item.id !== 'string' || !UUID.test(item.id) ||
            !['DISABLED', 'ENABLED'].includes(item.status) || typeof item.isSupported !== 'boolean' ||
            !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) ||
            Date.parse(item.createdAt) > Date.parse(item.updatedAt) || Date.parse(item.updatedAt) > now ||
            item.deletedAt !== null && (!validTimestamp(item.deletedAt) || Date.parse(item.deletedAt) > now ||
              Date.parse(item.deletedAt) < Date.parse(item.createdAt))) throw badResponse();
        const id = item.id.toLowerCase();
        if (seen.has(id)) throw new SequenceError('PAGINATION_UNSTABLE', 'Sequence pagination repeated a resource; complete coverage is unverified.');
        seen.add(id); items.push({ ...item, id });
      }
      if (!pagination.hasNextPage) return { items, complete: true, unfiltered: true };
    }
    throw new SequenceError('PAGINATION_LIMIT', 'Sequence pagination exceeded the permitted page count; coverage is incomplete.');
  }

  async getRuleExecution(ruleId, executionId) {
    ruleId = uuid(ruleId);
    executionId = uuid(executionId);
    const result = await this.#resource(`/rules/${ruleId}/executions/${executionId}`, executionId);
    if (typeof result.ruleId !== 'string' || result.ruleId.toLowerCase() !== ruleId) throw badResponse();
    return result;
  }

  /** Exhaustive bounded execution summaries, using one fixed creation-time window. */
  async listRuleExecutions(options) {
    if (!isRecord(options) || Object.keys(options).some(key => !['ruleId', 'from', 'to', 'executionMode'].includes(key))) {
      throw invalid('Unsupported rule execution filter.');
    }
    const ruleId = uuid(options.ruleId);
    const mode = options.executionMode === undefined ? 'LIVE' : options.executionMode;
    if (!EXECUTION_MODES.has(mode)) throw invalid('Invalid execution-mode filter.');
    const upper = options.to === undefined ? new Date(this.#clock()).toISOString() : options.to;
    const upperTime = timestamp(upper);
    const lowerTime = options.from === undefined ? -Infinity : timestamp(options.from);
    if (lowerTime > upperTime) throw invalid('The query start must not follow its end.');
    const query = new URLSearchParams({ to: upper, executionMode: mode });
    if (options.from !== undefined) query.set('from', options.from);
    const statuses = new Set(['EXECUTED', 'PARTIAL', 'IN_PROGRESS', 'FAILED', 'APPROVAL_PENDING', 'APPROVAL_DENIED']);
    const seen = new Set(), items = [];
    let previousPageSize, previousCreated = Infinity;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      query.set('page', String(page));
      query.set('pageSize', String(PAGE_SIZE));
      const data = await this.#request('GET', `/rules/${ruleId}/executions`, { query });
      const pagination = data.pagination;
      if (!Array.isArray(data.items) || !isRecord(pagination) || pagination.page !== page ||
          !Number.isInteger(pagination.pageSize) || pagination.pageSize < 1 || pagination.pageSize > PAGE_SIZE ||
          data.items.length > pagination.pageSize || typeof pagination.hasNextPage !== 'boolean' ||
          (pagination.hasNextPage && data.items.length === 0) ||
          (previousPageSize !== undefined && previousPageSize !== pagination.pageSize)) throw badResponse();
      previousPageSize = pagination.pageSize;
      for (const item of data.items) {
        if (!isRecord(item) || typeof item.id !== 'string' || !UUID.test(item.id) ||
            typeof item.ruleId !== 'string' || item.ruleId.toLowerCase() !== ruleId ||
            !['LIVE', 'SIMULATION'].includes(item.executionMode) || (mode !== 'ALL' && item.executionMode !== mode) ||
            !statuses.has(item.status) || !validTimestamp(item.createdAt)) throw badResponse();
        const created = Date.parse(item.createdAt), id = item.id.toLowerCase();
        if (created < lowerTime || created > upperTime || created > previousCreated) throw badResponse();
        if (seen.has(id)) throw new SequenceError('PAGINATION_UNSTABLE', 'Sequence pagination repeated a resource; complete coverage is unverified.');
        seen.add(id); previousCreated = created;
        items.push({ ...item, id, ruleId });
      }
      if (!pagination.hasNextPage) return { items, complete: true };
    }
    throw new SequenceError('PAGINATION_LIMIT', 'Sequence pagination exceeded the permitted page count; coverage is incomplete.');
  }

  #listQuery(options, external) {
    if (!isRecord(options)) throw invalid();
    const allowed = new Set(['accountIds', 'from', 'to', 'status', 'direction',
      ...(external ? [] : ['ruleExecutionId', 'executionMode', 'origin'])]);
    if (Object.keys(options).some((key) => !allowed.has(key))) throw invalid('Unsupported list filter.');
    const { accountIds, from, to, status, direction } = options;
    if (!Array.isArray(accountIds) || accountIds.length < 1 || accountIds.length > 100) throw invalid('Account IDs are required.');
    const query = new URLSearchParams();
    for (const accountId of new Set(accountIds.map(uuid))) query.append('accountIds[]', accountId);
    const upper = to ?? new Date(this.#clock()).toISOString();
    const upperTime = timestamp(upper);
    query.set('to', upper);
    if (from !== undefined) {
      if (timestamp(from) > upperTime) throw invalid('The query start must not follow its end.');
      query.set('from', from);
    }
    if (status !== undefined) {
      if (!(external ? new Set(['PENDING', 'COMPLETE']) : TRANSFER_STATUSES).has(status)) throw invalid('Invalid status filter.');
      query.set('status', status);
    }
    if (direction !== undefined) {
      if (!(external ? ['MONEY_IN', 'MONEY_OUT'] : ['MONEY_IN', 'MONEY_OUT', 'INTERNAL']).includes(direction)) throw invalid();
      query.set('direction', direction);
    }
    if (!external) {
      const mode = options.executionMode ?? 'LIVE';
      if (!EXECUTION_MODES.has(mode)) throw invalid('Invalid execution-mode filter.');
      query.set('executionMode', mode);
      if (options.ruleExecutionId !== undefined) query.set('ruleExecutionId', uuid(options.ruleExecutionId));
      if (options.origin !== undefined) {
        if (!['DIRECT_DEPOSIT', 'CHECK_DEPOSIT', 'CASHBACK', 'USER_PULL', 'RULE', 'USER', 'EXTERNAL_PULL'].includes(options.origin)) throw invalid();
        query.set('origin', options.origin);
      }
    }
    return query;
  }

  async #paginate(path, options, external = false) {
    const query = this.#listQuery(options, external);
    // Snapshot filters before the first await. Caller mutation or a provider's
    // changing default window must not broaden a later page of the same read.
    const requestedAccounts = new Set(query.getAll('accountIds[]'));
    const items = [];
    const seen = new Set();
    let previousPageSize;
    let window;
    let previousTransactionAt = Infinity;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      query.set('page', String(page));
      query.set('pageSize', String(PAGE_SIZE));
      const data = await this.#request('GET', path, { query });
      const pagination = data.pagination;
      if (!Array.isArray(data.items) || !isRecord(pagination) || pagination.page !== page ||
          !Number.isInteger(pagination.pageSize) || pagination.pageSize < 1 || pagination.pageSize > PAGE_SIZE ||
          data.items.length > pagination.pageSize || typeof pagination.hasNextPage !== 'boolean' ||
          (pagination.hasNextPage && data.items.length === 0) ||
          (previousPageSize !== undefined && previousPageSize !== pagination.pageSize)) throw badResponse();
      previousPageSize = pagination.pageSize;
      if (external) {
        const current = data.window;
        if (!isRecord(current) || typeof current.truncated !== 'boolean') throw badResponse();
        if (current.truncated) throw new SequenceError('TRUNCATED_WINDOW', 'Sequence did not cover the entire requested date window.');
        try {
          const start = timestamp(current.from);
          const end = timestamp(current.to);
          if (start > end || end !== timestamp(query.get('to')) ||
              (query.has('from') && start !== timestamp(query.get('from')))) throw badResponse();
        } catch { throw badResponse(); }
        if (window && (window.from !== current.from || window.to !== current.to)) throw badResponse();
        window = { from: current.from, to: current.to, truncated: false };
        query.set('from', window.from);
        query.set('to', window.to);
      }
      for (const item of data.items) {
        if (!isRecord(item) || typeof item.id !== 'string' || !UUID.test(item.id)) throw badResponse();
        const id = item.id.toLowerCase();
        if (seen.has(id)) throw new SequenceError('PAGINATION_UNSTABLE', 'Sequence pagination repeated a resource; complete coverage is unverified.');
        if (!external) {
          const mode = query.get('executionMode');
          if (!['LIVE', 'SIMULATION'].includes(item.executionMode) || (mode !== 'ALL' && item.executionMode !== mode)) throw badResponse();
        } else {
          if (typeof item.accountId !== 'string' || !UUID.test(item.accountId) || !requestedAccounts.has(item.accountId.toLowerCase()) ||
              !Number.isSafeInteger(item.amountInCents) || item.amountInCents < 0 ||
              !['MONEY_IN', 'MONEY_OUT'].includes(item.direction) || !['PENDING', 'COMPLETE'].includes(item.status) ||
              !validTimestamp(item.transactionDate) ||
              (item.description !== null && (typeof item.description !== 'string' || item.description.length > 10000)) ||
              (item.merchantName !== null && (typeof item.merchantName !== 'string' || item.merchantName.length > 1000)) ||
              (item.category !== null && (typeof item.category !== 'string' || item.category.length > 1000)) ||
              (query.has('status') && item.status !== query.get('status')) ||
              (query.has('direction') && item.direction !== query.get('direction'))) throw badResponse();
          const at = Date.parse(item.transactionDate);
          if (at < Date.parse(window.from) || at > Date.parse(window.to) || at > previousTransactionAt) throw badResponse();
          previousTransactionAt = at;
        }
        seen.add(id);
        items.push(external ? { ...item, id, accountId: item.accountId.toLowerCase() } : item);
      }
      if (!pagination.hasNextPage) return { items, complete: true, ...(external ? { window } : {}) };
    }
    throw new SequenceError('PAGINATION_LIMIT', 'Sequence pagination exceeded the permitted page count; coverage is incomplete.');
  }

  listTransfers(options) {
    return this.#paginate('/transfers', options);
  }

  listExternalTransactions(options) {
    return this.#paginate('/external-transactions', options, true);
  }

  async createTransfer(intent) {
    if (!this.#liveEnabled) throw new SequenceError('LIVE_DISABLED', 'Live transfers are disabled.');
    if (!isRecord(intent)) throw invalid('A persisted transfer intent is required.');
    const idempotencyKey = intent.idempotencyKey;
    const firstAttemptAt = intent.firstAttemptAt;
    if (typeof idempotencyKey !== 'string' || !UUID_V4.test(idempotencyKey)) {
      throw invalid('A persisted UUIDv4 idempotency key is required.');
    }
    const request = snapshotRequest(intent.request);
    if (!this.#allowedPairs.has(`${request.sourceAccountId}:${request.destinationAccountId}`)) {
      throw new SequenceError('PAIR_NOT_ALLOWED', 'This source and destination pair is not authorized.');
    }
    const firstAttempt = timestamp(firstAttemptAt);
    const age = this.#clock() - firstAttempt;
    if (age < 0) throw invalid('The intent timestamp cannot be in the future.');
    if (age >= RETRY_WINDOW_MS) {
      throw new SequenceError('IDEMPOTENCY_WINDOW_EXPIRED', 'Reconcile this intent before another request; its safe retry window has elapsed.');
    }
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw invalid('Transfer request exceeded the size limit.');
    const result = await this.#request('POST', '/transfers', { body, idempotencyKey });
    if (typeof result.id !== 'string' || !UUID.test(result.id) ||
        result.amountInCents !== request.amountInCents || result.executionMode !== 'LIVE' ||
        result.source?.id?.toLowerCase?.() !== request.sourceAccountId ||
        result.destination?.id?.toLowerCase?.() !== request.destinationAccountId ||
        !TRANSFER_STATUSES.has(result.status) ||
        (result.status === 'COMPLETE' && !validTimestamp(result.completedAt))) {
      throw badResponse({ status: 201, uncertain: true });
    }
    return result;
  }
}
