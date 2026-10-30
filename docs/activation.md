# Staged setup, activation, and operation — v0.6

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

Do not delete the old Pod merely to satisfy this version. Its existence is
compatible with monthly mode; it is excluded from the new routing. Existing
funds, pending transfers, or earlier live coordinator history must be reconciled
rather than silently abandoned.

The private Sequence key needs reads for all relevant account roles, transfer
history, external Income transactions, and the mapped rules. Future live
authority must be scoped to the exact approved pairs:

| Source | Destinations |
| --- | --- |
| Income | Bills, General, Emergency, Roth, Project, Personal Investment |
| Emergency | Income only |

Check any per-transfer amount cap and human-approval requirement through the
provider's supported controls. A successful account read does not prove transfer
permission. Do not send a real or simulated transfer merely to test access.

## 2. Verify private policy

The private Global Config source must contain the Bills catalog and fresh
monitor record, Roth policy/route envelope, and monthly income policy. An
unverified opening partition is an expected staging blocker.

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
provider. In the staged setup, the provider key is absent and real delivery has
not been exercised.

The default Resend test sender `onboarding@resend.dev` can send only to the
address attached to that Resend account. A different intended recipient needs
an appropriate verified sender domain. Follow
[Resend's restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain);
do not assume the recipient qualifies.

A real delivery check is a separately reviewed, authorized email action. Keep
financial gates off while checking it. Confirm provider acceptance and actual
receipt separately; neither a configuration flag nor an offline test proves
inbox delivery.

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

## 4. Activate prospectively when authorized

Choose a deliberate future `AUTOMATION_START_AT`, with time to deploy and review
the effective configuration. Set both `APP_MODE=live` and
`LIVE_TRANSFERS_ENABLED=true` only for the intended canonical production
deployment. Apply the new environment through a verified deployment;
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
