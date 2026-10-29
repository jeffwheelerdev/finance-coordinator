import { createHash, randomUUID } from 'node:crypto';
import { EvidenceError, PENDING, checkRules, discoverEvents, verifyRefund, fundingPlan, validTime } from './evidence.mjs';
import { verifyUpstreamFunding } from './upstream.mjs';

export const LEASE_MS = 360_000; // Must exceed the deployed function's 300-second maximum.
const RUN_MS = 240_000;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_EVENTS = 4000;
const finalChild = (child) => ['COMPLETE', 'NOOP', 'SKIPPED'].includes(child.status);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const clone = (value) => structuredClone(value);

export class EngineError extends Error {
  constructor(code) { super(code); this.name = 'EngineError'; this.code = code; }
}

export function initialState() {
  return { schemaVersion: 1, activationAt: null, bindingHash: null, allocations: {}, events: {}, active: null,
    lastSettledAt: null, lease: null, lastRun: null, inbox: {} };
}

export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !state.events || !state.allocations || !state.inbox ||
      Array.isArray(state.events) || Array.isArray(state.allocations) || Array.isArray(state.inbox) ||
      Object.keys(state.events).length > MAX_EVENTS ||
      (state.lease && (typeof state.lease.owner !== 'string' || !Number.isFinite(Date.parse(state.lease.expiresAt))))) {
    throw new EngineError('LEDGER_INVALID');
  }
  if (state.active && !state.events[state.active.eventKey]?.children?.[state.active.allocationId]) throw new EngineError('LEDGER_ACTIVE_INTENT_MISSING');
  const unresolved = [];
  for (const [eventKey, event] of Object.entries(state.events)) {
    if (!event || event.key !== eventKey || !event.children || Array.isArray(event.children) || !['OPEN', 'COMPLETE', 'REVIEW'].includes(event.status)) throw new EngineError('LEDGER_EVENT_INVALID');
    for (const [allocationId, child] of Object.entries(event.children)) {
      if (!child || child.allocationId !== allocationId || !['WAITING', 'SUBMITTING', 'PENDING', 'COMPLETE', 'NOOP', 'SKIPPED', 'REVIEW'].includes(child.status)) throw new EngineError('LEDGER_CHILD_INVALID');
      if (['SUBMITTING', 'PENDING'].includes(child.status)) unresolved.push({ eventKey: event.key, allocationId });
      if (child.request && child.requestHash !== hash(child.request)) throw new EngineError('LEDGER_REQUEST_CHANGED');
    }
    if (event.status === 'COMPLETE' && !Object.values(event.children).every(finalChild)) throw new EngineError('LEDGER_COMPLETION_INVALID');
  }
  if (unresolved.length > 1 || (unresolved.length === 0 && state.active) ||
      (unresolved.length === 1 && (unresolved[0].eventKey !== state.active?.eventKey || unresolved[0].allocationId !== state.active?.allocationId))) {
    throw new EngineError('LEDGER_RESERVATION_INVALID');
  }
  return state;
}

function binding(config) {
  return hash({ income: config.accounts.income, pod: config.accounts.pod, bills: config.accounts.bills, rules: config.rules });
}

function bindLiveConfiguration(state, config, now) {
  if (!config.activationAt) throw new EngineError('ACTIVATION_TIME_REQUIRED');
  if (Date.parse(config.activationAt) > now) throw new EngineError('ACTIVATION_NOT_STARTED');
  if (state.activationAt && state.activationAt !== config.activationAt) throw new EngineError('ACTIVATION_TIME_CHANGED');
  if (state.bindingHash && state.bindingHash !== binding(config)) throw new EngineError('ACCOUNT_OR_RULE_BINDING_CHANGED');
  const firstActivation = state.activationAt === null;
  state.activationAt = config.activationAt;
  state.bindingHash = binding(config);
  const configuredIds = new Set(config.allocations.map((allocation) => allocation.id));
  for (const [id, prior] of Object.entries(state.allocations)) {
    if (!configuredIds.has(id)) prior.enabled = false;
  }
  for (const allocation of config.allocations) {
    const prior = state.allocations[allocation.id];
    if (prior && prior.destinationAccountId !== allocation.destinationAccountId) throw new EngineError('ALLOCATION_DESTINATION_CHANGED');
    if (prior && prior.enabled === false && allocation.enabled) {
      // Re-enabling is prospective, just like adding a new destination.
      prior.firstEligibleAt = iso(Math.max(now, allocation.startsAt ? Date.parse(allocation.startsAt) : now));
    }
    if (prior) prior.enabled = allocation.enabled;
    if (!prior) {
      const earliest = firstActivation ? Date.parse(config.activationAt) : now;
      state.allocations[allocation.id] = {
        destinationAccountId: allocation.destinationAccountId,
        firstEligibleAt: iso(Math.max(earliest, allocation.startsAt ? Date.parse(allocation.startsAt) : earliest)),
        enabled: allocation.enabled,
      };
    }
  }
}

