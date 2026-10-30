/** Only build-created, reduced synthetic receipts belong in runtime views.
 * This module never invokes the rehearsal, reads credentials or makes calls. */
import { createHash } from 'node:crypto';
import { VERSION } from './config.mjs';

const IDS = Object.freeze(['full_year_carry_and_december_close', 'priority_shortage_and_partial_roth',
  'provider_uncertain_and_failed_outcomes', 'first_day_schedule_and_prospective_activation', 'year_transition_and_new_annual_limit']);
const FIELDS = ['schemaVersion', 'suite', 'softwareVersion', 'status', 'deterministic', 'syntheticDataOnly',
  'networkAttempts', 'realTransfers', 'realEmails', 'scenarioCount', 'scenarios', 'resultHash', 'checkedAt'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function valid(value, version) {
  return record(value) && value.schemaVersion === 1 && value.suite === 'monthly-activation-rehearsal-v1' &&
    value.softwareVersion === version && /^\d+\.\d+\.\d+$/.test(version) && value.status === 'passed' &&
    value.deterministic === true && value.syntheticDataOnly === true && value.networkAttempts === 0 &&
    value.realTransfers === 0 && value.realEmails === 0 && value.scenarioCount === IDS.length &&
    Array.isArray(value.scenarios) && value.scenarios.length === IDS.length &&
    value.scenarios.every((row, index) => record(row) && row.id === IDS[index] && row.status === 'passed') &&
    typeof value.resultHash === 'string' && /^[a-f0-9]{64}$/.test(value.resultHash);
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Call only from the isolated build after the actual rehearsal succeeds.
 * Hash verification binds the reduction to that complete synthetic result. */
export function makeDashboardRehearsalReceipt(value, { checkedAt, version = VERSION } = {}) {
  if (!valid(value, version) || !timestamp(checkedAt) ||
      createHash('sha256').update(JSON.stringify(value.scenarios)).digest('hex') !== value.resultHash) {
    throw new Error('DASHBOARD_REHEARSAL_RECEIPT_INVALID');
  }
  return { schemaVersion: 1, suite: value.suite, softwareVersion: version, status: 'passed', deterministic: true,
    syntheticDataOnly: true, networkAttempts: 0, realTransfers: 0, realEmails: 0,
    scenarioCount: IDS.length, scenarios: IDS.map(id => ({ id, status: 'passed' })), resultHash: value.resultHash, checkedAt };
}

/** A stale-version, malformed, future-dated or absent receipt shows not_run. */
export function readDashboardRehearsalReceipt(value, { version = VERSION, now = Date.now() } = {}) {
  if (!valid(value, version) || Object.keys(value).length !== FIELDS.length ||
      Object.keys(value).some(key => !FIELDS.includes(key)) || !timestamp(value.checkedAt) ||
      !Number.isSafeInteger(now) || Date.parse(value.checkedAt) > now ||
      value.scenarios.some(row => Object.keys(row).sort().join(',') !== 'id,status')) return null;
  return structuredClone(value);
}
