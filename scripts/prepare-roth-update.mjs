import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareRothLimitUpdate } from '../lib/roth-monitor.mjs';

// Only prepares local private JSON. Never accesses a provider or credential.
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output' || !argv[1] || !argv[3]) {
    throw Object.assign(new Error('ROTH_MONITOR_CLI_ARGUMENT_INVALID'), { code: 'ROTH_MONITOR_CLI_ARGUMENT_INVALID' });
  }
  const inputPath = resolve(argv[1]), outputPath = resolve(argv[3]);
  if (inputPath === outputPath) throw Object.assign(new Error('ROTH_MONITOR_OUTPUT_REPLACES_INPUT'), { code: 'ROTH_MONITOR_OUTPUT_REPLACES_INPUT' });
  const info = await fs.stat(inputPath);
  if (!info.isFile() || info.size > 256_000) throw Object.assign(new Error('ROTH_MONITOR_INPUT_TOO_LARGE'), { code: 'ROTH_MONITOR_INPUT_TOO_LARGE' });
  const raw = await fs.readFile(inputPath, 'utf8');
  if (Buffer.byteLength(raw) > 256_000) throw Object.assign(new Error('ROTH_MONITOR_INPUT_TOO_LARGE'), { code: 'ROTH_MONITOR_INPUT_TOO_LARGE' });
  const result = prepareRothLimitUpdate(JSON.parse(raw));
  // Each run uses a fresh directory and output file, so no prior result or
  // symlink may be overwritten while handling private policy evidence.
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ requiresWrite: result.requiresWrite, shouldNotify: result.shouldNotify,
    changes: result.changes, expectedEnvelopeHash: result.expectedEnvelopeHash, output: outputPath }));
  return result;
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entry === decodeURIComponent(new URL(import.meta.url).pathname)) {
  try { await main(); }
  catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'ROTH_MONITOR_PREPARATION_FAILED';
    console.error(JSON.stringify({ status: 'blocked', code }));
    process.exitCode = 1;
  }
}