function transferMatches(transfer, intent) {
  return transfer && typeof transfer.id === 'string' && transfer.executionMode === 'LIVE' &&
    transfer.source?.id === intent.request.sourceAccountId && transfer.destination?.id === intent.request.destinationAccountId &&
    transfer.source.isDeleted === false && transfer.destination.isDeleted === false &&
    transfer.amountInCents === intent.request.amountInCents && transfer.origin === 'USER' &&
    transfer.ruleId === null && transfer.ruleExecutionId === null;
}

function completeEventIfDone(event) {
  if (Object.values(event.children).every(finalChild)) event.status = 'COMPLETE';
}

function markReview(state, event, child, code, now) {
  child.status = 'REVIEW'; child.reason = code; child.updatedAt = iso(now);
  event.status = 'REVIEW'; event.reason = code;
  // Keep the exact request and provider identity. A reviewer must reconcile it;
  // changing a budget or deploying again cannot clear this state.
  state.active = null;
  return { status: 'review', code, allocationId: child.allocationId };
}

/** One global, CAS-protected writer serializes all allocations sharing Income. */
export async function reconcile({ config, client, store, now = () => Date.now(), uuid = randomUUID, forceObserve = false }) {
  const started = now();
  const deadline = started + RUN_MS;
  const owner = uuid();
  let record = await store.read();
  let state = validateState(clone(record?.value ?? initialState()));
  if (state.lease && Date.parse(state.lease.expiresAt) > started) return { status: 'busy', code: 'ANOTHER_RUN_OWNS_LEASE' };
  state.lease = { owner, expiresAt: iso(started + LEASE_MS) };
  try { record = await store.compareAndSwap(record?.etag ?? null, state); }
  catch (error) {
    if (error.code === 'STORE_CONFLICT' || error.name === 'StoreConflict') return { status: 'busy', code: 'ANOTHER_RUN_WON_CLAIM' };
    throw error;
  }
  let result;
  let lostLease = false;
  const live = config.liveEnabled === true && config.mode === 'live' && !forceObserve;
  async function save() {
    if (lostLease || state.lease?.owner !== owner || Date.parse(state.lease.expiresAt) <= now() + 15_000 || now() >= deadline) {
      throw new EngineError('LEASE_OR_RUN_EXPIRED');
    }
    validateState(state);
    try { record = await store.compareAndSwap(record.etag, clone(state)); }
    catch (error) { lostLease = true; throw error; }
  }
  async function receiveTransfer(event, child, transfer) {
    if (!transferMatches(transfer, child) || (child.transferId && transfer.id !== child.transferId)) {
      return markReview(state, event, child, 'TOPUP_TRANSFER_IDENTITY_INVALID', now());
    }
    child.transferId = transfer.id;
    child.providerStatus = transfer.status;
    child.updatedAt = iso(now());
    if (transfer.status === 'COMPLETE') {
      const completed = validTime(transfer.completedAt, now(), 'TOPUP_COMPLETION_TIME_INVALID');
      if (completed < Date.parse(child.firstAttemptAt) || transfer.errorCode !== null) return markReview(state, event, child, 'TOPUP_SETTLEMENT_INCONSISTENT', now());
      child.status = 'COMPLETE'; child.completedAt = transfer.completedAt;
      state.lastSettledAt = iso(Math.max(completed, state.lastSettledAt ? Date.parse(state.lastSettledAt) : 0));
      state.active = null;
      completeEventIfDone(event);
      return { status: 'complete', code: 'TOPUP_SETTLED', allocationId: child.allocationId, amountInCents: child.request.amountInCents };
    }
    if (PENDING.has(transfer.status)) {
      child.status = 'PENDING';
      return { status: 'pending', code: transfer.status === 'APPROVAL_PENDING' ? 'PROVIDER_APPROVAL_REQUIRED' : 'TOPUP_PENDING', allocationId: child.allocationId };
    }
    return markReview(state, event, child, 'TOPUP_DID_NOT_SETTLE', now());
  }
  async function submit(event, child) {
    if (!live) return { status: 'observe', code: 'SUBMISSION_DISABLED', allocationId: child.allocationId };
    const age = now() - Date.parse(child.firstAttemptAt);
    if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS) {
      return markReview(state, event, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED', now());
    }
    if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) return { status: 'waiting', code: 'RETRY_NOT_DUE' };
    if (child.requestHash !== hash(child.request)) throw new EngineError('LEDGER_REQUEST_CHANGED');
    // Flush the exact immutable intent before every attempt. If this fails, no POST.
    child.attempts = (child.attempts ?? 0) + 1;
    child.lastAttemptAt = iso(now());
    await save();
    try {
      const transfer = await client.createTransfer({
        idempotencyKey: child.idempotencyKey, request: clone(child.request), firstAttemptAt: child.firstAttemptAt,
      });
      return await receiveTransfer(event, child, transfer);
    } catch (error) {
      // Unknown errors after entering the provider call are uncertain, even if an
      // unexpected adapter exception omitted the uncertainty flag.
      if (error.uncertain !== false || error.status === 429) {
        child.status = 'SUBMITTING'; child.lastError = safeCode(error);
        const retryAfter = Number(error.retryAfter);
        const delay = Number.isFinite(retryAfter) ? Math.max(60, Math.min(retryAfter, RETRY_WINDOW_MS / 1000)) : 60;
        child.nextAttemptAt = iso(now() + delay * 1000);
        return { status: error.status === 429 ? 'waiting' : 'uncertain', code: error.status === 429 ? 'RATE_LIMIT_RETRY_PENDING' : 'SUBMISSION_OUTCOME_UNKNOWN', allocationId: child.allocationId };
      }
      return markReview(state, event, child, 'PROVIDER_REJECTED_TOPUP', now());
    }
  }
  try {
    // Existing intents remain observable when paused. Mapping changes never redirect
    // an accepted or possibly accepted transfer.
    if (state.active) {
      const event = state.events[state.active.eventKey];
      const child = event.children[state.active.allocationId];
      if (child.transferId) {
        try { result = await receiveTransfer(event, child, await client.getTransfer(child.transferId)); }
        catch (error) {
          if (error instanceof EvidenceError) result = markReview(state, event, child, error.code, now());
          else result = { status: 'waiting', code: error.status === 404 ? 'ACCEPTED_TRANSFER_NOT_VISIBLE_YET' : safeCode(error) };
        }
      } else if (live) {
        bindLiveConfiguration(state, config, now());
        await checkRules(client, config, { requireEnabled: true });
        if (now() - Date.parse(child.firstAttemptAt) >= RETRY_WINDOW_MS) {
          result = markReview(state, event, child, 'IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED', now());
        } else if (child.nextAttemptAt && Date.parse(child.nextAttemptAt) > now()) {
          result = { status: 'waiting', code: 'RETRY_NOT_DUE' };
        } else {
          // A lost response may mean the first POST never arrived. A retry must be
          // safe even if it creates the transfer for the first time right now.
          const allocation = config.allocations.find((item) => item.id === child.allocationId && item.enabled);
          if (!allocation || allocation.destinationAccountId !== child.request.destinationAccountId ||
              (allocation.startsAt && Date.parse(event.startedAt) < Date.parse(allocation.startsAt))) {
            result = markReview(state, event, child, 'RETRY_ALLOCATION_CHANGED', now());
          } else {
            const history = await discoverEvents(client, config, { now: now(), activationAt: state.activationAt });
            await verifyUpstreamFunding(client, config, { now: now(), activationAt: state.activationAt });
            const verified = await verifyRefund(client, config, event, { now: now(), activationAt: state.activationAt });
            const frozen = { ...allocation, targetCents: Math.min(allocation.targetCents, child.plan.targetCents) };
            const plan = await fundingPlan(client, config, frozen, verified, history.transfers, { now: now(), lastSettledAt: state.lastSettledAt });
            if (plan.amountInCents < child.request.amountInCents) result = markReview(state, event, child, 'RETRY_NO_LONGER_FITS_CURRENT_BALANCES', now());
            else result = await submit(event, child);
          }
        }
      } else result = { status: 'observe', code: 'UNCERTAIN_INTENT_PAUSED' };
      await save();
      return result;
    }
    if (Object.values(state.events).some((event) => event.status === 'REVIEW')) return result = { status: 'review', code: 'UNRESOLVED_EVENT_REQUIRES_REVIEW' };
    if (live) { bindLiveConfiguration(state, config, now()); await save(); }
    const rules = await checkRules(client, config, { requireEnabled: live });
    const cutoff = state.activationAt ?? config.activationAt;
    const history = await discoverEvents(client, config, { now: now(), activationAt: cutoff });
    const openEvents = Object.values(state.events).filter((event) => event.status === 'OPEN');
    // Prefer the durable event even if a later listing momentarily omits its transfer.
    const candidates = [...openEvents, ...history.events.filter((event) => !state.events[event.key])];
    if (candidates.length === 0) return result = { status: live ? 'waiting' : 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
    await verifyUpstreamFunding(client, config, { now: now(), activationAt: cutoff });
    let candidate;
    let verified;
    for (const possible of candidates) {
      try {
        verified = await verifyRefund(client, config, possible, { now: now(), activationAt: cutoff });
        candidate = possible;
        break;
      } catch (error) {
        if (error instanceof EvidenceError && error.code === 'PAYOUT_PREDATES_ACTIVATION') continue;
        throw error;
      }
    }
    if (!candidate) return result = { status: live ? 'waiting' : 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
    let event = state.events[candidate.key];
    if (!event) {
      const eligible = config.allocations.filter((allocation) => allocation.enabled &&
        Date.parse(verified.startedAt) >= Math.max(live ? Date.parse(state.allocations[allocation.id].firstEligibleAt) : -Infinity,
          allocation.startsAt ? Date.parse(allocation.startsAt) : -Infinity));
      event = { ...verified, status: 'OPEN', children: Object.fromEntries(eligible.map((allocation) => [allocation.id,
        { allocationId: allocation.id, destinationAccountId: allocation.destinationAccountId, status: 'WAITING' }])) };
      if (live) {
        if (Object.keys(state.events).length >= MAX_EVENTS) throw new EngineError('LEDGER_CAPACITY_REQUIRES_ARCHIVE');
        state.events[event.key] = event;
        completeEventIfDone(event);
        await save();
      }
    } else {
      if (JSON.stringify(event.refundIds) !== JSON.stringify(verified.refundIds)) throw new EngineError('PAYOUT_REFUND_SET_CHANGED');
      event.completedAt = verified.completedAt;
    }
    const child = Object.values(event.children).find((item) => !finalChild(item));
    if (!child) return result = { status: live ? 'complete' : 'observe', code: 'EVENT_HAS_NO_ELIGIBLE_ALLOCATIONS' };
    const allocation = config.allocations.find((item) => item.id === child.allocationId);
    const firstEligibleAt = Math.max(
      state.allocations[child.allocationId]?.firstEligibleAt ? Date.parse(state.allocations[child.allocationId].firstEligibleAt) : -Infinity,
      allocation?.startsAt ? Date.parse(allocation.startsAt) : -Infinity,
    );
    if (!allocation || !allocation.enabled || Date.parse(event.startedAt) < firstEligibleAt) {
      if (live) { child.status = 'SKIPPED'; child.reason = 'ALLOCATION_DISABLED_OR_NOT_STARTED'; completeEventIfDone(event); await save(); }
      return result = { status: live ? 'complete' : 'observe', code: 'ALLOCATION_DISABLED_OR_NOT_STARTED', allocationId: child.allocationId };
    }
    if (allocation.destinationAccountId !== child.destinationAccountId) throw new EngineError('ALLOCATION_DESTINATION_CHANGED');
    const plan = await fundingPlan(client, config, allocation, verified, history.transfers, { now: now(), lastSettledAt: state.lastSettledAt });
    if (!live) return result = { status: 'observe', code: 'READ_ONLY_PLAN', rules, plan };
    if (plan.amountInCents === 0) {
      child.status = 'NOOP'; child.reason = plan.reason; child.plan = plan; child.completedAt = iso(now());
      completeEventIfDone(event); await save();
      return result = { status: 'complete', code: plan.reason, plan };
    }
    const request = {
      sourceAccountId: config.accounts.income, destinationAccountId: allocation.destinationAccountId,
      amountInCents: plan.amountInCents, description: 'TOPUP',
      reasonForApproval: `Finance coordinator: ${allocation.id}; verified refund ${event.executionId}; target ${allocation.targetCents} cents.`,
    };
    Object.assign(child, {
      status: 'SUBMITTING', request, requestHash: hash(request), idempotencyKey: uuid(),
      firstAttemptAt: iso(now()), configHash: config.configHash, plan, attempts: 0,
    });
    state.active = { eventKey: event.key, allocationId: child.allocationId };
    await save();
    result = await submit(event, child);
    await save();
    return result;
  } catch (error) {
    result = { status: error instanceof EvidenceError && !error.review ? 'waiting' : 'blocked', code: safeCode(error) };
    return result;
  } finally {
    // Never overwrite another worker after a CAS conflict. A crash leaves the lease
    // and immutable intent for recovery after the old function has necessarily ended.
    if (!lostLease && now() < deadline && state.lease?.owner === owner) {
      state.lastRun = { at: iso(now()), mode: live ? 'live' : 'observe', result: result ?? { status: 'blocked', code: 'RUN_INTERRUPTED' } };
      state.lease = null;
      try { await store.compareAndSwap(record.etag, clone(state)); } catch { /* The durable prior state remains authoritative. */ }
    }
  }
}

export function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
}

