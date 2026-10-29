# Deployment and deliberate activation

Version 0.4.0 is configured for inactive operation. These steps describe the
operating requirements; they are not a record that deployment, webhook
registration, or financial activation has occurred. Verification uses offline
tests and provider reads. Do not make a live transfer to test this setup.

## 1. Establish one inactive production instance

Install and run the offline suites with Node.js 22 or 24 and Python 3.12:

```bash
npm ci --ignore-scripts
npm test
python3 scripts/test_archives.py
```

Configure the real private mappings and explicit financial policy described in
[configuration](configuration.md). Keep `APP_MODE=observe` and
`LIVE_TRANSFERS_ENABLED=false`. Use the existing Sequence API key; this design
does not require a replacement key merely to deploy the code.

Connect a private Blob store and retain the fixed `finance-v3/ledger.json`
location. One production project owns this ledger and its cron. Do not run
overlapping production projects. Keep all real secrets scoped to Production.
Preview deployments must stay unconfigured or use isolated storage and
credentials; never give them the production ledger token. Operational routes
also refuse requests when `VERCEL_ENV=preview`.

Connect a separate private Global Config store through `GLOBAL_CONFIG`. Supply
the validated `bills_catalog` and matching `bills_monitor` items, then establish
the monitoring process described in [Bills monitoring](bills-monitor.md).
The monitor's last successful check must be no older than seven days. The
runtime reads both items consistently from the origin and does not accept
stale-on-error fallback. This store supplies policy; it must not replace the
Blob execution ledger. Catalog updates take effect without deploying code.

The fixed `BILLS_BUFFER_TARGET` setting is obsolete and ignored. The current
Bills target must come from the annual calendar forecast, rounded up to a $500
boundary. A deployment without usable current Bills policy cannot submit.

Set `FINANCE_CANONICAL_HOST` to the stable production alias's hostname. Production
reconciliation and webhooks refuse other hostnames, so an old deployment URL
cannot submit using its old environment. Authenticated read endpoints on an
immutable production deployment can still verify that deployment before
promotion. Review a rollback's policy carefully before moving the stable alias.

## 2. Verify rules, permissions, and read evidence

The configured funding and payout rules must be enabled before live operation.
The legacy manual General Spending top-up rule must remain disabled to avoid
duplicate independent execution. The coordinator checks rule state; it does
not edit these rules or their financial policy.

No additional native Sequence top-up rule is required for Bills or General
Spending. The coordinator submits exact transfers after the same verified Pod
refund. Do not activate upstream rules as part of an inactive deployment check.

