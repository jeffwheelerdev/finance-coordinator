import { reconcileMonthly } from '../lib/monthly-engine.mjs';
import { parseMonthlyPolicy } from '../lib/monthly-source.mjs';
import { ID, asISO, makeRothPolicy, cashAccount, scenario } from './fixtures.mjs';

// Synthetic in-memory providers only; no credentials, environment reads or network.
export const START = Date.parse('2030-01-01T15:00:00.000Z');
export function monthlyFixture({ regular = 1000000, windfall = 0, emergency = 900000, bills = 10000, general = 100000,
  mode = 'live', activationAt = '2030-01-01T14:00:00.000Z', rothVerified = true } = {}) {
  const s = scenario({ mode, liveEnabled: mode === 'live', activationAt,
    accounts: { emergency: ID(40) }, rules: { excess: ID(14) },
    roth: { enabled: true, accountId: ID(30) },
    monthly: { enabled: true, timeZone: 'America/New_York', dueHourUTC: 15, annualCloseMonth: 12,
      emergencyTargetCents: 1000000, emergencyRateBasisPoints: 750, projectRateBasisPoints: 500,
      projectAccountId: ID(41), personalAccountId: ID(42) },
    calculatedBillsTarget: { targetCents: 50000, catalogHash: 'a'.repeat(64), catalogUpdatedAt: '2029-12-30T00:00:00.000Z',
      year: 2030, effectiveDate: '2030-01-01', peakMonthCents: 45000 },
  });
  s.clock.value = START;
  s.client.transfers.clear(); s.client.executions.clear();
  for (const rule of s.client.rules.values()) rule.status = 'DISABLED';
  const at = asISO(START - 1000);
  s.client.accounts.set(s.config.accounts.income, cashAccount(s.config.accounts.income, regular + windfall, at));
  s.client.accounts.set(s.config.accounts.bills, cashAccount(s.config.accounts.bills, bills, at));
  s.client.accounts.set(s.config.accounts.general, cashAccount(s.config.accounts.general, general, at));
  s.client.accounts.set(s.config.accounts.emergency, cashAccount(s.config.accounts.emergency, emergency, at));
  s.client.accounts.set(ID(41), cashAccount(ID(41), 0, at));
  for (const id of [ID(30), ID(42)]) s.client.accounts.set(id, { id, type: 'EXTERNAL_ACCOUNT', externalAccountType: 'INVESTMENT',
    institutionName: 'Fidelity', deletedAt: null, canBeSource: false, canBeDestination: true, balance: null });
  s.bankRows = [];
  s.client.listExternalTransactions = async ({ accountIds, from, to }) => ({ complete: true,
    items: structuredClone(s.bankRows.filter(row => accountIds.includes(row.accountId) && Date.parse(row.transactionDate) >= Date.parse(from) &&
      Date.parse(row.transactionDate) <= Date.parse(to)).sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))),
    window: { from, to, truncated: false } });
  s.monthlyPolicy = parseMonthlyPolicy({ schemaVersion: 1, id: 'monthly-priority', updatedAt: '2030-01-01T14:00:00.000Z',
    opening: { status: 'verified', asOf: '2030-01-01T14:00:00.000Z', incomeBalanceCents: regular + windfall,
      regularCents: regular, windfallCents: windfall, unknownCents: 0, reference: 'Synthetic classified opening' },
    classification: { rules: [
      { id: 'ordinary-pay', kind: 'navy-pay', descriptionEquals: 'REGULAR PAY', merchantEquals: null, excludesBonuses: true,
        minAmountCents: 0, maxAmountCents: 100000000, verifiedAt: '2030-01-01T14:00:00.000Z', reference: 'Synthetic payslip' },
      { id: 'own-credit', kind: 'own-transfer', descriptionEquals: 'SELF TRANSFER', merchantEquals: null,
        minAmountCents: 0, maxAmountCents: 100000000, verifiedAt: '2030-01-01T14:00:00.000Z', reference: 'Synthetic own-account route' },
      { id: 'bonus', kind: 'windfall', descriptionEquals: 'BONUS', merchantEquals: null,
        minAmountCents: 0, maxAmountCents: 100000000, verifiedAt: '2030-01-01T14:00:00.000Z', reference: 'Synthetic bonus statement' },
    ], overrides: [] } });
  s.rothPolicy = makeRothPolicy();
  if (!rothVerified) s.rothPolicy.years[0].eligibility = { status: 'unverified' };
  s.rothEvidence = { schemaVersion: 1, updatedAt: '2029-12-02T12:00:00.000Z',
    route: { status: 'verified', sourceAccountId: s.config.accounts.income, destinationAccountId: s.config.roth.accountId,
      custodian: 'fidelity', contributionYear: 'current_calendar_year', verifiedAt: '2029-12-01T12:00:00.000Z', reference: 'Synthetic route' },
    upstream: { status: 'unverified' } };
  s.sent = [];
  s.sendAlert = async entry => { s.sent.push(structuredClone(entry)); return { deliveryId: ID(50000 + s.sent.length) }; };
  s.args = options => ({ config: s.config, client: s.client, store: s.store, monthlyPolicy: s.monthlyPolicy,
    rothPolicy: s.rothPolicy, rothEvidence: s.rothEvidence, now: () => s.clock.value, uuid: s.nextUuid, sendAlert: s.sendAlert, ...options });
  s.run = options => reconcileMonthly(s.args(options));
  let bankIdentity = 30000;
  s.row = (amount, direction, description) => {
    const row = { id: ID(bankIdentity++), accountId: s.config.accounts.income, amountInCents: amount, direction, description,
      merchantName: null, category: null, status: 'COMPLETE', transactionDate: asISO(s.clock.value) };
    s.bankRows.push(row); return row;
  };
  s.refresh = () => { for (const account of s.client.accounts.values()) if (account.balance && account.type === 'EXTERNAL_ACCOUNT') account.balance.balanceLastUpdatedAt = asISO(s.clock.value); };
  s.deposit = (amount, description = 'REGULAR PAY') => {
    s.row(amount, 'MONEY_IN', description);
    const balance = s.client.accounts.get(s.config.accounts.income).balance;
    balance.balanceInCents += amount; balance.availableBalanceInCents += amount;
    s.clock.advance(1000); s.refresh();
  };
  s.settleAll = () => {
    s.clock.advance(1000);
    for (const transfer of s.client.transfers.values()) {
      if (transfer.status !== 'PENDING') continue;
      s.client.settle(transfer.id);
      const from = s.client.accounts.get(transfer.source.id)?.balance, to = s.client.accounts.get(transfer.destination.id)?.balance;
      if (from) { from.balanceInCents -= transfer.amountInCents; from.availableBalanceInCents -= transfer.amountInCents; }
      if (to) { to.balanceInCents += transfer.amountInCents; to.availableBalanceInCents += transfer.amountInCents; }
      if (transfer.source.id === s.config.accounts.income) s.row(transfer.amountInCents, 'MONEY_OUT', 'COORDINATOR PAYMENT');
      if (transfer.destination.id === s.config.accounts.income) s.row(transfer.amountInCents, 'MONEY_IN', 'SELF TRANSFER');
    }
    s.clock.advance(1000); s.refresh();
  };
  s.advance = at => { s.clock.value = Date.parse(at); s.refresh(); };
  return s;
}

export function useSequenceRetirement(s, { absent = false } = {}) {
  s.config.monthly.sequenceRetirement = { schemaVersion: 1, authorizedAt: asISO(s.clock.value - 1000),
    reference: 'Synthetic explicit retirement authorization', podAccountId: s.config.accounts.pod,
    rules: { payout: s.config.rules.payout, funding: s.config.rules.funding,
      legacyGeneral: s.config.rules.legacyGeneral, excess: s.config.rules.excess } };
  if (absent) s.client.rules.clear();
  s.client.listRules = async () => {
    s.client.calls.push({ method: 'listRules' });
    return { complete: true, unfiltered: true, items: structuredClone([...s.client.rules.values()].map(row => ({
      isSupported: true, createdAt: asISO(s.clock.value - 86400000), updatedAt: asISO(s.clock.value - 1000), ...row,
    }))) };
  };
  return s;
}
