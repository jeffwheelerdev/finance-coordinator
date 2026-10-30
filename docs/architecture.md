# Architecture

## Version boundary

The root application is the newly authored 0.5.0 Node.js coordinator. Sequence
owns account connections, rules, and transfer execution; the coordinator reads
evidence and, when explicitly activated, submits constrained Income→recipient
transfers. Vercel Functions runs it and a private Blob ledger preserves its
decisions across invocations.

Private Global Config supplies Bills obligations and a recent monitoring
heartbeat. A separate scheduled ChatGPT task reads Finances evidence and
updates that configuration. The deployed function does not access the Finances
connector. The catalog update and the financial execution paths remain separate.

The Python decision core and 0.1.0 observer in `archive/` are historical work.
The observer is read-only, and its PostgreSQL schema is not the current storage
design. `snapshots/deployment-0.2.1/` remains an incomplete original export.
Current files with similar names are replacements, not recovered originals.

### Dependency constraint

Blob 2.8.2 supplies the required origin-read and conditional-write APIs. Its
OIDC helper is scoped to version 3.5.0 in `package.json` to avoid the unused CLI
configuration dependency that brings vulnerable Zod code into later helper
versions ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
The store always supplies its explicit read/write token; the SDK selects that
authentication path before OIDC discovery. Keep this constraint until the
upstream dependency chain is patched, then validate the full storage preflight
when updating it. Dependency audit results describe the installed versions,
not a permanent absence of security issues.

## Evidence before funding

A candidate must contain a positive `COMPLETE` transfer with the exact
configured Pod source, Income destination, payout rule, and payout execution.
Refunds belonging to the same execution form one event. Both the refund and its
parent payout must start within the activation window.

The coordinator reads the parent execution and all of its listed transfers. It
requires consistent successful counts and settled transfers, then verifies that
the Pod has zero current balance, available balance, and holds. Pending relevant
movements delay funding; failed or inconsistent evidence blocks execution or
requires review.

A separate guard fully enumerates funding-rule executions since activation.
Pending executions delay funding; failed, partial, or denied executions prevent
new submissions. Older `EXECUTED` summaries use Sequence's all-success status
contract; the latest successful execution also receives a detailed count and
identity check. This guard makes no claim that a funding run can be joined to a
particular payout by matching an amount or timestamp.

