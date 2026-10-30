import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../lib/config.mjs';
import { initialState } from '../lib/engine.mjs';
import { prepareSchedulerProbe, validateSchedulerProbe, recordSchedulerProbePublication, completeSchedulerProbe,
  summarizeSchedulerProbe, SCHEDULER_PROBE_LIFETIME_MS, SCHEDULER_PROBE_COOLDOWN_MS } from '../lib/scheduler-probe.mjs';
import { FakeStore, ID, asISO } from './fixtures.mjs';

const START = Date.parse('2030-01-01T16:00:00.000Z');
const ENV = { VERCEL_ENV: 'production', APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', VERCEL_DEPLOYMENT_ID: 'dpl_private_probe_test' };
const HEALTH = { status: 200, applicationStatus: 'ready', softwareVersion: VERSION, mode: 'observe', liveEnabled: false };
function fixture() {
  const state = initialState();
  state.lastRun = { at: asISO(START - 1000), mode: 'observe', result: { status: 'observe', code: 'READ_ONLY_MONTHLY_PLAN' } };
  const prepared = prepareSchedulerProbe({ state, env: ENV, now: START, id: ID(900) });
  return { original: state, probe: prepared.probe, store: new FakeStore(prepared.state) };
}
const stripped = state => { const copy = structuredClone(state); delete copy.schedulerProbe; return copy; };
const completedArgs = s => ({ env: ENV, probe: s.probe, now: () => START + 61_000,
  health: HEALTH, delivery: { deliveryCount: 1 }, store: s.store });

test('a probe intent is a bounded private message without financial instructions or reusable proof', () => {
  const s = fixture(), row = s.store.value.schedulerProbe;
  assert.deepEqual(Object.keys(s.probe).sort(), ['expiresAt', 'id', 'kind', 'queuedAt', 'schemaVersion']);
  assert.equal(s.probe.kind, 'probe'); assert.equal(Date.parse(s.probe.expiresAt) - START, SCHEDULER_PROBE_LIFETIME_MS);
  assert.equal(row.status, 'pending'); assert.equal(row.softwareVersion, VERSION);
  assert.equal(row.publisherDeploymentId, ENV.VERCEL_DEPLOYMENT_ID);
  assert.deepEqual(stripped(s.store.value), s.original); assert.equal(s.store.writes.length, 0);
  const publicView = summarizeSchedulerProbe({ state: s.store.value, env: ENV, now: START });
  assert.equal(publicView.status, 'pending'); assert.equal(publicView.target, 'health_only');
  assert.equal(JSON.stringify(publicView).includes(s.probe.id), false);
  assert.equal(JSON.stringify(publicView).includes(ENV.VERCEL_DEPLOYMENT_ID), false);
});

test('production, money-off, deployment identity, cooldown and financial lease gates precede publication', () => {
  const s = fixture();
  for (const patch of [{ VERCEL_ENV: 'preview' }, { APP_MODE: 'live' }, { LIVE_TRANSFERS_ENABLED: 'true' },
    { VERCEL_DEPLOYMENT_ID: undefined }, { VERCEL_DEPLOYMENT_ID: 'bad\nprivate' }]) {
    assert.throws(() => prepareSchedulerProbe({ state: initialState(), env: { ...ENV, ...patch }, now: START, id: ID(901) }));
  }
  assert.throws(() => prepareSchedulerProbe({ state: { ...initialState(), lease: { owner: ID(50), expiresAt: asISO(START + 10_000) } },
    env: ENV, now: START, id: ID(901) }), error => error.code === 'DASHBOARD_WORKER_ACTIVE');
  assert.throws(() => prepareSchedulerProbe({ state: s.store.value, env: ENV, now: START + SCHEDULER_PROBE_COOLDOWN_MS - 1, id: ID(901) }),
    error => error.code === 'SCHEDULER_PROBE_COOLDOWN');
  const next = prepareSchedulerProbe({ state: s.store.value, env: ENV, now: START + SCHEDULER_PROBE_COOLDOWN_MS, id: ID(901) });
  assert.notEqual(next.probe.id, s.probe.id); assert.equal(next.state.schedulerProbe.status, 'pending');
});

test('queue acknowledgement is separate from delivery and a lost publication response can still be proven', async () => {
  const s = fixture();
  await recordSchedulerProbePublication({ env: ENV, probe: s.probe, outcome: 'unknown', now: START + 1000, store: s.store });
  assert.equal(s.store.value.schedulerProbe.status, 'unknown'); assert.equal(s.store.value.schedulerProbe.completedAt, null);
  const completed = await completeSchedulerProbe(completedArgs(s));
  assert.equal(completed.status, 'completed'); assert.equal(completed.duplicate, false);
  assert.equal(s.store.value.schedulerProbe.healthStatus, 200);
  assert.deepEqual(stripped(s.store.value), s.original);
  const writes = s.store.writes.length;
  assert.equal((await completeSchedulerProbe(completedArgs(s))).duplicate, true);
  await recordSchedulerProbePublication({ env: ENV, probe: s.probe, outcome: 'queued', now: START + 62_000, store: s.store });
  assert.equal(s.store.writes.length, writes); assert.equal(s.store.value.schedulerProbe.status, 'completed');
  const receipt = summarizeSchedulerProbe({ state: s.store.value, env: ENV, now: START + SCHEDULER_PROBE_LIFETIME_MS });
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.checkedAt, asISO(START + 61_000));
});

