# Staged setup, activation, and operation — v0.6.1

The repository and its tests prepare the monthly coordinator. They do not
activate financial automation, exercise a real transfer, or prove a real email
was delivered. Keep `APP_MODE=observe` and `LIVE_TRANSFERS_ENABLED=false`
through setup and review.

## 1. Prepare the inactive deployment

Use one production project, stable canonical host, and the established private
Blob ledger. Scope real credentials to Production. Preview and historical
deployment URLs must not share financial write authority.

Set `MONTHLY_PRIORITY_ENABLED=true` with the exact private account mappings.
Retain the four-account and three-rule JSON shapes; add the separate Emergency,
Project, Personal Investment, and Emergency excess-rule variables documented in
[configuration](configuration.md). Every mapped old Sequence rule must be
**DISABLED**, including native Income allocation, Pod payout, legacy General
top-up, and the old Emergency excess rule. The monthly branch must be the only
coordinator for these allocations.

The four native rules have been renamed `ARCHIVED … DO NOT ENABLE` and use
manual triggers. Their historical actions remain, but the old 1st/15th and
Pod-arrival triggers have been removed. They are not the monthly coordinator
and must not be enabled as part of activation.

Do not delete the old Pod merely to satisfy this version. Its existence is
compatible with monthly mode; it is excluded from the new routing. Existing
funds, pending transfers, or earlier live coordinator history must be reconciled
rather than silently abandoned.

Keep the existing private Sequence key; no replacement is requested. It already
has transfer authority. Preparation must establish and record its unattended
approval setting, exact permitted pairs, and amount limits, alongside reads for
the relevant account roles, transfer history, external Income transactions, and
mapped rules. The required monthly pairs are:

| Source | Destinations |
| --- | --- |
| Income | Bills, General, Emergency, Roth, Project, Personal Investment |
| Emergency | Income only |

