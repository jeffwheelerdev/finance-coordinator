import { loadConfig } from '../lib/config.mjs';
import { SequenceClient } from '../lib/sequence.mjs';
import { createBlobStore } from '../lib/store.mjs';
import { preflight } from '../lib/app.mjs';
import { reconcile, safeCode } from '../lib/engine.mjs';

// This script can be run in a production build without ever enabling a POST to
// Sequence, including on a future live deployment. Never print credentials or IDs.
export async function verifyDeployment(env = process.env) {
  const config = loadConfig(env);
  const client = new SequenceClient({ apiKey: env.SEQUENCE_API_KEY, liveEnabled: false, maxRequests: 90, deadlineAt: Date.now() + 230_000 });
  const store = createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  const checks = await preflight({ config, client, store, env });
  const observation = await reconcile({ config, client, store, forceObserve: true });
  if (['blocked', 'uncertain', 'review'].includes(observation.status)) {
    throw Object.assign(new Error('Read-only deployment validation failed'), { code: observation.code });
  }
  return {
    version: checks.version, readChecks: 'passed', liveWritesTested: false,
    activationRequired: checks.activationRequired, webhookConfigured: checks.webhookConfigured,
    ledger: observation.status === 'busy' ? 'busy_existing_worker' : 'conditional_write_verified',
    observation: { status: observation.status, code: observation.code },
  };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try { console.log(JSON.stringify(await verifyDeployment())); }
  catch (error) { console.error(JSON.stringify({ status: 'preflight_failed', code: safeCode(error) })); process.exitCode = 1; }
}