test('queued acknowledgement never becomes a delivery badge before verified canonical health', async () => {
  const s = fixture();
  await recordSchedulerProbePublication({ env: ENV, probe: s.probe, outcome: 'queued', now: START + 1000, store: s.store });
  assert.equal(s.store.value.schedulerProbe.status, 'queued'); assert.equal(s.store.value.schedulerProbe.publishedAt, asISO(START + 1000));
  assert.equal(s.store.value.schedulerProbe.completedAt, null);
  const writes = s.store.writes.length;
  await recordSchedulerProbePublication({ env: ENV, probe: s.probe, outcome: 'unknown', now: START + 2000, store: s.store });
  assert.equal(s.store.writes.length, writes); assert.equal(s.store.value.schedulerProbe.status, 'queued');
  assert.equal(summarizeSchedulerProbe({ state: s.store.value, env: ENV, now: START + SCHEDULER_PROBE_LIFETIME_MS }).status, 'expired');
});

test('HTTP success alone, redirect, wrong version and enabled money never produce a completed receipt', async () => {
  for (const health of [{ status: 200 }, { ...HEALTH, status: 302 }, { ...HEALTH, applicationStatus: 'configuration_required' },
    { ...HEALTH, softwareVersion: '0.0.0' }, { ...HEALTH, mode: 'live' }, { ...HEALTH, liveEnabled: true }]) {
    const s = fixture();
    await assert.rejects(completeSchedulerProbe({ ...completedArgs(s), health }), error => error.code === 'SCHEDULER_PROBE_HEALTH_UNVERIFIED');
    assert.equal(s.store.reads, 0); assert.equal(s.store.writes.length, 0); assert.equal(s.store.value.schedulerProbe.status, 'pending');
  }
});

test('wrong, altered, expired or stale-deployment probe messages cannot update a matching financial ledger', async () => {
  for (const change of [{ probe: { ...fixture().probe, id: ID(901) } }, { probe: { ...fixture().probe, amountInCents: 1 } },
    { now: START + SCHEDULER_PROBE_LIFETIME_MS }, { env: { ...ENV, VERCEL_DEPLOYMENT_ID: 'dpl_another_deployment' } },
    { env: { ...ENV, APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true' } }]) {
    const s = fixture(), before = structuredClone(s.store.value);
    await assert.rejects(completeSchedulerProbe({ ...completedArgs(s), ...change }));
    assert.equal(s.store.writes.length, 0); assert.deepEqual(s.store.value, before);
  }
});

test('completion never overwrites an active financial worker or a concurrent ledger update', async () => {
  const s = fixture();
  s.store.value.lease = { owner: ID(50), expiresAt: asISO(START + 100_000) };
  await assert.rejects(completeSchedulerProbe(completedArgs(s)), error => error.code === 'DASHBOARD_WORKER_ACTIVE' && error.retryable);
  assert.equal(s.store.writes.length, 0);
  s.store.value.lease = null;
  const newer = { ...structuredClone(s.store.value), lastRun: { at: asISO(START + 60_000), mode: 'observe', result: { status: 'observe', code: 'NEWER_FINANCIAL_RUN' } } };
  s.store.beforeCAS = async () => { s.store.beforeCAS = null; s.store.replaceForTest(newer); };
  await assert.rejects(completeSchedulerProbe(completedArgs(s)), error => error.code === 'SCHEDULER_PROBE_STORE_CONFLICT' && error.retryable);
  assert.equal(s.store.writes.length, 0); assert.deepEqual(s.store.value, newer);
});

test('a slow ledger read cannot cross the probe expiry and persist a fresh delivery claim', async () => {
  const s = fixture(); let now = START + 61_000;
  const read = s.store.read.bind(s.store);
  s.store.read = async () => { const value = await read(); now = START + SCHEDULER_PROBE_LIFETIME_MS; return value; };
  await assert.rejects(completeSchedulerProbe({ ...completedArgs(s), now: () => now }), error => error.code === 'SCHEDULER_PROBE_EXPIRED');
  assert.equal(s.store.writes.length, 0); assert.equal(s.store.value.schedulerProbe.status, 'pending');
});

test('old-deployment, old-version and malformed proof stay unverified and never leak their private binding', async () => {
  const s = fixture(); await completeSchedulerProbe(completedArgs(s));
  assert.equal(summarizeSchedulerProbe({ state: s.store.value, env: { ...ENV, VERCEL_DEPLOYMENT_ID: 'dpl_new' }, now: START + 70_000 }).code,
    'SCHEDULER_PROBE_DEPLOYMENT_CHANGED');
  s.store.value.schedulerProbe.softwareVersion = '0.0.0';
  assert.equal(summarizeSchedulerProbe({ state: s.store.value, env: ENV, now: START + 70_000 }).code, 'SCHEDULER_PROBE_VERSION_CHANGED');
  s.store.value.schedulerProbe.privateRaw = 'PRIVATE RAW CREDENTIAL';
  assert.throws(() => validateSchedulerProbe(s.store.value.schedulerProbe), error => error.code === 'SCHEDULER_PROBE_STATE_INVALID');
  const redacted = summarizeSchedulerProbe({ state: s.store.value, env: ENV, now: START + 70_000 });
  assert.equal(redacted.status, 'unverified'); assert.equal(JSON.stringify(redacted).includes('PRIVATE'), false);
});
