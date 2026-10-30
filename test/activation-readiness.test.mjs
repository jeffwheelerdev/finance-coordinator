import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivationReadiness, assertActivationReadyForDeployment } from '../lib/activation-readiness.mjs';
import { readMonthlyEvidence } from '../lib/monthly-evidence.mjs';
import { monthlyOwnedTransfers } from '../lib/monthly-engine.mjs';
import { incomeScanFrom } from '../lib/income-ledger.mjs';
import { forecastBills } from '../lib/bills.mjs';
import { withCalculatedBillsTarget } from '../lib/config.mjs';
import { initialState } from '../lib/engine.mjs';
import { monthlyFixture, useSequenceRetirement, START } from './monthly-fixture.mjs';
import { ID, asISO, makeConfig, makeRothPolicy, transferRecord } from './fixtures.mjs';

async function fixture({ now = START } = {}) {
  const s = monthlyFixture({ mode: 'observe', activationAt: null });
  s.advance(asISO(now));
  s.monthlyPolicy.opening.asOf = asISO(now - 3600000);
  s.monthlyPolicy.updatedAt = s.monthlyPolicy.opening.asOf;
  const catalog = { schemaVersion: 1, timeZone: 'America/New_York', updatedAt: '2029-12-30T00:00:00.000Z', bills: [{
    id: 'synthetic-bill', name: 'Private synthetic bill', kind: 'expense', status: 'active', amountCents: 45000,
    frequency: 'monthly', evidence: { type: 'user_confirmation', reference: 'Private bill reference', observedAt: '2029-12-30T00:00:00.000Z' },
  }] };
  const forecast = forecastBills(catalog, { now });
  s.config = withCalculatedBillsTarget(s.config, forecast);
  s.billsPolicy = { catalog, forecast, monitor: { checkedAt: asISO(now), reviewCodes: [] } };
  s.alertDelivery = { configured: true, provider: 'resend', channel: 'email',
    recipient: 'private-recipient@example.test', sender: 'Finance <private-sender@example.test>' };
  const verifiedAt = asISO(now - 10000), reference = 'Private reviewed authority reference';
  s.readinessEvidence = { schemaVersion: 1, updatedAt: verifiedAt,
    sequenceAuthority: { status: 'verified', verifiedAt, reference, automaticApproval: true, maxAmountCents: null,
      accountPairs: [s.config.accounts.bills, s.config.accounts.general, s.config.accounts.emergency, s.config.roth.accountId,
        s.config.monthly.projectAccountId, s.config.monthly.personalAccountId].map(destinationAccountId => ({
        sourceAccountId: s.config.accounts.income, destinationAccountId,
      })).concat({ sourceAccountId: s.config.accounts.emergency, destinationAccountId: s.config.accounts.income }) },
    emailDelivery: { status: 'verified', verifiedAt, reference, provider: 'resend', recipient: s.alertDelivery.recipient,
      sender: s.alertDelivery.sender, providerAccepted: true, recipientConfirmed: true } };
  s.refreshEvidence = async () => {
    const state = s.store.value ?? initialState();
    s.evidence = await readMonthlyEvidence(s.client, s.config, { now: s.clock.value,
      externalFrom: incomeScanFrom(s.monthlyPolicy, state.monthly?.income),
      knownTransfers: monthlyOwnedTransfers(state).filter(row => row.transferId), lastSettledAt: state.monthly?.lastSettledAt ?? null });
  };
  s.readinessArgs = options => ({ config: s.config, state: s.store.value ?? initialState(), evidence: s.evidence,
    billsPolicy: s.billsPolicy, monthlyPolicy: s.monthlyPolicy, rothPolicy: s.rothPolicy, rothEvidence: s.rothEvidence,
    alertDelivery: s.alertDelivery, readinessEvidence: s.readinessEvidence, now: s.clock.value, ...options });
  s.ready = options => buildActivationReadiness(s.readinessArgs(options));
  await s.refreshEvidence();
  return s;
}
const has = (result, code) => assert.ok(result.blockers.includes(code), `${code}: ${JSON.stringify(result.blockers)}`);

