import { createHash, timingSafeEqual } from 'node:crypto';
import { VERSION, loadConfig, summarizeConfig } from './config.mjs';
import { SequenceClient } from './sequence.mjs';
import { createBlobStore } from './store.mjs';
import { reconcile, preview, initialState, validateState, safeCode, summarizeRothState } from './engine.mjs';
import { validateAccount, checkRules } from './evidence.mjs';
import { verifiedWebhook, recordWebhook } from './webhook.mjs';
import { verifyUpstreamFunding } from './upstream.mjs';
import { resolveBillsConfiguration, summarizeBillsPolicy } from './bills-source.mjs';
import { resolveRothPolicy } from './roth-source.mjs';
import { validateRothDestination } from './roth-evidence.mjs';
import { reconcileMonthly, previewMonthly, validateMonthlyState, summarizeMonthlyState, monthlyOwnedTransfers, summarizeMonthlyRoth } from './monthly-engine.mjs';
import { readMonthlyEvidence } from './monthly-evidence.mjs';
import { resolveMonthlyPolicy } from './monthly-source.mjs';
import { incomeScanFrom } from './income-ledger.mjs';
import { createAlertSender, summarizeAlertDelivery } from './alerts.mjs';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 16) return false;
  const supplied = request.headers.get('authorization') ?? '';
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}

function publicHealth(env) {
  let config;
  try { config = loadConfig(env); }
  catch (error) { return { version: VERSION, status: 'configuration_required', code: safeCode(error), liveEnabled: false }; }
  const credentialsPresent = Boolean(env.SEQUENCE_API_KEY && env.BLOB_READ_WRITE_TOKEN && env.CRON_SECRET?.length >= 16 && env.GLOBAL_CONFIG);
  return {
    version: VERSION, status: credentialsPresent ? 'ready' : 'configuration_required',
    mode: config.mode, liveEnabled: config.liveEnabled, credentialsPresent,
    webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
    billCatalogConfigured: Boolean(env.GLOBAL_CONFIG),
    rothConfigured: Boolean(config.roth?.enabled && config.roth?.accountId && env.GLOBAL_CONFIG),
    monthlyPriorityConfigured: Boolean(config.monthly?.enabled && env.GLOBAL_CONFIG),
    emailDeliveryConfigured: summarizeAlertDelivery(env).configured,
  };
}

