import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { prepareBillsUpdate } from '../lib/bills-monitor.mjs';

const MAX_INPUT_BYTES = 1_000_000;
const USAGE = 'Usage: node scripts/prepare-bills-update.mjs [--input private-input.json] [--output private-output.json] [--now UTC_ISO]\nOmit --input to read JSON from stdin. Input must include verifiedCoverage:true.\nWith --output, stdout contains only a summary. This script performs no network calls or configuration writes.';
const error = code => Object.assign(new Error(code), { code });

function absolute(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw error('BILLS_MONITOR_FILE_PATH_INVALID');
  const segments = `${value.startsWith('/') ? '' : `${process.cwd()}/`}${value}`.split('/');
  const normalized = [];
  for (const part of segments) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}

async function readInput(path, stdin) {
  if (path) {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw error('BILLS_MONITOR_INPUT_TOO_LARGE');
    const bytes = await fs.readFile(path);
    if (bytes.byteLength > MAX_INPUT_BYTES) throw error('BILLS_MONITOR_INPUT_TOO_LARGE');
    return bytes.toString('utf8');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) throw error('BILLS_MONITOR_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin } = {}) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(USAGE); return; }
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--input', '--output', '--now'].includes(flag) || flags[flag] !== undefined || typeof value !== 'string' || value.startsWith('--')) {
      throw error('BILLS_MONITOR_CLI_ARGUMENT_INVALID');
    }
    flags[flag] = value;
  }
  const inputPath = flags['--input'] && flags['--input'] !== '-' ? absolute(flags['--input']) : null;
  const outputPath = flags['--output'] ? absolute(flags['--output']) : null;
  if (inputPath && outputPath === inputPath) throw error('BILLS_MONITOR_OUTPUT_REPLACES_INPUT');
  let input;
  try { input = JSON.parse(await readInput(inputPath, stdin)); }
  catch (caught) { if (caught?.code) throw caught; throw error('BILLS_MONITOR_INPUT_JSON_INVALID'); }
  if (flags['--now']) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('BILLS_MONITOR_INPUT_INVALID');
    input.now = flags['--now'];
  }
  const result = prepareBillsUpdate(input);
  if (outputPath) {
    const directory = outputPath.slice(0, outputPath.lastIndexOf('/')) || '/';
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${outputPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, outputPath);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    console.log(JSON.stringify({
      requiresWrite: result.requiresWrite, shouldNotify: result.shouldNotify, blocked: result.blocked,
      ...(result.code ? { code: result.code } : {}), previousTargetCents: result.previousTargetCents,
      targetCents: result.targetCents, peakMonthCents: result.peakMonthCents,
      changeCount: result.changes.length, warningCodes: [...new Set(result.warnings.map(item => item.code))],
      output: outputPath,
    }));
  } else console.log(JSON.stringify(result, null, 2));
  if (result.blocked) process.exitCode = 2;
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entry === decodeURIComponent(new URL(import.meta.url).pathname)) {
  try { await main(); }
  catch (caught) {
    const code = typeof caught?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(caught.code) ? caught.code : 'BILLS_MONITOR_PREPARATION_FAILED';
    console.error(JSON.stringify({ status: 'blocked', code }));
    process.exitCode = 1;
  }
}
