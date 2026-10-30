import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, summarizeConfig, validateMonthlySequenceRetirement } from '../lib/config.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const accounts = { income: id(1), pod: id(2), general: id(3), bills: id(4) };
const rules = { payout: id(11), funding: id(12), legacyGeneral: id(13) };
const environment = (overrides = {}) => ({
  APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'false', AUTOMATION_START_AT: '2030-01-01T15:00:00Z',
  FINANCE_ACCOUNT_IDS_JSON: JSON.stringify(accounts), FINANCE_RULE_IDS_JSON: JSON.stringify(rules),
  FINANCE_ALLOCATIONS_JSON: '[]', GENERAL_SPENDING_MONTHLY_BUDGET: '750', GENERAL_SPENDING_RESERVE_MONTHS: '3',
  INCOME_RESERVE: '0', MONTHLY_PRIORITY_ENABLED: 'true', ROTH_ENABLED: 'true', ROTH_ACCOUNT_ID: id(30),
  EMERGENCY_ACCOUNT_ID: id(5), PROJECT_ACCOUNT_ID: id(6), PERSONAL_INVESTMENT_ACCOUNT_ID: id(7),
  EMERGENCY_EXCESS_RULE_ID: id(14), ...overrides,
});
const rejects = (fn, code) => assert.throws(fn, error => error instanceof ConfigError && error.code === code);
const retirement = () => ({ schemaVersion: 1, authorizedAt: '2029-12-31T15:00:00.000Z',
  reference: 'Private reviewed cleanup authorization', podAccountId: accounts.pod, rules: { ...rules, excess: id(14) } });

test('monthly priority adds distinct account roles while retaining four-field legacy mappings', () => {
  const config = loadConfig(environment());
  assert.deepEqual(config.accounts, { ...accounts, emergency: id(5) });
  assert.deepEqual(config.rules, { ...rules, excess: id(14) });
  assert.equal(config.monthly.projectAccountId, id(6));
  assert.equal(config.monthly.personalAccountId, id(7));
  assert.equal(config.roth.accountId, id(30));
  assert.equal(config.allocations.find(row => row.id === 'general-spending').targetCents, 225000);
  assert.equal(config.monthly.emergencyTargetCents, 1000000);
  assert.equal(config.monthly.emergencyRateBasisPoints, 750);
  assert.equal(config.monthly.projectRateBasisPoints, 500);
  assert.equal(config.monthly.timeZone, 'America/New_York');
  assert.equal(config.monthly.dueHourUTC, 15);
  assert.equal(config.monthly.annualCloseMonth, 12);
  assert.equal(config.liveEnabled, false);
});

test('monthly priority cannot be enabled without each explicit destination and excess-rule binding', () => {
  for (const key of ['EMERGENCY_ACCOUNT_ID', 'PROJECT_ACCOUNT_ID', 'PERSONAL_INVESTMENT_ACCOUNT_ID', 'EMERGENCY_EXCESS_RULE_ID']) {
    const input = environment(); delete input[key];
    rejects(() => loadConfig(input), 'MISSING_CONFIG');
    rejects(() => loadConfig(environment({ [key]: 'an-account-label' })), 'INVALID_UUID');
  }
  rejects(() => loadConfig(environment({ ROTH_ENABLED: 'false' })), 'MONTHLY_ROTH_CONFIGURATION_REQUIRED');
});

test('every monthly destination must be distinct from Income, Pod, other accounts and Roth', () => {
  for (const key of ['EMERGENCY_ACCOUNT_ID', 'PROJECT_ACCOUNT_ID', 'PERSONAL_INVESTMENT_ACCOUNT_ID']) {
    for (const value of [...Object.values(accounts), id(30)]) {
      rejects(() => loadConfig(environment({ [key]: value })), 'MONTHLY_DUPLICATE_ID');
    }
  }
  for (const values of [{ EMERGENCY_ACCOUNT_ID: id(6) }, { PROJECT_ACCOUNT_ID: id(7) }, { PERSONAL_INVESTMENT_ACCOUNT_ID: id(5) }]) {
    rejects(() => loadConfig(environment(values)), 'MONTHLY_DUPLICATE_ID');
  }
  for (const value of Object.values(rules)) rejects(() => loadConfig(environment({ EMERGENCY_EXCESS_RULE_ID: value })), 'MONTHLY_DUPLICATE_ID');
});

