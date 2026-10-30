import { loadConfig } from '../lib/config.mjs';
import { SequenceClient } from '../lib/sequence.mjs';
import { createBlobStore } from '../lib/store.mjs';
import { preflight } from '../lib/app.mjs';
import { reconcile, safeCode } from '../lib/engine.mjs';
import { resolveBillsConfiguration, summarizeBillsPolicy } from '../lib/bills-source.mjs';
import { resolveRothPolicy } from '../lib/roth-source.mjs';
import { resolveMonthlyPolicy } from '../lib/monthly-source.mjs';
import { reconcileMonthly } from '../lib/monthly-engine.mjs';
import { resolveActivationPolicy } from '../lib/activation-source.mjs';
import { assertActivationReadyForDeployment } from '../lib/activation-readiness.mjs';

// This script can be run in a production build without ever enabling a POST to
// Sequence, including on a future live deployment. Never print credentials or IDs.
export async function verifyDeployment(env = process.env) {
  const resolved = await resolveBillsConfiguration(loadConfig(env), { connectionString: env.GLOBAL_CONFIG });
  const config = resolved.config;
  const roth = await resolveRothPolicy(config, { connectionString: env.GLOBAL_CONFIG });
  const monthly = await resolveMonthlyPolicy(config, { connectionString: env.GLOBAL_CONFIG });
  const readiness = await resolveActivationPolicy(config, { connectionString: env.GLOBAL_CONFIG });
  const client = new SequenceClient({ apiKey: env.SEQUENCE_API_KEY, liveEnabled: false, maxRequests: 90, deadlineAt: Date.now() + 230_000 });
  const store = createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  const checks = await preflight({ config, client, store, env, billsPolicy: resolved.policy, ...roth, ...monthly, ...readiness });
  if (config.monthly?.enabled) console.log(JSON.stringify({ component: 'activation-readiness',
    status: checks.readiness.status, readyForActivation: checks.readiness.readyForActivation,
    activationEstablished: checks.readiness.activationEstablished, nextCycle: checks.readiness.nextCycle,
    blockers: checks.readiness.blockers }));
  if (config.monthly?.enabled) console.log(JSON.stringify({ component: 'sequence-retirement',
    configured: Boolean(config.monthly.sequenceRetirement),
    monthlyBindingPresent: checks.ledger.monthlyBindingPresent,
    inventory: checks.nativeRuleInventory, ruleStatuses: checks.rules }));
  assertActivationReadyForDeployment(config, checks.readiness);
  const observation = await (config.monthly?.enabled ? reconcileMonthly : reconcile)({ config, client, store, forceObserve: true, ...roth, ...monthly });
  const stagedMonthlyBlocker = config.monthly?.enabled && config.mode === 'observe' && !config.liveEnabled &&
    ['INCOME_OPENING_UNVERIFIED', 'MONTHLY_ACTIVATION_REQUIRED'].includes(observation.code);
  if (['blocked', 'uncertain', 'review'].includes(observation.status) && !stagedMonthlyBlocker) {
    throw Object.assign(new Error('Read-only deployment validation failed'), { code: observation.code });
  }
  return {
    version: checks.version, readChecks: 'passed', liveWritesTested: false,
    activationRequired: checks.activationRequired, webhookConfigured: checks.webhookConfigured,
    ledger: observation.status === 'busy' ? 'busy_existing_worker' : 'conditional_write_verified',
    bills: { source: 'private_global_config', monitorFresh: true,
      calculatedTargetAvailable: summarizeBillsPolicy(resolved.policy).targetCents > 0,
      priorityOrder: config.monthly?.enabled ? ['bills', 'general-spending', 'emergency-fund', 'roth-ira', 'project-savings', 'personal-investment'] : config.allocations.filter(item => item.enabled).map(item => item.id) },
    observation: { status: observation.status, code: observation.code },
    // Keep the build receipt below provider log truncation limits. The complete
    // twelve-month plan belongs in the authenticated Roth/status endpoints.
    roth: {
      configured: checks.roth.configured,
      sourceValid: Boolean(roth.rothPolicy && !roth.rothPolicyError),
      year: checks.roth.year,
      previewAnnualLimitCents: checks.roth.previewAnnualLimitCents,
      monthlyAmountCents: checks.roth.monthlyAmountCents,
      executionEnabled: checks.roth.executionEnabled,
      destinationVerified: checks.roth.destinationVerified,
      ...(checks.roth.destinationError ? { destinationError: checks.roth.destinationError } : {}),
      blockers: checks.roth.blockers,
    },
    ...(config.monthly?.enabled ? { monthly: { sourceValid: checks.monthly.sourceValid,
      openingVerified: checks.monthly.openingVerified, accountRolesVerified: checks.monthly.accountRolesVerified,
      schedule: 'first_of_month', annualCloseMonth: config.monthly.annualCloseMonth, blockers: checks.monthly.blockers },
      email: checks.alertDelivery,
      readiness: { status: checks.readiness.status, readyForActivation: checks.readiness.readyForActivation,
        activationEstablished: checks.readiness.activationEstablished, nextCycle: checks.readiness.nextCycle,
        blockers: checks.readiness.blockers } } : {}),
  };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try { console.log(JSON.stringify(await verifyDeployment())); }
  catch (error) { console.error(JSON.stringify({ status: 'preflight_failed', code: safeCode(error) })); process.exitCode = 1; }
}
