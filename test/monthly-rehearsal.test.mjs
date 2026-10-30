import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonthlyRehearsal } from '../scripts/rehearse-monthly.mjs';

test('the complete activation rehearsal is deterministic, offline, and reports real-provider limits truthfully', async () => {
  const originalFetch = globalThis.fetch;
  const first = await runMonthlyRehearsal(), second = await runMonthlyRehearsal();
  assert.equal(globalThis.fetch, originalFetch);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'passed'); assert.equal(first.scenarioCount, 5);
  assert.equal(first.scenarios[0].months.length, 12);
  assert.equal(first.scenarios[0].annualRothCents, 750000);
  assert.equal(first.scenarios[0].annualProjectCents, 50000);
  assert.deepEqual([first.networkAttempts, first.realTransfers, first.realEmails], [0, 0, 0]);
  assert.equal(first.scenarios.at(-1).priorYearWindfallHeldCents, 20000);
  assert.match(first.resultHash, /^[a-f0-9]{64}$/);
  assert.ok(first.limitations.some(row => row.includes('real transfer permission')));
  assert.equal(/00000000-0000-4000-8000-\d{12}/.test(JSON.stringify(first)), false);
});