export async function preflight({ config, client, store, env, billsPolicy, rothPolicy, rothEvidence, rothPolicyError, monthlyPolicy, monthlyPolicyError, now = () => Date.now() }) {
  if (config.monthly?.enabled) {
    const state = validateMonthlyState((await store.read())?.value ?? initialState());
    // An unverified opening is a deliberate activation blocker. Connection,
    // account-role, rule, and source-read checks still run without inventing one.
    const externalFrom = incomeScanFrom(monthlyPolicy, state.monthly?.income) ?? new Date(now() - 7 * 86400000).toISOString();
    const evidence = await readMonthlyEvidence(client, config, { now: now(), externalFrom,
      knownTransfers: monthlyOwnedTransfers(state).filter(row => row.transferId), lastSettledAt: state.monthly?.lastSettledAt ?? state.lastSettledAt });
    const roth = summarizeMonthlyRoth({ config, state, rothPolicy, rothPolicyError, now: now() });
    const alertDelivery = summarizeAlertDelivery(env);
    const blockers = [
      ...(monthlyPolicyError ? [monthlyPolicyError] : []),
      ...(monthlyPolicy?.opening?.status !== 'verified' ? ['INCOME_OPENING_UNVERIFIED'] : []),
      ...(!alertDelivery.configured ? ['MONTHLY_ALERT_DELIVERY_REQUIRED'] : []),
      ...(!config.liveEnabled || !config.activationAt ? ['MONTHLY_ACTIVATION_REQUIRED'] : []),
    ];
    return { version: VERSION, status: 'read_checks_passed', configuration: summarizeConfig(config),
      rules: evidence.nativeRuleStatuses, transferPermission: 'not_exercised', activationRequired: blockers.length > 0 || roth.blockers.length > 0,
      webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
      ledger: { initialized: state.lastRun !== null, unresolvedIntent: monthlyOwnedTransfers(state).some(r => r.status !== 'COMPLETE'),
        reviewRequired: summarizeMonthlyState({ config, state, now: now() }).reviewRequired },
      bills: billsPolicy ? summarizeBillsPolicy(billsPolicy) : null,
      roth: { ...roth, destinationVerified: Boolean(evidence.accountSnapshots.roth) },
      monthly: { ...summarizeMonthlyState({ config, state, now: now() }), sourceValid: Boolean(monthlyPolicy && !monthlyPolicyError),
        openingVerified: monthlyPolicy?.opening?.status === 'verified', accountRolesVerified: true, blockers }, alertDelivery };
  }
  const rules = await checkRules(client, config);
  const notStarted = Boolean(config.activationAt && Date.parse(config.activationAt) > now());
  const upstream = notStarted ? { checked: 0, status: 'activation_not_started' } :
    await verifyUpstreamFunding(client, config, { now: now(), activationAt: config.activationAt });
  for (const [alias, id] of Object.entries(config.accounts)) {
    validateAccount(await client.getAccount(id), id, alias === 'income' || alias === 'pod' ? 'source' : alias === 'general' ? 'destination' : 'reserve');
  }
  for (const allocation of config.allocations.filter((item) => item.enabled)) {
    validateAccount(await client.getAccount(allocation.destinationAccountId), allocation.destinationAccountId, 'destination');
  }
  const state = validateState((await store.read())?.value ?? initialState());
  let destinationVerified = false, destinationError = null;
  if (config.roth?.enabled) {
    try {
      validateRothDestination(await client.getAccount(config.roth.accountId), config.roth.accountId);
      destinationVerified = true;
    } catch (error) { destinationError = safeCode(error); }
  }
  const roth = { ...summarizeRothState({ config, state, rothPolicy, rothEvidence, rothPolicyError, now: now() }),
    destinationVerified, ...(destinationError ? { destinationError } : {}) };
  return {
    version: VERSION, status: 'read_checks_passed', configuration: summarizeConfig(config), rules, upstream,
    ledger: { initialized: state.lastRun !== null, unresolvedIntent: Boolean(state.active), reviewRequired: Object.values(state.events).some((event) => event.status === 'REVIEW') },
    activationRequired: !config.liveEnabled || !config.activationAt || notStarted || rules.payout !== 'ENABLED' || rules.funding !== 'ENABLED',
    webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
    transferPermission: 'not_exercised',
    ...(billsPolicy ? { bills: summarizeBillsPolicy(billsPolicy) } : {}),
    roth,
  };
}