test('monthly migration rejects extras and extended legacy JSON that could hide unreviewed recipients', () => {
  const extra = [{ id: 'unreviewed-recipient', destinationAccountId: id(80), monthlyBudget: '10', reserveMonths: 1, priority: 2 }];
  rejects(() => loadConfig(environment({ FINANCE_ALLOCATIONS_JSON: JSON.stringify(extra) })), 'MONTHLY_EXTRA_ALLOCATIONS_UNSUPPORTED');
  rejects(() => loadConfig(environment({ FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ ...accounts, emergency: id(5) }) })), 'INVALID_CONFIG');
  rejects(() => loadConfig(environment({ FINANCE_RULE_IDS_JSON: JSON.stringify({ ...rules, excess: id(14) }) })), 'INVALID_CONFIG');
});

test('disabled monthly feature preserves legacy configuration and does not require its new secrets or bindings', () => {
  const input = environment({ MONTHLY_PRIORITY_ENABLED: 'false', ROTH_ENABLED: 'false', ROTH_ACCOUNT_ID: '' });
  for (const key of ['EMERGENCY_ACCOUNT_ID', 'PROJECT_ACCOUNT_ID', 'PERSONAL_INVESTMENT_ACCOUNT_ID', 'EMERGENCY_EXCESS_RULE_ID']) delete input[key];
  const config = loadConfig(input);
  assert.deepEqual(config.monthly, { enabled: false });
  assert.deepEqual(config.accounts, accounts);
  assert.deepEqual(config.rules, rules);
});

test('monthly feature flags reject truthy coercion', () => {
  for (const value of ['TRUE', '1', '', true, 1]) rejects(() => loadConfig(environment({ MONTHLY_PRIORITY_ENABLED: value })), 'INVALID_BOOLEAN');
});

test('both live switches require direct alert delivery configuration; inactive combinations remain inactive', () => {
  const live = environment({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true',
    RESEND_API_KEY: 'synthetic-email-token', ALERTS_EMAIL_TO: 'recipient@example.test', ALERTS_EMAIL_FROM: 'Finance <sender@example.test>' });
  assert.equal(loadConfig(live).liveEnabled, true);
  for (const key of ['RESEND_API_KEY', 'ALERTS_EMAIL_TO', 'ALERTS_EMAIL_FROM']) {
    const input = { ...live }; delete input[key];
    rejects(() => loadConfig(input), 'MONTHLY_ALERT_DELIVERY_REQUIRED');
  }
  assert.equal(loadConfig(environment({ APP_MODE: 'observe', LIVE_TRANSFERS_ENABLED: 'true' })).liveEnabled, false);
  assert.equal(loadConfig(environment({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'false' })).liveEnabled, false);
  rejects(() => loadConfig(environment({ APP_MODE: 'live', AUTOMATION_START_AT: '' })), 'MISSING_ACTIVATION');
});

test('live monthly activation rejects malformed recipients, senders and credential header injection', () => {
  const live = environment({ APP_MODE: 'live', LIVE_TRANSFERS_ENABLED: 'true',
    RESEND_API_KEY: 'synthetic-email-token', ALERTS_EMAIL_TO: 'recipient@example.test', ALERTS_EMAIL_FROM: 'Finance <sender@example.test>' });
  for (const ALERTS_EMAIL_TO of ['not-an-email', 'one@example.test,two@example.test', 'recipient@example.test\r\nBcc: attacker@example.test', ' recipient@example.test']) {
    rejects(() => loadConfig({ ...live, ALERTS_EMAIL_TO }), 'MONTHLY_ALERT_DELIVERY_REQUIRED');
  }
  for (const ALERTS_EMAIL_FROM of ['not-an-email', 'Finance <sender@example.test>\r\nBcc: attacker@example.test', 'Finance <sender@example.test>, other@example.test']) {
    rejects(() => loadConfig({ ...live, ALERTS_EMAIL_FROM }), 'MONTHLY_ALERT_DELIVERY_REQUIRED');
  }
  for (const RESEND_API_KEY of ['   ', 'synthetic-token\nHeader: injected', 'synthetic-token\rHeader: injected']) {
    rejects(() => loadConfig({ ...live, RESEND_API_KEY }), 'MONTHLY_ALERT_DELIVERY_REQUIRED');
  }
});

