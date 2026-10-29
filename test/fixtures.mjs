import { createHash } from 'node:crypto';
import { reconcile } from '../lib/engine.mjs';

// Synthetic fixtures only. No production identifiers, balances or credentials.
export const ID = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const TEST_NOW = Date.parse('2030-01-02T12:00:00.000Z');
export const asISO = (value) => new Date(value).toISOString();
const copy = (value) => structuredClone(value);

export function makeConfig(overrides = {}) {
  const accounts = { income: ID(1), pod: ID(2), general: ID(3), bills: ID(4), ...overrides.accounts };
  const config = {
    mode: 'live', liveEnabled: true, activationAt: asISO(TEST_NOW - 24 * 3600000),
    accounts, rules: { funding: ID(11), payout: ID(12), legacyGeneral: ID(13), ...overrides.rules },
    allocations: [{ id: 'bills', destinationAccountId: accounts.bills,
      monthlyBudgetCents: null, reserveMonths: null, targetCents: 50000,
      priority: 0, enabled: true, startsAt: null }, { id: 'general-spending', destinationAccountId: accounts.general,
      monthlyBudgetCents: 100000, reserveMonths: 3, targetCents: 300000,
      priority: 1, enabled: true, startsAt: null }],
    billsBufferCents: 50000, incomeReserveCents: 10000, maxBalanceAgeMs: 26 * 3600000,
    calculatedBillsTarget: { targetCents: 50000, catalogHash: 'a'.repeat(64),
      catalogUpdatedAt: asISO(TEST_NOW - 2 * 86400000), year: 2030, effectiveDate: '2030-01-02', peakMonthCents: 45000 },
    ...overrides,
  };
  config.accounts = accounts;
  config.rules = { funding: ID(11), payout: ID(12), legacyGeneral: ID(13), ...overrides.rules };
  const { configHash: _ignored, ...financial } = config;
  config.configHash = createHash('sha256').update(JSON.stringify(financial)).digest('hex');
  return config;
}

export function cashAccount(id, amount, updatedAt = asISO(TEST_NOW - 30 * 60000), overrides = {}) {
  return {
    id, type: 'EXTERNAL_ACCOUNT', externalAccountType: 'DEPOSITORY', deletedAt: null,
    canBeSource: true, canBeDestination: true,
    balance: { balanceInCents: amount, availableBalanceInCents: amount, holdInCents: null,
      balanceLastUpdatedAt: updatedAt, error: null },
    ...overrides,
  };
}

export function transferRecord(overrides = {}) {
  return {
    id: ID(101), amountInCents: 5000, direction: 'MONEY_OUT', origin: 'RULE',
    source: { id: ID(2), type: 'POD', isDeleted: false },
    destination: { id: ID(1), type: 'EXTERNAL_ACCOUNT', isDeleted: false },
    status: 'COMPLETE', executionMode: 'LIVE', ruleId: ID(12), ruleExecutionId: ID(201),
    errorCode: null, createdAt: asISO(TEST_NOW - 90 * 60000), completedAt: asISO(TEST_NOW - 60 * 60000),
    ...overrides,
  };
}

export class StoreConflict extends Error {
  constructor() { super('Synthetic compare-and-swap conflict'); this.name = 'StoreConflict'; this.code = 'STORE_CONFLICT'; }
}

export class FakeStore {
  constructor(value = null) {
    this.value = copy(value);
    this.etag = value === null ? null : 'version-1';
    this.version = value === null ? 0 : 1;
    this.reads = 0;
    this.writes = [];
    this.beforeCAS = null;
  }

  async read() {
    this.reads += 1;
    return { value: copy(this.value), etag: this.etag };
  }

  async compareAndSwap(expectedEtag, value) {
    if (this.beforeCAS) await this.beforeCAS(expectedEtag, copy(value));
    if (expectedEtag !== this.etag) throw new StoreConflict();
    this.value = copy(value);
    this.etag = `version-${++this.version}`;
    this.writes.push(copy(value));
    return { value: copy(this.value), etag: this.etag };
  }

  replaceForTest(value) {
    this.value = copy(value);
    this.etag = `version-${++this.version}`;
  }
}

export class FakeSequence {
  constructor(config, clock) {
    this.config = config;
    this.clock = clock;
    this.accounts = new Map([
      [config.accounts.income, cashAccount(config.accounts.income, 500000)],
      [config.accounts.general, cashAccount(config.accounts.general, 100000)],
      [config.accounts.bills, cashAccount(config.accounts.bills, 50000)],
      [config.accounts.pod, cashAccount(config.accounts.pod, 0, null, {
        type: 'POD', externalAccountType: null,
        balance: { balanceInCents: 0, availableBalanceInCents: 0, holdInCents: 0,
          balanceLastUpdatedAt: null, error: null },
      })],
    ]);
    this.rules = new Map(Object.entries(config.rules).map(([name, id]) =>
      [id, { id, status: name === 'legacyGeneral' ? 'DISABLED' : 'ENABLED', deletedAt: null }]));
    this.transfers = new Map();
    this.executions = new Map();
    this.calls = [];
    this.creates = [];
    this.accepted = new Map();
    this.completeHistory = true;
    this.historyOverride = null;
    this.onCreate = null;
    this.onGetAccount = null;
    this.onGetTransfer = null;
    this.addRefund();
  }