test('a prepared inactive deployment is distinctly ready for user activation without writes or private proof disclosure', async () => {
  const s = await fixture(), input = s.readinessArgs(), before = structuredClone(input);
  const result = buildActivationReadiness(input);
  assert.equal(result.status, 'ready_for_user_activation'); assert.equal(result.readyForActivation, true);
  assert.equal(result.executionEnabled, false); assert.equal(result.activationEstablished, false);
  assert.equal(result.readChecks, 'passed'); assert.deepEqual(result.blockers, []);
  assert.equal(result.nextCycle.monthKey, '2030-01');
  assert.deepEqual(result.activationChanges.map(row => row.setting), ['APP_MODE', 'LIVE_TRANSFERS_ENABLED', 'AUTOMATION_START_AT']);
  assert.equal(result.limitations.realTransferTested, false); assert.equal(result.limitations.storageWritesTested, false);
  assert.deepEqual(input, before); assert.equal(s.store.writes.length, 0); assert.equal(s.client.creates.length, 0); assert.equal(s.sent.length, 0);
  const output = JSON.stringify(result);
  for (const value of [s.alertDelivery.recipient, s.alertDelivery.sender, 'Private reviewed authority reference',
    ...Object.values(s.config.accounts), ...Object.values(s.config.rules), ID(30), ID(41), ID(42)]) assert.equal(output.includes(value), false);
});

test('successful read checks never turn unverified preparation into a readiness pass', async () => {
  const s = await fixture();
  s.monthlyPolicy.opening = { status: 'unverified' };
  s.rothPolicy.years[0].eligibility = { status: 'unverified' };
  s.readinessEvidence.sequenceAuthority = { status: 'unverified' };
  s.readinessEvidence.emailDelivery = { status: 'unverified' };
  const result = s.ready();
  assert.equal(result.readChecks, 'passed'); assert.equal(result.readyForActivation, false); assert.equal(result.status, 'blocked');
  for (const code of ['INCOME_OPENING_UNVERIFIED', 'ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED', 'SEQUENCE_AUTHORITY_UNVERIFIED', 'EMAIL_DELIVERY_UNVERIFIED']) has(result, code);
  assert.equal(result.blockers.includes('ROTH_ROUTE_UNVERIFIED'), false);
});

test('retirement inventory absence never proves deletion or all-rules visibility by itself', async () => {
  const s = await fixture(); useSequenceRetirement(s, { absent: true }); await s.refreshEvidence();
  let result = s.ready();
  has(result, 'SEQUENCE_RULE_VISIBILITY_UNVERIFIED'); assert.equal(result.readyForActivation, false);
  const guard = result.checks.find(row => row.id === 'legacy_rules_disabled');
  assert.equal(guard.status, 'passed'); assert.equal(guard.absentCount, 4);
  assert.equal(guard.explicitlyDeletedCount, 0); assert.equal(guard.absenceProvesDeletion, false);
  s.readinessEvidence.sequenceAuthority.readAllRules = true;
  result = s.ready(); assert.equal(result.readyForActivation, true, JSON.stringify(result.blockers));
  const output = JSON.stringify(result);
  assert.equal(output.includes(s.config.monthly.sequenceRetirement.reference), false);
  assert.equal(output.includes(s.config.accounts.pod), false);
});

test('a generic missing-rule status cannot bypass the guard without explicit retirement authorization', async () => {
  const s = await fixture();
  s.evidence.nativeRuleStatuses.funding = 'ABSENT';
  has(s.ready(), 'MONTHLY_LEGACY_RULES_UNVERIFIED');
});

test('a verified opening must actually reconcile, and unresolved classifications stay visible', async t => {
  await t.test('cash mismatch', async () => {
    const s = await fixture(); s.evidence.sourceBalanceCents += 1;
    has(s.ready(), 'INCOME_BALANCE_RECONCILIATION_REQUIRED');
  });
  await t.test('unclassified new credit', async () => {
    const s = await fixture(); s.deposit(1000, 'UNREVIEWED RECEIPT'); await s.refreshEvidence();
    const result = s.ready(); has(result, 'INCOME_CLASSIFICATION_REQUIRED');
    assert.equal(result.checks.find(row => row.id === 'income_reconciliation').unknownHeldCents, 1000);
  });
});