Review the existing key's exact `MANUAL_TRANSFER` permission for
both Income→Bills and Income→General Spending, their amount caps if present,
and each future recipient pair. A cap must accommodate the intended request or the provider will reject
it. Unattended operation requires the permission's approval requirement to be
disabled. A read-only preflight cannot introspect and certify these settings.
If approval is required, an accepted transfer waits for approval; the
coordinator does not submit a second request. See the official
[Sequence API reference](https://api.getsequence.io/platform/).

Administrator routes require `Authorization: Bearer <CRON_SECRET>`. Supply the
secret privately; do not place it in URLs, screenshots, or committed commands.

| Route | Verification or operation |
| --- | --- |
| `GET /api/health` | Public basic configuration and mode status. |
| `GET /api/status` | Effective private policy summary, latest run, and unresolved-state indicators. |
| `GET /api/bills` | Aggregate twelve-month Bills forecast, dynamic cap and monitor metadata; no private bill rows. |
| `GET /api/preflight` | Read-only rule, account, upstream-history, and ledger checks. No provider or ledger writes. |
| `GET /api/plan` | Read-only evidence and funding plan; does not claim or consume an event. |
| `GET` or bodyless `POST /api/reconcile` | Operational reconciliation; may update the ledger and submit a transfer when live. |
| `POST /api/webhook` | Signed Sequence notification; durable receipt can wake operational reconciliation. |

Passing read checks does not prove write permission or establish that funds
are currently eligible. A future activation cutoff is reported as not started;
its upstream window is checked once that window exists.
Public health checks report configuration booleans; they do not prove fresh
catalog evidence, complete bill coverage, current bank balances or transfer scope.

`npm run preflight`, and the production build's preflight, force observation
and disable financial POSTs even if the configured live gates are on. They
read Sequence and exercise conditional ledger writes, so they are not purely
read-only storage checks. They may observe an existing transfer and record run
metadata. Use the authenticated HTTP preflight for an entirely read-only check.
Build failures must be understood before promotion; they are not a reason to
clear the ledger.

## 3. Activate prospectively

After the inactive deployment and evidence are reviewed, choose a deliberate
future UTC `AUTOMATION_START_AT`. Leave enough time to complete deployment and
verify the effective settings before that instant. Then configure both
`APP_MODE=live` and `LIVE_TRANSFERS_ENABLED=true` for the intended production
deployment and redeploy. Vercel environment edits take effect through new
deployments, as described in its [environment documentation](https://vercel.com/docs/environment-variables/managing-environment-variables).

The timestamp is a lower bound, not an appointment to move money. No submission
is eligible before it. Thereafter an actual new Pod refund, completed payout,
upstream checks, available cash, and suitable post-settlement snapshots must
all qualify. Bills receives the first eligible transfer while preserving the
explicit Income reserve; its deficit is not reserved a second time. General
Spending waits for Bills completion and post-settlement balances. A partial or
unfunded Bills attempt skips lower recipients for that refund cycle.
A payout without a refund does not trigger funding. A partial fill uses that
event once; normal spending does not cause continuous replenishment.

Once recorded by live operation, the cutoff and ledger history are permanent.
Never reset state, change the ledger prefix, or move the cutoff forward to
remove failures or replay work. Source/rule identity changes require a reviewed
migration, not a routine environment edit.
Existing live open events that predate Bills-first policy require reviewed
migration. Do not add a Bills child retroactively or clear the ledger. An
inactive ledger without financial events transitions without resetting state.

## 4. Scheduling and optional webhooks

The configured cron calls `/api/reconcile` daily at 13:00 UTC. Vercel provides
the `CRON_SECRET` bearer header. Hobby schedules may run at any point within the
scheduled hour. Provider settlement and bank-balance refresh can add further
delay. See [cron authorization](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
and [cron timing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

The separate Bills monitor checks Finances and updates private policy; it does
not initiate transfers or change activation gates. Its schedule and collector
contract are documented in [Bills monitoring](bills-monitor.md). Catalog or cap
changes alone do not create a funding event.

Webhooks are optional and are not registered by this repository. Register the
actual canonical `/api/webhook` endpoint in Sequence and store its issued
signing secret as `SEQUENCE_WEBHOOK_SECRET`. The receiver validates the raw-body
signature and timestamp, deduplicates a durable receipt, then re-reads provider
evidence. Setting the variable alone does not establish successful delivery.

If deployment protection blocks the provider, configure an approved endpoint
access mechanism and verify delivery without initiating money movement. See
[Vercel protection bypass for automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
Do not interpret a configured webhook or cron as instant bank settlement.

## Pause and resolve an exception

Pause new submissions by setting `LIVE_TRANSFERS_ENABLED=false` and deploying
that change to the canonical host. Keep the same ledger, cutoff, and bindings.
Previously accepted transfers can still settle; the engine continues observing
their provider identities while paused.

The same limited observation is available during a Bills-policy outage when
the ledger already contains an accepted transfer ID. Missing or stale policy
cannot authorize a new transfer or retry an uncertain request with no saved
provider ID. Restore valid catalog and monitoring evidence before resuming
financial work; do not substitute the old fixed buffer.

For a `waiting` result, inspect the reason: pending transfers, stale balances,
or missing post-settlement evidence need subsequent reads. For `blocked`,
`uncertain`, or `review`, inspect protected status and sanitized error codes.
An unknown outcome retains its exact request and key. It may be retried only
inside 23 hours with fresh supporting evidence; otherwise it requires explicit
provider reconciliation. Do not assume every network error will self-heal or
clear an exception by sending a new transfer.

There is no automatic ledger-reset or review-override endpoint. Preserve the
private evidence and reconcile what the provider actually accepted before a
reviewed state repair. A later successful upstream run does not erase a prior
failed run's meaning.
