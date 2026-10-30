import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { VERSION, loadConfig, summarizeConfig } from './config.mjs';
import { SequenceClient } from './sequence.mjs';
import { createBlobStore } from './store.mjs';
import { reconcile, preview, initialState, validateState, safeCode, summarizeRothState } from './engine.mjs';
import { validateAccount, checkRules } from './evidence.mjs';
import { verifiedWebhook, recordWebhook } from './webhook.mjs';
import { verifyUpstreamFunding } from './upstream.mjs';
import { resolveBillsConfiguration, summarizeBillsPolicy } from './bills-source.mjs';
import { forecastBills } from './bills.mjs';
import { resolveRothPolicy } from './roth-source.mjs';
import { validateRothDestination } from './roth-evidence.mjs';
import { reconcileMonthly, previewMonthly, validateMonthlyState, summarizeMonthlyState, monthlyOwnedTransfers, summarizeMonthlyRoth } from './monthly-engine.mjs';
import { readMonthlyEvidence } from './monthly-evidence.mjs';
import { resolveMonthlyPolicy } from './monthly-source.mjs';
import { incomeScanFrom, reconcileIncome } from './income-ledger.mjs';
import { createAlertSender, summarizeAlertDelivery } from './alerts.mjs';
import { EmailSetupError, sendEmailSetupTest } from './email.mjs';
import { resolveActivationPolicy } from './activation-source.mjs';
import { buildActivationReadiness } from './activation-readiness.mjs';
import { DashboardAccessError, dashboardSession, authorizeDashboardMutation, readDashboardJson, dashboardJson } from './dashboard-access.mjs';
import { resolveDashboardConfig, dashboardControlView, prepareDashboardControlUpdate } from './dashboard-controls.mjs';
import { buildDashboardView, dashboardActivity, dashboardDebug, simulateDashboardPlan } from './dashboard-view.mjs';
import generatedRehearsal from './generated-rehearsal.mjs';
import { readDashboardRehearsalReceipt } from './dashboard-receipt.mjs';
import { SchedulerProbeError, assertSchedulerProbeEnvironment, prepareSchedulerProbe,
  recordSchedulerProbePublication, summarizeSchedulerProbe } from './scheduler-probe.mjs';

const DASHBOARD_METHODS = Object.freeze({
  '/api/dashboard': 'GET', '/api/dashboard/activity': 'GET', '/api/dashboard/debug': 'GET',
  '/api/dashboard/simulate': 'POST', '/api/dashboard/settings': 'POST', '/api/dashboard/settings/preview': 'POST', '/api/dashboard/diagnostics': 'POST',
  '/api/dashboard/scheduler-test': 'POST',
});
function dashboardShape(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(key => !Object.hasOwn(value, key))) throw new DashboardAccessError('DASHBOARD_REQUEST_INVALID', 400);
}
function dashboardQuery(url, path) {
  const seen = new Set(), allowed = path === '/api/dashboard/activity' ? ['cursor', 'limit'] : [];
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !(allowed.includes(key) || key === 'route' && value === path.slice('/api/'.length))) {
      throw new DashboardAccessError('DASHBOARD_QUERY_INVALID', 400);
    }
    seen.add(key);
  }
}

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