test('next-year readiness requires new annual personal facts and the new published limit', async () => {
  const s = await fixture({ now: Date.parse('2030-12-31T15:00:00.000Z') });
  let result = s.ready();
  assert.equal(result.nextCycle.monthKey, '2031-01');
  has(result, 'ROTH_STATUTORY_LIMIT_UNVERIFIED'); has(result, 'ROTH_YEAR_POLICY_MISSING');
  s.rothPolicy = makeRothPolicy(2031, { annualCents: 800000 });
  result = s.ready(); assert.equal(result.readyForActivation, true, JSON.stringify(result.blockers));
  assert.equal(result.checks.find(row => row.id === 'next_cycle_roth_policy').monthlyAmountCents, 66666);
});

test('same-day preparation after the prospective slot selects the next month', async () => {
  const s = await fixture({ now: START + 1 });
  assert.equal(s.ready().nextCycle.monthKey, '2030-02');
});

test('an initial live first-day deployment checks the currently executable year, not a later prospective year', async () => {
  const s = await fixture({ now: Date.parse('2030-12-01T15:05:00.000Z') });
  const next = JSON.parse(JSON.stringify(makeRothPolicy(2031)).replaceAll('2030-12-01', '2030-11-29').replaceAll('2030-12-02', '2030-11-30'));
  s.rothPolicy.years[0].eligibility = { status: 'unverified' };
  s.rothPolicy = { ...next, statutoryLimits: [...s.rothPolicy.statutoryLimits, ...next.statutoryLimits],
    years: [...s.rothPolicy.years, ...next.years] };
  assert.equal(s.ready().nextCycle.monthKey, '2031-01');
  assert.equal(s.ready().readyForActivation, true);
  const live = { ...s.config, mode: 'live', liveEnabled: true, activationAt: '2030-12-01T14:00:00.000Z' };
  const result = s.ready({ config: live });
  assert.equal(result.nextCycle.monthKey, '2030-12');
  has(result, 'ROTH_PERSONAL_ELIGIBILITY_UNVERIFIED');
  assert.throws(() => assertActivationReadyForDeployment(live, result), { code: 'ACTIVATION_PREREQUISITES_INCOMPLETE' });
});

test('the actual Roth route and observed external contributions are checked, not only proof flags', async t => {
  await t.test('route mismatch', async () => {
    const s = await fixture(); s.rothEvidence.route.destinationAccountId = ID(999);
    has(s.ready(), 'ROTH_ROUTE_MISMATCH');
  });
  await t.test('unrecorded completed IRA deposit', async () => {
    const s = await fixture();
    s.client.transfers.set(ID(900), transferRecord({ id: ID(900), amountInCents: 10000, origin: 'USER', ruleId: null, ruleExecutionId: null,
      source: { id: ID(901), type: 'EXTERNAL_ACCOUNT', isDeleted: false },
      destination: { id: s.config.roth.accountId, type: 'EXTERNAL_ACCOUNT', isDeleted: false },
      createdAt: asISO(s.clock.value - 60000), completedAt: asISO(s.clock.value - 30000) }));
    await s.refreshEvidence(); has(s.ready(), 'ROTH_OUTSIDE_CONTRIBUTIONS_CHANGED');
  });
});

test('unattended approval, every transfer pair and finite transfer limits are explicit prerequisites', async t => {
  await t.test('manual approval', async () => { const s = await fixture(); s.readinessEvidence.sequenceAuthority.automaticApproval = false;
    has(s.ready(), 'SEQUENCE_UNATTENDED_APPROVAL_UNVERIFIED'); });
  await t.test('Emergency return pair missing', async () => { const s = await fixture(); s.readinessEvidence.sequenceAuthority.accountPairs.pop();
    has(s.ready(), 'SEQUENCE_TRANSFER_PAIR_UNVERIFIED'); });
  await t.test('finite cap below conservative bound', async () => {
    const s = await fixture(); s.readinessEvidence.sequenceAuthority.maxAmountCents = 100000;
    const result = s.ready(); has(result, 'SEQUENCE_TRANSFER_LIMIT_REVIEW_REQUIRED');
    assert.equal(result.checks.find(row => row.id === 'sequence_authority').limitAssessment, 'conservative_upper_bound_not_a_transfer_plan');
  });
  await t.test('finite cap covers current bound', async () => {
    const s = await fixture(); s.readinessEvidence.sequenceAuthority.maxAmountCents = 1000000;
    assert.equal(s.ready().readyForActivation, true);
  });
});