/** Dependency injection keeps every unit test offline, including HTTP routing. */
export function createApp({ env = process.env, now = () => Date.now(), clientFactory, storeFactory, billsReader, rothReader, monthlyReader, alertSenderFactory, background, log = console } = {}) {
  async function dependencies(baseConfig, readOnly, allowKnownTransferObservation = false) {
    const store = storeFactory ? storeFactory() : createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
    let config = baseConfig, billsPolicy, policyError;
    try {
      const resolved = await resolveBillsConfiguration(config, { connectionString: env.GLOBAL_CONFIG, getAll: billsReader, now: now() });
      config = resolved.config;
      billsPolicy = resolved.policy;
    } catch (error) {
      if (!allowKnownTransferObservation) throw error;
      const state = validateState((await store.read())?.value ?? initialState());
      const child = state.active && state.events[state.active.eventKey]?.children[state.active.allocationId];
      const monthlyPending = config.monthly?.enabled && Object.values(state.monthly?.cycles ?? {}).some(cycle => Object.values(cycle.children).some(row => row.transferId && row.status === 'PENDING'));
      // A catalog outage must not hide an already accepted transfer. Only its
      // known provider ID can be observed; no unknown request may be retried.
      if (!child?.transferId && !monthlyPending) throw error;
      policyError = safeCode(error);
      readOnly = true;
    }
    const roth = await resolveRothPolicy(config, { connectionString: env.GLOBAL_CONFIG, getAll: rothReader, now: now() });
    const monthly = await resolveMonthlyPolicy(config, { connectionString: env.GLOBAL_CONFIG, getAll: monthlyReader, now: now() });
    const client = clientFactory ? clientFactory(config, readOnly) : new SequenceClient({
      apiKey: env.SEQUENCE_API_KEY, liveEnabled: !readOnly && config.liveEnabled,
      allowedPairs: [
        ...config.allocations.filter((a) => a.enabled).map((a) => [config.accounts.income, a.destinationAccountId]),
        ...(config.roth?.enabled ? [[config.accounts.income, config.roth.accountId]] : []),
        ...(config.monthly?.enabled ? [
          [config.accounts.income, config.accounts.emergency], [config.accounts.emergency, config.accounts.income],
          [config.accounts.income, config.monthly.projectAccountId], [config.accounts.income, config.monthly.personalAccountId],
        ] : []),
      ],
      // Monthly execution refreshes seven roles and four disabled rules before
      // each independently reserved leg; six legs exceed the legacy budget.
      now, maxRequests: config.monthly?.enabled ? 250 : 90, deadlineAt: now() + 230_000,
    });
    const sendAlert = config.monthly?.enabled ? (alertSenderFactory ? alertSenderFactory({ config, readOnly }) : createAlertSender({ env, liveEnabled: !readOnly && config.liveEnabled })) : null;
    return { config, client, store, now, billsPolicy, ...roth, ...monthly, sendAlert, ...(policyError ? { forceObserve: true, policyError } : {}) };
  }
  async function run(args) {
    const result = await (args.config.monthly?.enabled ? reconcileMonthly(args) : reconcile(args));
    if (['blocked', 'review', 'uncertain'].includes(result.status)) log.error(JSON.stringify({ component: 'finance-coordinator', status: result.status, code: result.code }));
    return args.policyError ? { ...result, billsPolicyError: args.policyError, newSubmissionsBlocked: true } : result;
  }
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let path = url.pathname.replace(/\/$/, '') || '/';
      // Support both the original pathname and Vercel's rewritten destination.
      // Route selection never bypasses the authorization below.
      if (path === '/api/index' && ['health', 'status', 'preflight', 'plan', 'bills', 'roth', 'monthly', 'alerts', 'reconcile', 'webhook'].includes(url.searchParams.get('route'))) {
        path = `/api/${url.searchParams.get('route')}`;
      }
      if (['/', '/api/health'].includes(path)) {
        if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        const health = publicHealth(env);
        return json(health, health.status === 'ready' ? 200 : 503);
      }
      const isWebhook = path === '/api/webhook';
      if (!isWebhook && !['/api/status', '/api/preflight', '/api/plan', '/api/bills', '/api/roth', '/api/monthly', '/api/alerts', '/api/reconcile'].includes(path)) return json({ code: 'NOT_FOUND' }, 404);
      if (!isWebhook && !authorized(request, env.CRON_SECRET)) return json({ code: 'UNAUTHORIZED' }, 401);
      if (isWebhook && request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      if (!isWebhook && (path === '/api/reconcile' ? !['GET', 'POST'].includes(request.method) : request.method !== 'GET')) return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      try {
        if (env.VERCEL_ENV === 'preview') return json({ code: 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED' }, 503);
        if (env.VERCEL_ENV === 'production' && (isWebhook || path === '/api/reconcile') &&
            (!env.FINANCE_CANONICAL_HOST || new URL(request.url).hostname !== env.FINANCE_CANONICAL_HOST)) {
          return json({ code: 'CANONICAL_PRODUCTION_HOST_REQUIRED' }, 503);
        }
        if (path === '/api/reconcile' && request.body) {
          await request.body.cancel();
          return json({ code: 'RECONCILE_DOES_NOT_ACCEPT_A_BODY' }, 400);
        }
        const config = loadConfig(env);
        if (!config.monthly?.enabled && ['/api/monthly', '/api/alerts'].includes(path)) return json({ code: 'NOT_FOUND' }, 404);
        if (isWebhook) {
          const event = await verifiedWebhook(request, env.SEQUENCE_WEBHOOK_SECRET, now());
          const args = await dependencies(config, false, true);
          const receipt = await recordWebhook(args.store, event, now());
          // A durable receipt plus the cron's complete scan protects a lost wakeup.
          // Duplicate notifications still wake the reconciler to recover an earlier crash.
          if (background) background(run(args).catch((error) => log.error(JSON.stringify({ component: 'finance-coordinator', code: safeCode(error) }))));
          else await run(args);
          return json({ accepted: true, duplicate: receipt.duplicate }, 202);
        }
        const args = await dependencies(config, ['/api/status', '/api/preflight', '/api/plan', '/api/bills', '/api/roth', '/api/monthly', '/api/alerts'].includes(path), path === '/api/reconcile');
        if (config.monthly?.enabled && ['/api/status', '/api/roth', '/api/monthly', '/api/alerts'].includes(path)) {
          const state = validateMonthlyState((await args.store.read())?.value ?? initialState());
          if (path === '/api/alerts') return json({ delivery: summarizeAlertDelivery(env), alerts: Object.values(state.monthly?.alerts ?? {}).map(({ id, code, monthKey, status, createdAt, attempts, deliveredAt, shortfallCents, amountInCents }) =>
            ({ id, code, monthKey, status, createdAt, attempts, deliveredAt, shortfallCents, amountInCents })) });
          const monthly = summarizeMonthlyState({ config: args.config, state, now: now() });
          const roth = summarizeMonthlyRoth({ ...args, state, now: now() });
          if (path === '/api/roth') return json(roth);
          if (path === '/api/monthly') return json({ ...monthly, rothPolicy: roth, sourceValid: Boolean(args.monthlyPolicy && !args.monthlyPolicyError),
            openingVerified: args.monthlyPolicy?.opening?.status === 'verified', policyError: args.monthlyPolicyError, alertDelivery: summarizeAlertDelivery(env) });
          return json({ ...summarizeConfig(args.config), bills: summarizeBillsPolicy(args.billsPolicy), roth, monthly,
            alertDelivery: summarizeAlertDelivery(env), lastRun: state.lastRun });
        }
        if (path === '/api/roth') {
          const state = validateState((await args.store.read())?.value ?? initialState());
          return json(summarizeRothState({ ...args, state, now: now() }));
        }
        if (path === '/api/status') {
          const state = validateState((await args.store.read())?.value ?? initialState());
          return json({ ...summarizeConfig(args.config), bills: summarizeBillsPolicy(args.billsPolicy),
            roth: summarizeRothState({ ...args, state, now: now() }), lastRun: state.lastRun, activeIntent: state.active ? {
            allocationId: state.active.allocationId,
            status: state.events[state.active.eventKey].children[state.active.allocationId].status,
          } : null, handledEvents: Object.values(state.events).filter((event) => event.status === 'COMPLETE').length,
          reviewRequired: Object.values(state.events).some((event) => event.status === 'REVIEW') });
        }
        if (path === '/api/bills') return json({ ...summarizeBillsPolicy(args.billsPolicy), months: args.billsPolicy.forecast.months,
          annualTotalCents: args.billsPolicy.forecast.annualTotalCents, includedBillCount: args.billsPolicy.forecast.includedBillCount });
        if (path === '/api/preflight') return json(await preflight({ ...args, env }));
        if (path === '/api/plan') return json(await (config.monthly?.enabled ? previewMonthly(args) : preview(args)));
        // Query parameters cannot supply accounts, amounts, targets, or modes.
        const result = await run(args);
        return json(result, ['blocked', 'review', 'uncertain'].includes(result.status) ? 503 : 200);
      } catch (error) {
        const code = safeCode(error);
        const status = error.name === 'WebhookError' ? error.status : 503;
        if (status >= 500) log.error(JSON.stringify({ component: 'finance-coordinator', code }));
        return json({ code }, status);
      }
    },
  };
}
