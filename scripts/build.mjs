import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function reportProviderSimulation(receipt) {
  const { results = [], ...summary } = receipt;
  console.log(JSON.stringify({ component: 'sequence-provider-simulation', ...summary }));
  for (const result of results) console.log(JSON.stringify({ component: 'sequence-provider-simulation-probe', ...result }));
}

const tests = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `test/${name}`);
const tested = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (tested.status !== 0) process.exit(tested.status ?? 1);
try {
  const { runMonthlyRehearsal } = await import('./rehearse-monthly.mjs');
  const rehearsal = await runMonthlyRehearsal();
  console.log(JSON.stringify({ component: 'monthly-rehearsal', status: rehearsal.status,
    softwareVersion: rehearsal.softwareVersion, syntheticDataOnly: rehearsal.syntheticDataOnly,
    scenarioCount: rehearsal.scenarioCount, networkAttempts: rehearsal.networkAttempts,
    realTransfers: rehearsal.realTransfers, realEmails: rehearsal.realEmails, resultHash: rehearsal.resultHash }));
} catch {
  console.error(JSON.stringify({ component: 'monthly-rehearsal', status: 'failed', code: 'REHEARSAL_FAILED' }));
  process.exit(1);
}
if (process.env.VERCEL_ENV === 'production') {
  const { verifyDeployment } = await import('./preflight.mjs');
  try {
    console.log(JSON.stringify(await verifyDeployment()));
    if (process.env.RUN_SEQUENCE_SIMULATION === 'true') {
      const { verifySequenceSimulation } = await import('./simulate-sequence.mjs');
      reportProviderSimulation(await verifySequenceSimulation());
    }
  }
  catch (error) {
    const { SequenceSimulationError } = await import('../lib/sequence-simulation.mjs');
    if (error instanceof SequenceSimulationError) {
      reportProviderSimulation(error.receipt ?? { status: 'failed', code: error.code, realTransferRequested: false });
    } else {
      const { safeCode } = await import('../lib/engine.mjs');
      console.error(JSON.stringify({ status: 'preflight_failed', code: safeCode(error) }));
    }
    process.exitCode = 1;
  }
} else {
  console.log('Offline tests passed. Production credential and storage checks run on a production build.');
}