test('email verification must match both the configured recipient and sender', async t => {
  for (const field of ['recipient', 'sender']) await t.test(field, async () => {
    const s = await fixture(); s.readinessEvidence.emailDelivery[field] = 'different@example.test';
    has(s.ready(), field === 'recipient' ? 'EMAIL_DELIVERY_RECIPIENT_MISMATCH' : 'EMAIL_DELIVERY_SENDER_MISMATCH');
  });
  await t.test('acceptance alone is not confirmed receipt', async () => {
    const s = await fixture(); s.readinessEvidence.emailDelivery.recipientConfirmed = false;
    has(s.ready(), 'EMAIL_DELIVERY_UNVERIFIED');
  });
});

test('fresh conservatively retained Bills review codes are information, not a new funding prohibition', async () => {
  const s = await fixture(); s.billsPolicy.monitor.reviewCodes = ['ANNUAL_BILL_DATE_UNVERIFIED'];
  const result = s.ready(); assert.equal(result.readyForActivation, true);
  assert.equal(result.checks.find(row => row.id === 'bills_policy').reviewCodeCount, 1);
});

test('deployment gate blocks incomplete initial live activation while leaving observe builds available', async () => {
  const s = await fixture();
  assert.doesNotThrow(() => assertActivationReadyForDeployment(s.config, null));
  const live = { ...s.config, mode: 'live', liveEnabled: true, activationAt: asISO(START) };
  for (const readiness of [undefined, { schemaVersion: 1, readyForActivation: false, activationEstablished: false }]) {
    assert.throws(() => assertActivationReadyForDeployment(live, readiness), { code: 'ACTIVATION_PREREQUISITES_INCOMPLETE' });
  }
  const ready = s.ready({ config: live });
  assert.equal(ready.readyForActivation, true);
  assert.doesNotThrow(() => assertActivationReadyForDeployment(live, ready));
});

test('a matching permanent activation can receive a code repair while known ACH transfers are pending', async () => {
  const s = await fixture();
  s.config = makeConfig({ ...s.config, mode: 'live', liveEnabled: true, activationAt: asISO(START - 3600000) });
  assert.equal((await s.run()).code, 'MONTHLY_TRANSFERS_SUBMITTED'); await s.refreshEvidence();
  let result = s.ready();
  assert.equal(result.activationEstablished, true); assert.equal(result.readyForActivation, false);
  has(result, 'MONTHLY_TRANSFER_UNRESOLVED');
  assert.doesNotThrow(() => assertActivationReadyForDeployment(s.config, result));
  const changed = { ...s.config, monthly: { ...s.config.monthly, personalAccountId: ID(999) } };
  result = s.ready({ config: changed });
  assert.equal(result.activationEstablished, false); has(result, 'MONTHLY_BINDING_CHANGED');
  assert.throws(() => assertActivationReadyForDeployment(changed, result), { code: 'ACTIVATION_PREREQUISITES_INCOMPLETE' });
});

test('an established coordinator cannot add retirement visibility through the pending-repair exception', async () => {
  const s = await fixture();
  s.config = makeConfig({ ...s.config, mode: 'live', liveEnabled: true, activationAt: asISO(START - 3600000) });
  await s.run();
  assert.equal(s.store.value.monthly.retirementBindingHash, undefined);
  useSequenceRetirement(s); await s.refreshEvidence();
  let result = s.ready(); assert.equal(result.activationEstablished, true);
  has(result, 'SEQUENCE_RULE_VISIBILITY_UNVERIFIED');
  assert.throws(() => assertActivationReadyForDeployment(s.config, result), { code: 'ACTIVATION_PREREQUISITES_INCOMPLETE' });
  s.readinessEvidence.sequenceAuthority.readAllRules = true;
  result = s.ready(); has(result, 'MONTHLY_TRANSFER_UNRESOLVED');
  assert.doesNotThrow(() => assertActivationReadyForDeployment(s.config, result));
  // A future repair also cannot use an old readiness pass if visibility is no
  // longer attested, regardless of the financial activation binding.
  s.readinessEvidence.sequenceAuthority.readAllRules = false;
  assert.throws(() => assertActivationReadyForDeployment(s.config, s.ready()), { code: 'ACTIVATION_PREREQUISITES_INCOMPLETE' });
});
