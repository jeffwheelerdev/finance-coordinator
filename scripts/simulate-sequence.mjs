import { pathToFileURL } from 'node:url';
import { loadConfig, VERSION } from '../lib/config.mjs';
import { resolveBillsConfiguration } from '../lib/bills-source.mjs';
import { resolveRothPolicy } from '../lib/roth-source.mjs';
import { assertSequenceSimulationAllowed, runSequenceSimulation, SequenceSimulationError } from '../lib/sequence-simulation.mjs';

/** Explicit production dry-run entry point. It reads private policy through
 * existing runtime configuration; it neither fetches credentials nor opens the
 * financial ledger. There is deliberately no HTTP route for this function. */
export async function verifySequenceSimulation(env = process.env, options = {}) {
  assertSequenceSimulationAllowed(env);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['fetchImpl', 'billsReader', 'rothReader', 'now', 'uuid', 'timeoutMs'].includes(key))) {
    throw new SequenceSimulationError('SIMULATION_INPUT_INVALID');
  }
  const { fetchImpl, billsReader, rothReader, now = () => Date.now(), uuid, timeoutMs } = options;
  if (typeof now !== 'function') throw new SequenceSimulationError('SIMULATION_TIME_INVALID');
  let checkedAt;
  try { checkedAt = now(); } catch { throw new SequenceSimulationError('SIMULATION_TIME_INVALID'); }
  if (!Number.isFinite(checkedAt)) throw new SequenceSimulationError('SIMULATION_TIME_INVALID');
  let baseConfig;
  try { baseConfig = loadConfig(env); }
  catch { throw new SequenceSimulationError('SIMULATION_CONFIGURATION_INVALID'); }
  assertSequenceSimulationAllowed(env, baseConfig);
  let resolved;
  try {
    resolved = await resolveBillsConfiguration(baseConfig, { connectionString: env.GLOBAL_CONFIG,
      getAll: billsReader, now: checkedAt });
  } catch { throw new SequenceSimulationError('SIMULATION_BILLS_POLICY_UNAVAILABLE'); }
  const roth = await resolveRothPolicy(resolved.config, { connectionString: env.GLOBAL_CONFIG,
    getAll: rothReader, now: checkedAt });
  if (!roth.rothPolicy || roth.rothPolicyError) throw new SequenceSimulationError('SIMULATION_ROTH_POLICY_UNVERIFIED');
  const receipt = { softwareVersion: VERSION, ...await runSequenceSimulation({ env, config: resolved.config,
    rothPolicy: roth.rothPolicy, fetchImpl, now, uuid, timeoutMs }) };
  if (receipt.status !== 'passed') {
    const error = new SequenceSimulationError('SIMULATION_FAILED');
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifySequenceSimulation())); }
  catch (error) {
    console.error(JSON.stringify(error instanceof SequenceSimulationError && error.receipt ? error.receipt : {
      schemaVersion: 1, suite: 'sequence-provider-simulation-v1', status: 'failed', realTransferRequested: false,
      code: error instanceof SequenceSimulationError ? error.code : 'SIMULATION_FAILED',
    }));
    process.exitCode = 1;
  }
}