export async function preflight({ config, client, store, env, billsPolicy, rothPolicy, rothEvidence, rothPolicyError, monthlyPolicy, monthlyPolicyError, readinessEvidence, readinessEvidenceError, now = () => Date.now() }) {
  if (config.monthly?.enabled) {
    const state = validateMonthlyState((await store.read())?.value ?? initialState());
    config = resolveDashboardConfig(config, state, { now: now() });
    // An unverified opening is a deliberate activation blocker. Connection,
    // account-role, rule, and source-read checks still run without inventing one.
    const externalFrom = incomeScanFrom(monthlyPolicy, state.monthly?.income) ?? new Date(now() - 7 * 86400000).toISOString();
    const evidence = await readMonthlyEvidence(client, config, { now: now(), externalFrom,
      knownTransfers: monthlyOwnedTransfers(state).filter(row => row.transferId), lastSettledAt: state.monthly?.lastSettledAt ?? state.lastSettledAt });
    const roth = summarizeMonthlyRoth({ config, state, rothPolicy, rothEvidence, rothPolicyError, now: now() });
    const alertDelivery = summarizeAlertDelivery(env);
    const readiness = buildActivationReadiness({ config, state, evidence, billsPolicy, monthlyPolicy, monthlyPolicyError,
      rothPolicy, rothEvidence, rothPolicyError, readinessEvidence, readinessEvidenceError, now: now(),
      alertDelivery: { ...alertDelivery, recipient: env.ALERTS_EMAIL_TO, sender: env.ALERTS_EMAIL_FROM } });
    const blockers = [
      ...(monthlyPolicyError ? [monthlyPolicyError] : []),
      ...(monthlyPolicy?.opening?.status !== 'verified' ? ['INCOME_OPENING_UNVERIFIED'] : []),
      ...(!alertDelivery.configured ? ['MONTHLY_ALERT_DELIVERY_REQUIRED'] : []),
      ...(!config.liveEnabled || !config.activationAt ? ['MONTHLY_ACTIVATION_REQUIRED'] : []),
    ];
    return { version: VERSION, status: 'read_checks_passed', configuration: summarizeConfig(config),
      rules: evidence.nativeRuleStatuses, nativeRuleInventory: evidence.nativeRuleInventory ?? null,
      transferPermission: 'not_exercised', readiness,
      activationRequired: !readiness.executionEnabled || !readiness.readyForActivation,
      webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
      ledger: { initialized: state.lastRun !== null, monthlyBindingPresent: Boolean(state.monthly?.bindingHash),
        unresolvedIntent: monthlyOwnedTransfers(state).some(r => r.status !== 'COMPLETE'),
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
export function createApp({ env = process.env, now = () => Date.now(), clientFactory, storeFactory, billsReader, rothReader, monthlyReader, readinessReader, alertSenderFactory, emailTestFetch, rehearsalReceipt = generatedRehearsal, schedulerProbePublisher, background, log = console } = {}) {
  async function dashboardState() {
    const baseConfig = loadConfig(env);
    if (!baseConfig.monthly?.enabled) throw new DashboardAccessError('DASHBOARD_MONTHLY_REQUIRED', 503);
    const store = storeFactory ? storeFactory() : createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
    const record = await store.read();
    const state = validateMonthlyState(structuredClone(record?.value ?? initialState()));
    const config = resolveDashboardConfig(baseConfig, state, { now: now() });
    return { baseConfig, config, store, record, state };
  }
  async function dashboardSources(context) {
    const at = now(), connectionString = env.GLOBAL_CONFIG;
    const results = await Promise.allSettled([
      resolveBillsConfiguration(context.config, { connectionString, getAll: billsReader, now: at }),
      resolveRothPolicy(context.config, { connectionString, getAll: rothReader, now: at }),
      resolveMonthlyPolicy(context.config, { connectionString, getAll: monthlyReader, now: at }),
      resolveActivationPolicy(context.config, { connectionString, getAll: readinessReader ?? monthlyReader, now: at }),
    ]);
    const sectionErrors = {}, extra = {};
    const [bills, roth, monthly, activation] = results;
    if (bills.status === 'fulfilled') { context.config = bills.value.config; extra.billsPolicy = bills.value.policy; }
    else sectionErrors.bills = safeCode(bills.reason);
    if (roth.status === 'fulfilled') { Object.assign(extra, roth.value); if (roth.value.rothPolicyError) sectionErrors.roth = roth.value.rothPolicyError; }
    else { extra.rothPolicyError = sectionErrors.roth = safeCode(roth.reason); }
    if (monthly.status === 'fulfilled') { Object.assign(extra, monthly.value); if (monthly.value.monthlyPolicyError) sectionErrors.income = monthly.value.monthlyPolicyError; }
    else { extra.monthlyPolicyError = sectionErrors.income = safeCode(monthly.reason); }
    if (activation.status === 'fulfilled') { Object.assign(extra, activation.value); if (activation.value.readinessEvidenceError) sectionErrors.readiness = activation.value.readinessEvidenceError; }
    else { extra.readinessEvidenceError = sectionErrors.readiness = safeCode(activation.reason); }
    return { ...context, ...extra, sectionErrors, now };
  }
  function dashboardSnapshot(args, extra = {}) {
    return buildDashboardView({ config: args.config, state: args.state,
      settings: dashboardControlView({ config: args.baseConfig, state: args.state, now: now() }),
      billsPolicy: args.billsPolicy, rothSummary: summarizeMonthlyRoth({ ...args, now: now() }),
      sectionErrors: args.sectionErrors, tests: { offline: readDashboardRehearsalReceipt(rehearsalReceipt, { now: now() }),
        scheduler: summarizeSchedulerProbe({ state: args.state, env, now: now() }) }, now: now(), ...extra });
  }
  async function dashboard(request, path, url) {
    let session;
    try {
      if (!Object.hasOwn(DASHBOARD_METHODS, path)) return dashboardJson({ code: 'NOT_FOUND' }, { status: 404 });
      if (request.method !== DASHBOARD_METHODS[path]) return dashboardJson({ code: 'METHOD_NOT_ALLOWED' }, { status: 405 });
      dashboardQuery(url, path);
      session = request.method === 'POST' ? authorizeDashboardMutation(request, { env, now: now() }) :
        dashboardSession(request, { env, now: now(), create: path === '/api/dashboard' });
      const body = request.method === 'POST' ? await readDashboardJson(request) : null;
      if (path === '/api/dashboard/scheduler-test') {
        dashboardShape(body, []); assertSchedulerProbeEnvironment(env);
        const args = await dashboardState();
        const prepared = prepareSchedulerProbe({ state: args.state, env, now: now(), id: randomUUID() });
        // This pending intent is durable before queue publication. Lost publish
        // responses retain the same private id and cooldown instead of guessing.
        await args.store.compareAndSwap(args.record?.etag ?? null, prepared.state);
        let state = prepared.state;
        try {
          const publish = schedulerProbePublisher ?? (await import('./scheduler.mjs')).publishSchedulerProbe;
          const published = await publish({ env, probe: prepared.probe, now });
          if (published?.status !== 'queued' || published.deliveryConfirmed !== false || published.expiresAt !== prepared.probe.expiresAt) {
            throw new SchedulerProbeError('SCHEDULER_PROBE_QUEUE_UNCONFIRMED');
          }
        } catch {
          try { state = await recordSchedulerProbePublication({ env, probe: prepared.probe, outcome: 'unknown', now, store: args.store }); }
          catch { /* The pending intent remains durable; no blind financial-state overwrite. */ }
          return dashboardJson({ schemaVersion: 1, code: 'SCHEDULER_PROBE_QUEUE_UNCONFIRMED',
            scheduler: summarizeSchedulerProbe({ state, env, now: now() }), realTransfers: 0, realEmails: 0 }, { status: 503, session });
        }
        try { state = await recordSchedulerProbePublication({ env, probe: prepared.probe, outcome: 'queued', now, store: args.store }); }
        catch { /* A queue delivery can finish the original pending intent later. */ }
        const scheduler = summarizeSchedulerProbe({ state, env, now: now() });
        return dashboardJson({ schemaVersion: 1, status: scheduler.status, scheduler, realTransfers: 0, realEmails: 0 }, { status: 202, session });
      }
      if (path === '/api/dashboard/settings' || path === '/api/dashboard/settings/preview') {
        const reviewedMonth = path === '/api/dashboard/settings' && Object.hasOwn(body, 'expectedEffectiveMonth');
        dashboardShape(body, ['expectedRevision', 'changes', ...(reviewedMonth ? ['expectedEffectiveMonth'] : [])]);
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new DashboardAccessError('DASHBOARD_SETTINGS_INVALID', 400);
        if (reviewedMonth && (typeof body.expectedEffectiveMonth !== 'string' || !/^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(body.expectedEffectiveMonth))) {
          throw new DashboardAccessError('DASHBOARD_SETTINGS_INVALID', 400);
        }
        const args = await dashboardState();
        const update = prepareDashboardControlUpdate({ config: args.baseConfig, state: args.state,
          expectedRevision: body.expectedRevision, changes: body.changes, now: now(), actor: 'owner' });
        if (reviewedMonth && body.expectedEffectiveMonth !== update.state.dashboardControls.versions.at(-1).effectiveMonth) {
          throw new DashboardAccessError('DASHBOARD_SETTINGS_PREVIEW_EXPIRED', 409);
        }
        const settings = buildDashboardView({ config: resolveDashboardConfig(args.baseConfig, update.state, { now: now() }),
          state: update.state, settings: update.settings, now: now() }).settings;
        if (path === '/api/dashboard/settings/preview') return dashboardJson({ schemaVersion: 1, settings,
          preview: true, financialLedgerModified: false, realTransfers: 0 }, { session });
        // One exact conditional save. A concurrent reconcile or settings save
        // wins by ETag; never replay a stale edit onto the newer financial state.
        await args.store.compareAndSwap(args.record?.etag ?? null, update.state);
        return dashboardJson({ schemaVersion: 1, status: 'saved', settings, realTransfers: 0 }, { session });
      }
      if (path === '/api/dashboard/simulate') dashboardShape(body, ['input']);
      if (path === '/api/dashboard/diagnostics') dashboardShape(body, []);
      const context = await dashboardState();
      if (path === '/api/dashboard/activity') {
        const rawLimit = url.searchParams.get('limit');
        if (rawLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawLimit)) throw new DashboardAccessError('DASHBOARD_ACTIVITY_LIMIT_INVALID', 400);
        return dashboardJson(dashboardActivity({ state: context.state, cursor: url.searchParams.get('cursor'),
          limit: rawLimit === null ? 25 : Number(rawLimit) }), { session });
      }
      const args = await dashboardSources(context);
      if (path === '/api/dashboard/simulate') {
        if (typeof body.input?.monthKey !== 'string' || !/^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(body.input.monthKey)) {
          throw new DashboardAccessError('DASHBOARD_SIMULATION_INPUT_INVALID', 400);
        }
        const scenarioAt = Date.parse(`${body.input.monthKey}-15T15:00:00.000Z`);
        const config = resolveDashboardConfig(args.config, args.state, { now: now(), monthKey: body.input.monthKey });
        const roth = summarizeMonthlyRoth({ ...args, config, now: scenarioAt });
        const bills = args.billsPolicy?.catalog ? forecastBills(args.billsPolicy.catalog, { now: scenarioAt }) : null;
        return dashboardJson(simulateDashboardPlan({ config, settings: config.dashboardControls?.settings,
          billsTargetCents: bills?.targetCents ?? null, rothMonthlyCents: roth.monthlyAmountCents ?? null,
          input: body.input, now: now() }), { session });
      }
      if (path === '/api/dashboard/diagnostics') {
        const checkedAt = new Date(now()).toISOString();
        let evidence, incomePools;
        const checks = ['bills', 'roth', 'income', 'readiness'].map(section => ({ id: `${section}_source`,
          status: args.sectionErrors[section] ? 'blocked' : 'passed', checkedAt, code: args.sectionErrors[section] ?? null }));
        try {
          const client = clientFactory ? clientFactory(args.config, true) : new SequenceClient({ apiKey: env.SEQUENCE_API_KEY,
            liveEnabled: false, allowedPairs: [], now, maxRequests: 70, timeoutMs: 5000, deadlineAt: now() + 45_000 });
          // Only these read capabilities enter the diagnostic evidence builder.
          // No transfer/trigger methods, alert sender, or writable store enter it.
          const reader = Object.fromEntries(['listRules', 'getRule', 'listTransfers', 'getAccount', 'listExternalTransactions']
            .map(method => [method, (...params) => client[method](...params)]));
          evidence = await readMonthlyEvidence(Object.freeze(reader), args.config, { now: now(),
            externalFrom: incomeScanFrom(args.monthlyPolicy, args.state.monthly?.income) ?? new Date(now() - 7 * 86400000).toISOString(),
            knownTransfers: monthlyOwnedTransfers(args.state).filter(row => row.transferId),
            lastSettledAt: args.state.monthly?.lastSettledAt ?? args.state.lastSettledAt });
          checks.push({ id: 'account_evidence', status: 'passed', checkedAt, code: null });
        } catch (error) {
          args.sectionErrors.accounts = safeCode(error);
          checks.push({ id: 'account_evidence', status: 'blocked', checkedAt, code: safeCode(error) });
        }
        if (evidence && args.monthlyPolicy && !args.monthlyPolicyError) {
          try {
            incomePools = reconcileIncome({ policy: args.monthlyPolicy, ledger: args.state.monthly?.income ?? null,
              evidence, ownedTransfers: monthlyOwnedTransfers(args.state) });
            checks.push({ id: 'income_reconciliation', status: 'passed', checkedAt, code: null });
          } catch (error) {
            args.sectionErrors.income = safeCode(error);
            checks.push({ id: 'income_reconciliation', status: 'blocked', checkedAt, code: safeCode(error) });
          }
        }
        const readiness = buildActivationReadiness({ ...args, evidence, now: now(),
          alertDelivery: { ...summarizeAlertDelivery(env), recipient: env.ALERTS_EMAIL_TO, sender: env.ALERTS_EMAIL_FROM } });
        const snapshot = dashboardSnapshot(args, { readiness, evidence, incomePools });
        return dashboardJson({ ...snapshot, csrfToken: session.csrfToken, sessionExpiresAt: session.expiresAt, diagnosticSummary: {
          checkedAt, status: checks.some(row => row.status === 'blocked') ? 'partial' : 'completed',
          readOnly: true, realTransfers: 0, financialLedgerWrites: 0, checks } }, { session });
      }
      const snapshot = dashboardSnapshot(args);
      if (path === '/api/dashboard/debug') return dashboardJson(dashboardDebug({ snapshot, state: args.state, now: now() }), { session });
      return dashboardJson({ ...snapshot, csrfToken: session.csrfToken, sessionExpiresAt: session.expiresAt }, { session });
    } catch (error) {
      const code = safeCode(error);
      const conflict = ['STORE_CONFLICT', 'DASHBOARD_SETTINGS_CONFLICT', 'DASHBOARD_WORKER_ACTIVE', 'DASHBOARD_ACTIVITY_CHANGED'].includes(code);
      const status = error instanceof DashboardAccessError || error instanceof SchedulerProbeError ? error.status : conflict ? 409 :
        /^(?:DASHBOARD_(?:SETTINGS|ACTIVITY|SIMULATION|SCENARIO|INPUT|REQUEST))/.test(code) ? 400 : 503;
      if (status >= 500) log.error(JSON.stringify({ component: 'finance-dashboard', code }));
      return dashboardJson({ code }, { status });
    }
  }
  async function dependencies(baseConfig, readOnly, allowKnownTransferObservation = false, includeReadiness = false) {
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
    const readiness = includeReadiness ? await resolveActivationPolicy(config, {
      connectionString: env.GLOBAL_CONFIG, getAll: readinessReader ?? monthlyReader, now: now() }) : {};
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
    return { config, client, store, now, billsPolicy, ...roth, ...monthly, ...readiness, sendAlert, ...(policyError ? { forceObserve: true, policyError } : {}) };
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
      if (path === '/api/index' && ['health', 'status', 'preflight', 'readiness', 'plan', 'bills', 'roth', 'monthly', 'alerts', 'alerts/test', 'reconcile', 'webhook',
        'dashboard', 'dashboard/activity', 'dashboard/debug', 'dashboard/simulate', 'dashboard/settings', 'dashboard/settings/preview', 'dashboard/diagnostics', 'dashboard/scheduler-test'].includes(url.searchParams.get('route'))) {
        path = `/api/${url.searchParams.get('route')}`;
      }
      if (path === '/api/dashboard' || path.startsWith('/api/dashboard/')) return dashboard(request, path, url);
      if (['/', '/api/health'].includes(path)) {
        if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        const health = publicHealth(env);
        return json(health, health.status === 'ready' ? 200 : 503);
      }
      const isWebhook = path === '/api/webhook';
      const isEmailTest = path === '/api/alerts/test';
      if (!isWebhook && !['/api/status', '/api/preflight', '/api/readiness', '/api/plan', '/api/bills', '/api/roth', '/api/monthly', '/api/alerts', '/api/alerts/test', '/api/reconcile'].includes(path)) return json({ code: 'NOT_FOUND' }, 404);
      if (!isWebhook && !authorized(request, env.CRON_SECRET)) return json({ code: 'UNAUTHORIZED' }, 401);
      if (isWebhook && request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      if (!isWebhook && (isEmailTest ? request.method !== 'POST' : path === '/api/reconcile' ? !['GET', 'POST'].includes(request.method) : request.method !== 'GET')) return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      try {
        if (env.VERCEL_ENV === 'preview') return json({ code: 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED' }, 503);
        if (env.VERCEL_ENV === 'production' && (isWebhook || path === '/api/reconcile') &&
            (!env.FINANCE_CANONICAL_HOST || new URL(request.url).hostname !== env.FINANCE_CANONICAL_HOST)) {
          return json({ code: 'CANONICAL_PRODUCTION_HOST_REQUIRED' }, 503);
        }
        if (isEmailTest) {
          // This branch deliberately precedes loadConfig and dependencies: email
          // preparation never constructs a financial client or reads a ledger.
          if (env.VERCEL_ENV !== 'production') return json({ code: 'EMAIL_SETUP_PRODUCTION_REQUIRED' }, 503);
          if (!env.FINANCE_CANONICAL_HOST || url.origin !== `https://${env.FINANCE_CANONICAL_HOST}`) {
            return json({ code: 'CANONICAL_PRODUCTION_HOST_REQUIRED' }, 503);
          }
          const query = [...url.searchParams.entries()];
          if (request.body || query.length && !(query.length === 1 && query[0][0] === 'route' && query[0][1] === 'alerts/test')) {
            await request.body?.cancel();
            return json({ code: 'EMAIL_SETUP_DOES_NOT_ACCEPT_ARGUMENTS' }, 400);
          }
          try { return json(await sendEmailSetupTest({ env, now, fetchImpl: emailTestFetch }), 202); }
          catch (error) {
            if (!(error instanceof EmailSetupError)) throw error;
            return json({ code: error.code, status: error.uncertain ? 'unknown' : 'blocked',
              providerAccepted: error.uncertain ? null : false, recipientConfirmed: false,
              financialExecutionEnabled: false, realTransfers: 0 }, 503);
          }
        }
        if (path === '/api/reconcile' && request.body) {
          await request.body.cancel();
          return json({ code: 'RECONCILE_DOES_NOT_ACCEPT_A_BODY' }, 400);
        }
        const config = loadConfig(env);
        if (!config.monthly?.enabled && ['/api/monthly', '/api/alerts', '/api/readiness'].includes(path)) return json({ code: 'NOT_FOUND' }, 404);
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
        const args = await dependencies(config, ['/api/status', '/api/preflight', '/api/readiness', '/api/plan', '/api/bills', '/api/roth', '/api/monthly', '/api/alerts'].includes(path), path === '/api/reconcile', ['/api/preflight', '/api/readiness'].includes(path));
        if (config.monthly?.enabled && ['/api/status', '/api/roth', '/api/monthly', '/api/alerts'].includes(path)) {
          const state = validateMonthlyState((await args.store.read())?.value ?? initialState());
          args.config = resolveDashboardConfig(args.config, state, { now: now() });
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
        if (path === '/api/preflight' || path === '/api/readiness') {
          const checks = await preflight({ ...args, env });
          return json(path === '/api/readiness' ? checks.readiness : checks);
        }
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