  addRefund({ executionId = ID(201), refundId = ID(101),
    startedAt = asISO(TEST_NOW - 120 * 60000),
    createdAt = asISO(TEST_NOW - 90 * 60000),
    completedAt = asISO(TEST_NOW - 60 * 60000), amountInCents = 5000 } = {}) {
    this.transfers.set(refundId, transferRecord({ id: refundId, ruleId: this.config.rules.payout,
      ruleExecutionId: executionId, source: { id: this.config.accounts.pod, type: 'POD', isDeleted: false },
      destination: { id: this.config.accounts.income, type: 'EXTERNAL_ACCOUNT', isDeleted: false },
      createdAt, completedAt, amountInCents }));
    this.executions.set(executionId, { id: executionId, ruleId: this.config.rules.payout,
      status: 'EXECUTED', executionMode: 'LIVE', createdAt: startedAt,
      transferIds: [refundId], transfersAttempted: 1, transfersCompleted: 1,
      transfersFailed: 0, transfersPending: 0, conditionsNotMet: false,
      nextAttemptAt: null, errorMessage: null });
    return refundId;
  }

  async getAccount(id) {
    this.calls.push({ method: 'getAccount', id });
    if (this.onGetAccount) return this.onGetAccount(id);
    return copy(this.accounts.get(id));
  }

  async getRule(id) {
    this.calls.push({ method: 'getRule', id });
    return copy(this.rules.get(id));
  }

  async getRuleExecution(ruleId, id) {
    this.calls.push({ method: 'getRuleExecution', ruleId, id });
    return copy(this.executions.get(id));
  }

  async getTransfer(id) {
    this.calls.push({ method: 'getTransfer', id });
    if (this.onGetTransfer) return this.onGetTransfer(id);
    return copy(this.transfers.get(id));
  }

  async listTransfers(options) {
    this.calls.push({ method: 'listTransfers', options: copy(options) });
    return { items: copy(this.historyOverride ?? [...this.transfers.values()]), complete: this.completeHistory };
  }

  async listRuleExecutions(options) {
    this.calls.push({ method: 'listRuleExecutions', options: copy(options) });
    const { ruleId, from, to, executionMode = 'LIVE' } = options;
    const lower = from === undefined ? -Infinity : Date.parse(from);
    const upper = to === undefined ? Infinity : Date.parse(to);
    return { items: copy([...this.executions.values()].filter((execution) =>
      execution.ruleId === ruleId && execution.executionMode === executionMode &&
      Date.parse(execution.createdAt) >= lower && Date.parse(execution.createdAt) <= upper)), complete: true };
  }

  acceptIntent(intent, overrides = {}) {
    if (this.accepted.has(intent.idempotencyKey)) return copy(this.transfers.get(this.accepted.get(intent.idempotencyKey)));
    const id = ID(9001 + this.accepted.size);
    const transfer = transferRecord({ id, amountInCents: intent.request.amountInCents,
      origin: 'USER', ruleId: null, ruleExecutionId: null, status: 'PENDING',
      source: { id: intent.request.sourceAccountId, type: 'EXTERNAL_ACCOUNT', isDeleted: false },
      destination: { id: intent.request.destinationAccountId, type: 'EXTERNAL_ACCOUNT', isDeleted: false },
      createdAt: asISO(this.clock.value), completedAt: null, ...overrides });
    this.accepted.set(intent.idempotencyKey, id);
    this.transfers.set(id, transfer);
    return copy(transfer);
  }

  async createTransfer(intent) {
    this.creates.push(copy(intent));
    this.calls.push({ method: 'createTransfer', intent: copy(intent) });
    return this.onCreate ? this.onCreate(copy(intent)) : this.acceptIntent(intent);
  }

  settle(id, completedAt = asISO(this.clock.value)) {
    const transfer = this.transfers.get(id);
    Object.assign(transfer, { status: 'COMPLETE', errorCode: null, completedAt });
  }

  refreshCash({ at = asISO(this.clock.value), income, general, bills } = {}) {
    for (const [alias, amount] of Object.entries({ income, general, bills })) {
      const account = this.accounts.get(this.config.accounts[alias]);
      account.balance.balanceLastUpdatedAt = at;
      if (amount !== undefined) {
        account.balance.balanceInCents = amount;
        account.balance.availableBalanceInCents = amount;
      }
    }
  }
}

export function scenario(overrides = {}) {
  const config = makeConfig(overrides);
  const clock = { value: TEST_NOW, advance(ms) { this.value += ms; } };
  const store = new FakeStore();
  const client = new FakeSequence(config, clock);
  let identity = 6000;
  const s = { config, clock, store, client, nextUuid: () => ID(identity++) };
  s.run = (options = {}) => reconcile({ config: s.config, client: s.client, store: s.store,
    now: () => s.clock.value, uuid: s.nextUuid, ...options });
  return s;
}
