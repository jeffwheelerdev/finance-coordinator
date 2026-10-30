import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VERSION } from '../lib/config.mjs';
import { makeDashboardRehearsalReceipt, readDashboardRehearsalReceipt } from '../lib/dashboard-receipt.mjs';

const checkedAt = '2026-01-01T00:00:00.000Z', now = Date.parse(checkedAt);
function fullReceipt() {
  const scenarios = ['full_year_carry_and_december_close', 'priority_shortage_and_partial_roth',
    'provider_uncertain_and_failed_outcomes', 'first_day_schedule_and_prospective_activation', 'year_transition_and_new_annual_limit']
    .map(id => ({ id, status: 'passed', arbitraryFixtureDetails: 'PRIVATE FIXTURE CONTENT' }));
  return { schemaVersion: 1, suite: 'monthly-activation-rehearsal-v1', softwareVersion: VERSION, status: 'passed',
    deterministic: true, syntheticDataOnly: true, networkAttempts: 0, realTransfers: 0, realEmails: 0,
    scenarioCount: scenarios.length, scenarios, resultHash: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'),
    ignoredExtra: 'PRIVATE EXTRA' };
}

test('build receipt verifies the full synthetic result hash and retains only reviewed runtime fields', () => {
  const full = fullReceipt(), reduced = makeDashboardRehearsalReceipt(full, { checkedAt });
  assert.equal(reduced.resultHash, full.resultHash); assert.equal(reduced.scenarioCount, 5);
  assert.equal(JSON.stringify(reduced).includes('PRIVATE'), false);
  assert.deepEqual(readDashboardRehearsalReceipt(reduced, { now }), reduced);
  const copy = readDashboardRehearsalReceipt(reduced, { now }); copy.scenarios[0].status = 'failed';
  assert.equal(reduced.scenarios[0].status, 'passed');
});

test('malformed, stale, future-dated and non-synthetic receipts never produce a passing runtime badge', () => {
  const good = makeDashboardRehearsalReceipt(fullReceipt(), { checkedAt });
  for (const value of [null, {}, { ...good, softwareVersion: '0.0.0' }, { ...good, status: 'failed' },
    { ...good, checkedAt: '2026-01-02T00:00:00.000Z' }, { ...good, checkedAt: '2026-02-30T00:00:00.000Z' },
    { ...good, syntheticDataOnly: false }, { ...good, networkAttempts: 1 }, { ...good, realTransfers: 1 },
    { ...good, realEmails: 1 }, { ...good, privateProof: 'PRIVATE' },
    { ...good, scenarios: good.scenarios.map(row => ({ ...row, rawResponse: 'PRIVATE' })) }]) {
    assert.equal(readDashboardRehearsalReceipt(value, { now }), null);
  }
});

test('the build rejects failed coverage, changed result data, unexpected scenarios and invalid timestamps', () => {
  const good = fullReceipt();
  for (const value of [{ ...good, status: 'failed' }, { ...good, scenarioCount: 4 }, { ...good, resultHash: 'f'.repeat(64) },
    { ...good, scenarios: good.scenarios.map((row, index) => index === 1 ? { ...row, id: 'unexpected' } : row) },
    { ...good, scenarios: good.scenarios.map((row, index) => index === 0 ? { ...row, arbitraryFixtureDetails: 'changed' } : row) }]) {
    assert.throws(() => makeDashboardRehearsalReceipt(value, { checkedAt }), /DASHBOARD_REHEARSAL_RECEIPT_INVALID/);
  }
  assert.throws(() => makeDashboardRehearsalReceipt(good, { checkedAt: '2026-02-30T00:00:00.000Z' }), /DASHBOARD_REHEARSAL_RECEIPT_INVALID/);
});
