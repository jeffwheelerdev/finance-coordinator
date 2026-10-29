import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tests = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `test/${name}`);
const tested = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (tested.status !== 0) process.exit(tested.status ?? 1);
if (process.env.VERCEL_ENV === 'production') {
  const { verifyDeployment } = await import('./preflight.mjs');
  try { console.log(JSON.stringify(await verifyDeployment())); }
  catch (error) {
    const { safeCode } = await import('../lib/engine.mjs');
    console.error(JSON.stringify({ status: 'preflight_failed', code: safeCode(error) }));
    process.exitCode = 1;
  }
} else {
  console.log('Offline tests passed. Production credential and storage checks run on a production build.');
}