Check any per-transfer amount cap and human-approval requirement through the
provider's supported controls, then record the reviewed evidence in
`activation_policy.sequenceAuthority`. A successful account read does not prove
unattended execution or the deployed key's pair and amount coverage. Sequence
MCP OAuth requires human approval for money movement; its simulations bypass
approval and cannot establish the production key's unattended behavior. See
the [Sequence API reference](https://api.getsequence.io/platform/). The current
preparation authorizes the explicit simulation procedure below using the
existing production key. It does not authorize a real transfer.

## 2. Verify private policy

The private Global Config source must contain the Bills catalog and fresh
monitor record, Roth policy/route envelope, monthly income policy, and
`activation_policy`. Unverified opening and operational-evidence records are
expected staging blockers, separate from the deliberately disabled live gates.

Verify the opening Income balance and its regular/windfall partition against
a dated bank snapshot. The verified opening record requires `unknownCents=0`;
fully classify its existing cash before fixing that baseline. Narrow receipt rules and exact
overrides require supporting evidence; a DFAS/payroll label alone does not
establish bonus-free pay. Retain unknown receipts as held cash.

Verify personal annual IRA facts separately from the published IRS cap:
eligibility, applicable combined and Roth ceilings, outside contributions,
other schedules, and ownership of future automated contributions. Preserve the
current-year ACH route proof. New annual IRS data does not prove these personal
facts.

The ledger must have complete bank-history coverage from its opening/checkpoint.
A history gap beyond the provider's available window needs a reviewed
reconciliation. Do not move the opening date or reset the ledger to hide a gap.

## Direct email alerts

Configure `RESEND_API_KEY`, the resolved private `ALERTS_EMAIL_TO`, and a
permitted `ALERTS_EMAIL_FROM`. Recipient discovery alone does not connect the
provider. The preparation seed records delivery as unverified.

The default Resend test sender `onboarding@resend.dev` can send only to the
address attached to that Resend account. A different intended recipient needs
an appropriate verified sender domain. Follow
[Resend's restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain);
do not assume the recipient qualifies.

A real delivery check is a separately reviewed, authorized email action. Keep
financial gates off while checking it. Confirm provider acceptance and actual
receipt separately; neither a configuration flag nor an offline test proves
inbox delivery.

Record both results in `activation_policy.emailDelivery`, with the evidence
time and private reference. The verified record requires `providerAccepted=true`
and `recipientConfirmed=true` and is bound to the current sender and recipient.
A sender or recipient change invalidates that match. `/api/alerts` reporting
`configured=true` means configuration syntax is present, not that a message
arrived. Its ledger `DELIVERED` label records provider acceptance only.

Alerts are attempted when the coordinator detects a problem. Bank snapshots
may already be delayed, and the normal check is daily. Resend's
[idempotency retention](https://resend.com/docs/dashboard/emails/idempotency-keys)
is 24 hours, so a delivery outcome that remains unknown beyond the reviewed
retry window requires inspection rather than an automatic new send.

## 3. Review the staged endpoints

The public health response intentionally omits credentials and private account
data. Administrative routes require the private bearer secret.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Public health/build information. |
| `GET /api/status` | Protected effective configuration and aggregate state. |
| `GET /api/preflight` | Read-only configuration, account-role, rule, policy, and storage readiness checks. |
| `GET /api/readiness` | Read-only activation prerequisites, unfinished blockers, expected final switch changes, and the next eligible cycle. |
| `GET /api/plan` | Read-only proposed plan; not permission or a reservation. |
| `GET /api/monthly` | Monthly obligations, held pools, blockers, and aggregate execution state. |
| `GET /api/roth` | Annual room, monthly obligations, and Roth blockers. |
| `GET /api/bills` | Current Bills projection and monitoring evidence. |
| `GET /api/alerts` | Alert configuration and durable acceptance status. |
| `GET /api/reconcile` | Authenticated scheduled reconciliation; obeys global gates and the monthly write window. |
| `POST /api/webhook` | Optional signed provider wake-up; not financial evidence by itself. |

Build/CLI observation can record leases and run metadata without financial POSTs.
Use the HTTP read endpoints when an entirely read-only storage check is needed.
Understand every staging blocker before enabling live execution. Offline tests
use mocked providers and do not replace bank, permission, or email verification.

Read `readyForActivation` and `executionEnabled` separately. A prepared inactive
deployment has `readyForActivation=true` and `executionEnabled=false`.
`activationChanges` lists the final settings; `blockers` contains unfinished
prerequisites. The latter cannot be resolved merely by setting live flags.
The report includes the next eligible cycle's tax year, so a new year's IRA
policy can be required before a year-end activation.

Run the offline rehearsal with:

```bash
npm run simulate
```

This invokes `scripts/rehearse-monthly.mjs`: the actual monthly engine runs
against synthetic accounts, an in-memory ledger, and fake provider/alert
adapters. A network tripwire rejects fetch attempts. Its deterministic JSON
receipt covers monthly priority, partial Roth carryforward, December windfalls,
uncertain submissions, duplicate wake-ups, and year transitions. It sends no
bank POST or real email. Native simulations of the archived Sequence rules do
not exercise this coordinator's ledger or current allocation policy.

### Explicit provider simulations

The separate `npm run simulate:sequence` command verifies the existing runtime
key against the configured account pairs. It requires
`RUN_SEQUENCE_SIMULATION=true`, `APP_MODE=observe`, and
`LIVE_TRANSFERS_ENABLED=false` before policy reads or provider requests. An
inactive production build can invoke it once under that flag. Remove the flag
or set it to `false` afterward; the default build and offline rehearsal do not
run these provider POSTs.

Its separate adapter hardcodes `simulation:true` in every request and supplies
a synthetic source balance at least as large as the test amount. The seven
probes are Income→Bills at its full calculated target, Income→General at its
full configured target, Income→Emergency at its configured cap, Income→Roth at
the indicative installment from verified statutory policy, Income→Project at
$250, Income→Personal Investment at $4,000, and Emergency→Income at $25. The
provider's $1 minimum applies to zero targets. These are synthetic scope tests,
not an allocation plan or a statement that the accounts hold these balances.

Every successful response must identify the exact pair and amount with
`executionMode:SIMULATION` and terminal `COMPLETE` status. Unexpected live mode,
an inconsistent response, rejection, or timeout stops the remaining probes.
There is at most one request per pair, no automatic retry, no application-ledger
write, and no live request path. Provider simulation records are expected.

Keep the sanitized receipt separate from readiness proof. It establishes the
tested credential's acceptance at the reported amounts, not unlimited amounts
or future cash. Simulations bypass approval, so they cannot establish
`sequenceAuthority.automaticApproval=true`; they also do not verify personal
Roth eligibility, real settlement, or email delivery.

The initial production build with the live-transfer gate enabled is rejected
when activation prerequisites are incomplete. A validated ledger that already
establishes activation does not need to pass as a fresh activation for every
code repair: accepted transfers can remain observable. This distinction does
not waive normal build checks, cash evidence, or financial execution guards.

## 4. Activate prospectively when authorized

The intended final instruction is “Activate automation.” It can be a single
instruction only after missing financial facts, email receipt, and unattended
provider controls have been resolved. A readiness report or this documentation
does not itself authorize activation.

After that instruction:

1. Refetch current account, rule, bank-history, private-policy, and operational
   evidence. Confirm the official IRS limit and personal IRA records for the
   next eligible cycle's year. Keep all four native archives disabled.
2. Run the offline rehearsal and production read-only checks. Require no
   unfinished prerequisites in `/api/readiness`; inspect `/api/plan` and
   `/api/preflight` alongside it. These checks do not move money or send mail.
3. Choose a prospective `AUTOMATION_START_AT` with time to deploy and review,
   at or before the intended first-day 15:00 UTC slot. Preserve any already
   established cutoff instead of resetting it.
4. Update the existing Vercel production gates to `APP_MODE=live` and
   `LIVE_TRANSFERS_ENABLED=true`, then deploy through the initial-activation
   build gate. Keep the same reviewed credentials, private policies, and ledger.
5. Verify the current canonical production deployment's version, effective
   gates, cutoff, next cycle, and readiness response. Check that the native
   archives remain disabled; enabling them is not part of this procedure.

Apply environment changes through a verified deployment;
[Vercel environment changes](https://vercel.com/docs/environment-variables/managing-environment-variables)
do not alter an already built deployment.

The cutoff is a lower bound, not a promise to transfer at that instant.
Activation after a month's first-day 15:00 UTC slot starts eligibility the next
month. Preserve the recorded cutoff, account bindings, and ledger permanently.
Existing live legacy events need a reviewed migration.

The cron calls reconciliation daily at 15:00 UTC. New monthly requests are
allowed only on New York's first day from that time onward. Later checks observe
accepted transfers, update evidence, and report missed work. There is no 15th
allocation, deposit-triggered refill, or month-end regular sweep.

[Vercel cron timing](https://vercel.com/docs/cron-jobs/usage-and-pricing),
provider approvals, bank snapshot freshness, and ACH settlement can delay work.
Missing the allowed day does not authorize a late replacement transfer.

## 5. Operate and recover

Pause new work by disabling the live-transfer gate and deploying that change.
Accepted transfers can still settle and remain observable. Keep their provider
IDs, original requests, idempotency keys, and ledger records.

An unknown transfer outcome stops later submissions. Recovery preserves the
exact request/key, remains within 23 hours of the first attempt, and must still
fit the same first-day window. Outside those limits, inspect provider evidence
before a reviewed repair. Never erase a ledger entry or send a replacement
with a new key merely to clear an error.

Roth shortfalls remain dated same-year obligations for later monthly cycles.
Project history feeds the December windfall catch-up. Prior-year windfalls and
cross-year IRA settlement attribution require review. No January rule silently
relabels them.

Optional webhooks must be registered with the actual canonical endpoint and
issued signing secret. The receiver verifies signatures, records a receipt,
and rereads the provider. Neither webhook registration nor a configured secret
guarantees delivery, immediate bank data, or settlement.