/** A plan never claims an event, records completion, or calls a mutation method. */
export async function preview({ config, client, store, now = () => Date.now() }) {
  const state = validateState((await store.read())?.value ?? initialState());
  if (state.active) return { status: 'waiting', code: 'EXISTING_INTENT_UNRESOLVED' };
  if (Object.values(state.events).some((event) => event.status === 'REVIEW')) return { status: 'review', code: 'UNRESOLVED_EVENT_REQUIRES_REVIEW' };
  const rules = await checkRules(client, config);
  const history = await discoverEvents(client, config, { now: now(), activationAt: state.activationAt ?? config.activationAt });
  const candidates = [...Object.values(state.events).filter((event) => event.status === 'OPEN'), ...history.events.filter((event) => !state.events[event.key])];
  let candidate, event;
  for (const possible of candidates) {
    try {
      event = await verifyRefund(client, config, possible, { now: now(), activationAt: state.activationAt ?? config.activationAt });
      candidate = possible;
      break;
    } catch (error) {
      if (error instanceof EvidenceError && error.code === 'PAYOUT_PREDATES_ACTIVATION') continue;
      throw error;
    }
  }
  if (!candidate) return { status: 'observe', code: 'NO_NEW_SETTLED_REFUND', rules };
  await verifyUpstreamFunding(client, config, { now: now(), activationAt: state.activationAt ?? config.activationAt });
  const allocation = config.allocations.find((item) => item.enabled &&
    (!candidate.children || candidate.children[item.id]?.status === 'WAITING') &&
    (!state.allocations[item.id]?.firstEligibleAt || Date.parse(state.allocations[item.id].firstEligibleAt) <= Date.parse(event.startedAt)) &&
    (!item.startsAt || Date.parse(item.startsAt) <= Date.parse(event.startedAt)));
  if (!allocation) return { status: 'observe', code: 'EVENT_HAS_NO_ELIGIBLE_ALLOCATIONS' };
  return { status: 'observe', code: 'READ_ONLY_PLAN', rules,
    plan: await fundingPlan(client, config, allocation, event, history.transfers, { now: now(), lastSettledAt: state.lastSettledAt }) };
}