test('budget changes remain precise and changing a financial role changes the binding hash', () => {
  const original = loadConfig(environment());
  const updated = loadConfig(environment({ GENERAL_SPENDING_MONTHLY_BUDGET: '863.21', EMERGENCY_FUND_TARGET: '12345.67' }));
  assert.equal(updated.allocations.find(row => row.id === 'general-spending').targetCents, 258963);
  assert.equal(updated.monthly.emergencyTargetCents, 1234567);
  assert.notEqual(updated.configHash, original.configHash);
  for (const key of ['EMERGENCY_ACCOUNT_ID', 'PROJECT_ACCOUNT_ID', 'PERSONAL_INVESTMENT_ACCOUNT_ID', 'EMERGENCY_EXCESS_RULE_ID']) {
    assert.notEqual(loadConfig(environment({ [key]: id(90) })).configHash, original.configHash);
  }
});

test('authenticated config summary exposes priorities but no account IDs, rule IDs or email recipients', () => {
  const input = environment({ RESEND_API_KEY: 'synthetic-private-email-token', ALERTS_EMAIL_TO: 'private-recipient@example.test',
    ALERTS_EMAIL_FROM: 'Private Sender <private-sender@example.test>' });
  const summary = summarizeConfig(loadConfig(input)), output = JSON.stringify(summary);
  assert.deepEqual(summary.monthly.priorityOrder, ['bills', 'general-spending', 'emergency-fund', 'roth-ira', 'project-savings', 'personal-investment']);
  assert.equal(summary.monthly.windfallUse, 'annual_close');
  for (const secret of [...Object.values(accounts), ...Object.values(rules), id(5), id(6), id(7), id(14), id(30),
    input.RESEND_API_KEY, input.ALERTS_EMAIL_TO, input.ALERTS_EMAIL_FROM]) assert.equal(output.includes(secret), false);
});

test('authorized retirement permits clean operational configuration while preserving exact audit tombstones', () => {
  const input = environment({ MONTHLY_SEQUENCE_RETIREMENT_JSON: JSON.stringify(retirement()) });
  const original = loadConfig(input);
  input.FINANCE_ACCOUNT_IDS_JSON = JSON.stringify({ income: accounts.income, general: accounts.general, bills: accounts.bills });
  delete input.FINANCE_RULE_IDS_JSON; delete input.EMERGENCY_EXCESS_RULE_ID;
  const clean = loadConfig(input);
  assert.deepEqual(clean.accounts, original.accounts); assert.deepEqual(clean.rules, original.rules);
  assert.deepEqual(Object.keys(clean.rules), ['payout', 'funding', 'legacyGeneral', 'excess']);
  assert.equal(clean.configHash, original.configHash);
  assert.deepEqual(validateMonthlySequenceRetirement(clean, Date.parse('2030-01-01T15:00:00Z')), retirement());
  const summary = summarizeConfig(clean), output = JSON.stringify(summary);
  assert.equal(summary.monthly.sequenceRetirementAuthorized, true);
  for (const secret of [retirement().reference, accounts.pod, ...Object.values(retirement().rules)]) assert.equal(output.includes(secret), false);
});

test('retirement cannot silently change an existing Pod or archived rule mapping', () => {
  const input = environment({ MONTHLY_SEQUENCE_RETIREMENT_JSON: JSON.stringify(retirement()) });
  for (const changes of [
    { FINANCE_ACCOUNT_IDS_JSON: JSON.stringify({ ...accounts, pod: id(90) }) },
    { FINANCE_RULE_IDS_JSON: JSON.stringify({ ...rules, payout: id(90) }) },
    { EMERGENCY_EXCESS_RULE_ID: id(90) },
  ]) rejects(() => loadConfig({ ...input, ...changes }), 'MONTHLY_RETIREMENT_BINDING_MISMATCH');
  rejects(() => loadConfig({ ...input, MONTHLY_PRIORITY_ENABLED: 'false' }), 'MONTHLY_RETIREMENT_REQUIRES_MONTHLY');
  const future = { ...retirement(), authorizedAt: '2031-01-01T15:00:00Z' };
  rejects(() => validateMonthlySequenceRetirement(loadConfig({ ...input, MONTHLY_SEQUENCE_RETIREMENT_JSON: JSON.stringify(future) }),
    Date.parse('2030-01-01T15:00:00Z')), 'MONTHLY_RETIREMENT_TIME_INVALID');
  rejects(() => loadConfig({ ...input, MONTHLY_SEQUENCE_RETIREMENT_JSON: JSON.stringify({ ...retirement(), schemaVersion: 2 }) }), 'MONTHLY_RETIREMENT_INVALID');
  rejects(() => loadConfig({ ...input, MONTHLY_SEQUENCE_RETIREMENT_JSON: JSON.stringify({ ...retirement(), reference: '' }) }), 'MONTHLY_RETIREMENT_INVALID');
});