Sequence defines `COMPLETE` as successful settlement. External-account cash
snapshots must be dated after the payout and the latest relevant completed
movement, including previous coordinator transfers, and must be no older than
the configured limit of at most 26 hours. Managed balances are checked directly.
This is provider-reported settlement plus subsequent balance evidence, not an
independent match against bank transaction records. Sequence's external balance
refresh can occur approximately once per banking day, so stale evidence can
legitimately delay a run. See the official [Sequence API reference](https://api.getsequence.io/platform/)
and [OpenAPI schema](https://api.getsequence.io/platform/openapi.json).

## Cash calculation

All arithmetic uses exact integer cents. For Income, Bills, and the destination,
cash is the lesser of current and available balances. Credit or overdraft
availability cannot increase the usable cash amount.

The first allocation is Bills:

```text
Bills target    = ceil(highest forecast month / 50,000 cents) × 50,000 cents
Bills gap       = max(0, Bills target − Bills cash)
usable Income   = max(0, Income cash − explicit Income reserve)
Bills transfer  = min(Bills gap, usable Income)
```

The Bills transfer fills the deficit itself, so that deficit is not also
subtracted from usable Income. A full Bills transfer must settle before a
lower-priority allocation is planned. All required external cash snapshots
must then postdate settlement. If Bills already meets its target, a recorded
no-op can proceed to the next plan in the same invocation.

Bills has effective priority zero, General Spending priority one, and optional
recipients priority two or later. Existing optional ranks receive a one-position
offset while preserving relative order. For a lower-priority recipient:

```text
target           = monthly budget × reserve months
Bills floor      = max(current calculated target, this cycle's prior Bills target)
Bills shortfall  = max(0, Bills floor − Bills cash)
protected Income = explicit Income reserve + Bills shortfall
                   + eligible unpaid current-month Roth installment
usable Income    = max(0, Income cash − protected Income)
target gap       = max(0, target − destination cash)
transfer         = min(target gap, usable Income), only if Bills shortfall is zero
```

The earlier cycle target remains protected even when the catalog target falls.
An increased target must also be met before lower priorities proceed. Every
accepted transfer must resolve, and new cash evidence must reflect settlement,
before another recipient can spend from Income.

Each recipient receives at most one immutable intent per refund. If the Bills
amount is partial, or an unmet Bills deficit cannot produce a provider-eligible
amount, all lower recipients are permanently skipped for that event. Later
money or catalog changes do not revive the event. A new refund can create a
new opportunity. There is no borrowing, reverse withdrawal, or transfer solely
because spending has reduced a balance.

## Independent monthly Roth workflow

The `roth-month` event kind shares the same Blob lease, active-intent pointer,
immutable request mechanism and provider adapter. A key such as
`roth:roth-ira:2030-01` identifies one prospective monthly opportunity. It does
not pass through refund discovery or require an empty Pod. Existing event
records without a kind remain refund events, so historical identities and
deduplication remain intact. Roth's permanent destination binding is separate
from the existing cash-account binding.

The monetary policy separates two verified annual ceilings: direct Roth and
combined regular Traditional/Roth contributions. Outside contributions exclude
all coordinator requests. Every immutable own request reserves its full amount,
including pending, uncertain and review states. A retry excludes only its own
reservation when testing the unchanged body. The ledger protects observed
outside-contribution floors and policy timestamps against rollback. Market
balances, earnings and dividends never supply contribution-room evidence.

The cash guard validates the exact investment destination and current-year
deposit route. It reads the reviewed native savings definition and requires the
latest expected 1st/15th scheduled run to have begun, including all matched-step
commitments. Known pending native Income debits can remain unsettled, but their
full amounts are reserved. The guard also conservatively subtracts pending
Income credits, protects the current Bills shortfall and rejects unidentified
Income debits. A pending Pod refund is therefore neither a prerequisite nor
spendable promised money. Completed movements require fresh subsequent cash
snapshots before their balances can fund another request.

New unfamiliar completed Roth credits after the verified outside-contribution
baseline require reconciliation. Known own credits must match their immutable
provider identity and requested amount. This prevents a new external deposit
from being ignored merely because an earlier exclusivity attestation exists.

An insufficient full installment remains waiting during its current month.
Unlike a cash-account refund opportunity, that state can retry after new cash
arrives. Older unsubmitted months expire; they are not added to later payments.
The engine checks the local month again immediately before the provider POST.
Cross-year uncertain or late-settling contributions retain their identities and
require tax-year reconciliation; they are never relabeled as the new year's
contribution. See [Roth policy](roth-policy.md) for exact cents and annual fields.

Policy-source or eligibility problems affect Roth separately. Existing Bills
and General work can continue under their own evidence requirements, while an
already recorded unpaid Roth obligation remains protected from lower-priority
cash funding. A shared unresolved provider request, lost storage lease or ledger
integrity problem still prevents competing financial submissions.

## Forecast and private source freshness

`lib/bills.mjs` projects twelve local calendar months using current obligations.
Annual charges stay in renewal months, and unknown annual dates are grouped
conservatively into the highest month. Weekly and biweekly schedules use actual
calendar occurrence counts. Uncertain expenses remain included. Confirmed
future cancellations stop contributing only when their effective date arrives.
Card payments and own-account transfers are excluded from duplicated expenses.
The catalog is a projection input, not a claim of complete bank coverage.

The runtime reads `bills_catalog` and `bills_monitor` in one Global Config call
with `consistentRead: true`, caching disabled and `staleIfError: false`.
The validated monitor must match the catalog revision and report a successful
check no older than seven days. A missing, stale, malformed or unavailable
source blocks new submissions; there is no old-policy fallback. Only observation
of an already accepted transfer with a saved provider ID can continue without
fresh policy. See [Bills monitoring](bills-monitor.md) for the updater contract.

The ledger records catalog time, hash, forecast year and local effective date.
Older catalog timestamps, older years or older effective dates are rejected.
Different content cannot reuse a catalog timestamp. A changed forecast for
the same catalog and year requires a later effective date, allowing a scheduled
cancellation without inventing a new catalog revision. Plans retain their own
catalog provenance and target even as subsequent policy changes.

## Durable event and request state

The private object `finance-v3/ledger.json` records activation, bindings,
recipient eligibility, refund events, immutable requests, provider transfer IDs,
webhook receipts, and the latest accepted Bills policy metadata. The activation cutoff, ledger location, and recorded
identity bindings are durable operating history. Never reset or delete this
ledger, change its prefix, or advance the activation cutoff to clear an error.

| Recipient state | Meaning and next action |
| --- | --- |
| `WAITING` | Eligible for the claimed event; evidence and cash are checked before submission. |
| `SUBMITTING` | Exact request and idempotency key were saved before the provider call; outcome may be unknown. |
| `PENDING` | Provider transfer identity is known; poll that same transfer until it resolves. |
| `COMPLETE` | Transfer settled; this event cannot fund this recipient again. |
| `NOOP` / `SKIPPED` | No eligible amount or recipient; the opportunity is consumed without a transfer. |
| `REVIEW` | Preserve the request and evidence for explicit reconciliation; new funding is blocked. |

Recipients are captured when the event is claimed. A partial fill, satisfied
target, or lack of uncommitted cash does not create a standing promise to top up
later. Budget edits do not replay completed events. New or re-enabled recipients
are prospective: the ledger's eligibility floor and any `startsAt` date exclude
older payout executions.

Observation and forced build checks may record run metadata or observe an
already accepted transfer. Planning an existing open event uses a copy: it
cannot persist simulated no-ops, skips, completed children or consumed events.
The HTTP plan endpoint performs no ledger writes.

An existing live open event from an older policy that lacks a Bills child
requires reviewed migration; it is not retrofitted into new financial work.
An inactive ledger without financial event history needs no reset. The ledger
schema version and permanent event identities remain unchanged.

## Concurrency and uncertain outcomes

Blob conditional writes compare the current ETag before committing a change.
A 360-second lease exceeds the function's 300-second maximum lifetime; the
engine also has a shorter internal deadline. One writer and one unresolved
transfer serialize all recipients. See [Vercel Blob conditional writes](https://vercel.com/docs/vercel-blob#conditional-writes).

An uncertain response never creates a fresh request key. The identical key and
body can be retried only within 23 hours of the first attempt, inside Sequence's
24-hour idempotency period, and only after current evidence still supports the
entire frozen amount. Lowering a budget cannot enlarge or resize that request.
The retry also retains the cycle's earlier Bills target floor, so a lower
current catalog target cannot release money protected by the original plan.
If a pending movement prevents fresh verification, the engine waits; it does
not infer identity from similar amounts or dates. At the recovery-window limit,
an unresolved submission requires review. Some network failures therefore need
human reconciliation.

Use one production project as the writer. Previews must be unconfigured or use
an isolated store; they must never share the production ledger. Operational
routes are disabled in the Vercel Preview environment. Production mutation
routes require the stable `FINANCE_CANONICAL_HOST`, preventing stale immutable
deployment URLs from submitting with old budgets. This host guard does not
authorize overlapping production projects.

## Wakeups and bounded work

The daily cron is scheduled at 15:00 UTC. On Vercel Hobby it can run within that
hour; it is not a precise-minute or settlement guarantee. Optional signed
webhooks can wake the same reconciler after durable receipt. Payloads supply
notifications, not trusted transfer evidence. Registration and delivery must
be configured separately. See [cron timing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Pagination, provider requests, runtime, and ledger size are bounded. Reaching a
limit stops processing rather than assuming the omitted history is safe. A
large history will need a reviewed archival or cursor design that preserves
pending work and deduplication; deleting state is not an archival procedure.
