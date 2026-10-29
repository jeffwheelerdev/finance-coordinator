import { createHash, timingSafeEqual } from 'node:crypto';
import { VERSION, loadConfig, summarizeConfig } from './config.mjs';
import { SequenceClient } from './sequence.mjs';
import { createBlobStore } from './store.mjs';
import { reconcile, preview, initialState, validateState, safeCode } from './engine.mjs';
import { validateAccount, checkRules } from './evidence.mjs';
import { verifiedWebhook, recordWebhook } from './webhook.mjs';
import { verifyUpstreamFunding } from './upstream.mjs';

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
  const credentialsPresent = Boolean(env.SEQUENCE_API_KEY && env.BLOB_READ_WRITE_TOKEN && env.CRON_SECRET?.length >= 16);
  return {
    version: VERSION, status: credentialsPresent ? 'ready' : 'configuration_required',
    mode: config.mode, liveEnabled: config.liveEnabled, credentialsPresent,
    webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
  };
}

export async function preflight({ config, client, store, env, now = () => Date.now() }) {
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
  return {
    version: VERSION, status: 'read_checks_passed', configuration: summarizeConfig(config), rules, upstream,
    ledger: { initialized: state.lastRun !== null, unresolvedIntent: Boolean(state.active), reviewRequired: Object.values(state.events).some((event) => event.status === 'REVIEW') },
    activationRequired: !config.liveEnabled || !config.activationAt || notStarted || rules.payout !== 'ENABLED' || rules.funding !== 'ENABLED',
    webhookConfigured: Boolean(env.SEQUENCE_WEBHOOK_SECRET?.length >= 16),
    transferPermission: 'not_exercised',
  };
}

/** Dependency injection keeps every unit test offline, including HTTP routing. */
export function createApp({ env = process.env, now = () => Date.now(), clientFactory, storeFactory, background, log = console } = {}) {
  function dependencies(config, readOnly) {
    const client = clientFactory ? clientFactory(config, readOnly) : new SequenceClient({
      apiKey: env.SEQUENCE_API_KEY, liveEnabled: !readOnly && config.liveEnabled,
      allowedPairs: config.allocations.filter((a) => a.enabled).map((a) => [config.accounts.income, a.destinationAccountId]),
      now, maxRequests: 90, deadlineAt: now() + 230_000,
    });
    const store = storeFactory ? storeFactory() : createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
    return { config, client, store, now };
  }
  async function run(args) {
    const result = await reconcile(args);
    if (['blocked', 'review', 'uncertain'].includes(result.status)) log.error(JSON.stringify({ component: 'finance-coordinator', status: result.status, code: result.code }));
    return result;
  }
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let path = url.pathname.replace(/\/$/, '') || '/';
      // Support both the original pathname and Vercel's rewritten destination.
      // Route selection never bypasses the authorization below.
      if (path === '/api/index' && ['health', 'status', 'preflight', 'plan', 'reconcile', 'webhook'].includes(url.searchParams.get('route'))) {
        path = `/api/${url.searchParams.get('route')}`;
      }
      if (['/', '/api/health'].includes(path)) {
        if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        const health = publicHealth(env);
        return json(health, health.status === 'ready' ? 200 : 503);
      }
      const isWebhook = path === '/api/webhook';
      if (!isWebhook && !['/api/status', '/api/preflight', '/api/plan', '/api/reconcile'].includes(path)) return json({ code: 'NOT_FOUND' }, 404);
      if (!isWebhook && !authorized(request, env.CRON_SECRET)) return json({ code: 'UNAUTHORIZED' }, 401);
      if (isWebhook && request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      if (!isWebhook && (path === '/api/reconcile' ? !['GET', 'POST'].includes(request.method) : request.method !== 'GET')) return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      try {
        if (env.VERCEL_ENV === 'preview') return json({ code: 'PREVIEW_FINANCIAL_OPERATIONS_DISABLED' }, 503);
        if (env.VERCEL_ENV === 'production' && (isWebhook || path === '/api/reconcile') &&
            (!env.FINANCE_CANONICAL_HOST || new URL(request.url).hostname !== env.FINANCE_CANONICAL_HOST)) {
          return json({ code: 'CANONICAL_PRODUCTION_HOST_REQUIRED' }, 503);
        }
        const config = loadConfig(env);
        const args = dependencies(config, ['/api/status', '/api/preflight', '/api/plan'].includes(path));
        if (isWebhook) {
          const event = await verifiedWebhook(request, env.SEQUENCE_WEBHOOK_SECRET, now());
          const receipt = await recordWebhook(args.store, event, now());
          // A durable receipt plus the cron's complete scan protects a lost wakeup.
          // Duplicate notifications still wake the reconciler to recover an earlier crash.
          if (background) background(run(args).catch((error) => log.error(JSON.stringify({ component: 'finance-coordinator', code: safeCode(error) }))));
          else await run(args);
          return json({ accepted: true, duplicate: receipt.duplicate }, 202);
        }
        if (path === '/api/status') {
          const state = validateState((await args.store.read())?.value ?? initialState());
          return json({ ...summarizeConfig(config), lastRun: state.lastRun, activeIntent: state.active ? {
            allocationId: state.active.allocationId,
            status: state.events[state.active.eventKey].children[state.active.allocationId].status,
          } : null, handledEvents: Object.values(state.events).filter((event) => event.status === 'COMPLETE').length,
          reviewRequired: Object.values(state.events).some((event) => event.status === 'REVIEW') });
        }
        if (path === '/api/preflight') return json(await preflight({ ...args, env }));
        if (path === '/api/plan') return json(await preview(args));
        // Neither query parameters nor a body can supply accounts, amounts, or modes.
        if (request.body) {
          await request.body.cancel();
          return json({ code: 'RECONCILE_DOES_NOT_ACCEPT_A_BODY' }, 400);
        }
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
