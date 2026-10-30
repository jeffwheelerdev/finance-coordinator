# Architecture — monthly coordinator and private dashboard

The current monthly branch separates policy, evidence, allocation planning,
execution, and alert delivery. `MONTHLY_PRIORITY_ENABLED=true` selects this
branch. Legacy refund execution remains available only for reviewed historical
operation; the two branches must not independently fund the same accounts.

## Components

| Module | Responsibility |
| --- | --- |
| `monthly-source.mjs` | Strict private opening-income and classification policy. |
| `income-ledger.mjs` | Durable bank-feed ingestion, opening-balance reconciliation, regular/windfall/unclassified pools. |
| `monthly-evidence.mjs` | Read-only account, legacy-rule, transfer, and external-bank evidence. |
| `monthly-plan.mjs` | Pure priority arithmetic, dated obligations, partial Roth allocation, December windfall waterfall. |
| `monthly-engine.mjs` | Monthly window, durable cycle/requests, cash reservations, settlement observation, outbox. |
| `roth.mjs` | Statutory and personal annual ceilings; monthly targets and annual room. |
| `bills.mjs` | Current catalog projection and rounded Bills target. |
| `sequence.mjs` | Bounded provider reads and exact pre-authorized idempotent transfers. |
| `alerts.mjs` | Private Resend sender and redacted deterministic alert content. |
| `app.mjs` | Authentication, canonical-host enforcement, read endpoints, branch selection. |

Global Config stores policy. The established private Blob ledger stores state
and remains the sole execution lease. Conditional writes and the existing
lease protect against overlapping cron or webhook invocations.

## Monthly execution boundary

The calendar is `America/New_York`. New requests are allowed on the configured
day (the 1st by default), at or after 15:00 UTC for that month's frozen slot.
January–November allow days 1–28; December allows days 1–15.
The activation cutoff determines
the first eligible month. A later-day cron or webhook can observe an existing
request and update evidence, but cannot initiate a missed allocation.

The daily 15:00 UTC cron starts reconciliation. During an eligible monthly
window, expiring Queue messages request bounded hourly follow-up checks through
the current canonical service. This does not create new funding dates.
The monthly branch does not inspect the Pod balance or wait for a refund.
Every mapped native allocation/excess-return rule must be disabled.

## Cash and income evidence

Income, Bills, General, Emergency, and Project must be the exact configured
external depository accounts. Income must send and receive; Emergency must
receive contributions and send authorized excess returns. Personal Investment
and Roth are explicit investment destinations. Their market values do not
establish spendable Income or IRA contribution room.

For each cash role, the evidence layer retains current and available balances
separately. Spendable cash begins with their minimum. Snapshots must be recent,
error-free, and later than relevant completed transfers. A posted Income-bank
row newer than the snapshot blocks reconciliation.

The external transaction adapter freezes account filters and the upper time
boundary before pagination, validates every record's account/direction/status/
amount/date, consumes every page, and rejects duplicates, changed bounds, bad
ordering, or a provider-truncated interval. The income ledger uses overlapping
reads, preserves prior completed rows, and rejects changes or unexplained gaps.
A 90-day API clamp cannot replace missing durable history.

The opening balance and all retained posted transactions must reconcile exactly
to the current Income balance. A verified opening baseline must classify all
existing cash, with zero unclassified cents. Classification evidence assigns later receipts to
regular, windfall, or unknown pools. No recipient amount is inferred from a
deposit description alone. Windfall and unknown balances remain protected from
ordinary spending; previously reserved windfall cents cannot be reserved again.

## Pending transfers and target gaps

An exact owned pending transfer must match its durable provider ID, original
amount, source/destination, user origin, timestamps, and absence of rule linkage.
Unrecognized outgoing Income or Emergency transfers block new work. An unknown
request is not adopted because its amount, date, or description looks familiar.

Known source debits and incoming credits are conservatively reserved. Pending
bank-feed debits and credits are reserved separately unless independently
reconciled. A duplicate representation can therefore reduce available cash more
than once. This is a conservative limit of the evidence; it is not proof that
two payments occurred. The coordinator does not guess cross-feed linkage.

Pending destination credits count toward their funding targets so a prior
accepted top-up cannot create another gap fill. They never become refundable
Emergency cash or spendable Income before settlement. A settled provider
transfer still needs suitable bank evidence before its cash is reused.

Emergency cap checks use its current posted balance plus pending incoming
transfers. The smaller current/available balance remains relevant to spendable
cash, but a hold does not create room to fund Emergency above its target.

## Planning and conservation

One cycle freezes the opening eligible regular-income pool and all planned
allocation amounts. Emergency uses 7.5% and Project uses 5% of that same basis.
The explicit Income reserve is deducted once. Priority is Bills, General,
Emergency, Roth, Project, then Personal Investment.

Every line records its regular/windfall partition. Planned transfers plus held
regular and windfall balances must equal the available authorized pools exactly.
The planner keeps unverified or unpaid higher obligations from becoming
discretionary surplus.

Roth and Project targets remain dated by month. An eligible partial Roth
contribution leaves its unpaid obligation for later first-day cycles in the same
tax year. Project's regular allocation addresses its current target; recorded
older Project shortfalls are considered in December's windfall allocation.

Windfalls are released only in the December 1 annual-close cycle and only for
verified same-year Roth shortfalls, then Project shortfalls, then Personal
Investment. Prior-year windfall cash and unresolved prior-year IRA attribution
require review. The current-year ACH route cannot select a prior tax year.

## Durable execution and failure recovery

Before the first provider POST, the cycle and each allocation's reservation are
saved. Before each individual POST, the exact request, its hash, UUID
idempotency key, and first-attempt time are saved. Request fields cannot change
during recovery.

The engine submits in priority order. After a request has a known accepted
provider ID, lower requests may proceed against the remaining reserved plan
while settlements overlap. A response with uncertain acceptance stops the
sequence. A higher transfer can fail after lower transfers were accepted;
settlement priority is not atomic and already accepted transfers cannot be
assumed reversible.

| State | Meaning |
| --- | --- |
| `PLANNED` | Durable reserved allocation without a financial request yet. |
| `SUBMITTING` | Exact request saved; acceptance may still be uncertain. |
| `PENDING` | Provider identity known; observe that transfer. |
| `COMPLETE` | Provider completion recorded after identity checks. |
| `NOOP` | No eligible request, including a sub-dollar amount. |
| `SKIPPED` | Opportunity closed without a new request. |
| `REVIEW` | Failure, uncertain identity, expired recovery, or another unsafe inconsistency. |

Unknown financial requests retain their original key and body. Recovery also
requires the same first-day window and a first-attempt age below 23 hours.
A new key is not a recovery strategy. An accepted transfer can still be polled
while execution is paused or policy is unavailable. Its existence does not
authorize other requests.

The Sequence adapter has an exact directional account-pair allowlist. The
monthly additions are Income→Emergency, Income→Project, Income→Personal
Investment, and Emergency→Income, alongside Bills, General, and Roth.
There is no monthly money-moving route to or from the old Pod.

## Alerts

The private ledger holds stable alert identities, attempts, and acceptance
records. Live execution needs a configured direct email sender. Critical
delivery uncertainty is visible in status and must not silently disappear.
The sender exposes only selected issue codes, dates, and amounts; it excludes
raw provider responses, account IDs, credentials, and private evidence text.

Resend retains idempotency keys for
[24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys).
Alert retries must preserve the request and remain within the reviewed recovery
window; an unknown outcome after that window requires review rather than a
blind resend. A provider email ID proves acceptance, not inbox delivery or
that the recipient read the message.
The ledger's `DELIVERED` status and `deliveredAt` field record this provider
acceptance; they are not delivery-event or inbox evidence.

## Operational limits and historical branch

Sequence reports external balances on an upstream refresh schedule, commonly
daily; faster API polling does not force a fresh bank balance. Its transfer
API is asynchronous and has a $1 minimum. See the
[API reference](https://api.getsequence.io/platform/),
[balance guidance](https://intercom.help/sequence/en/articles/12856934-intro-to-external-accounts),
and [ACH routing explanation](https://support.getsequence.io/hc/en-us/articles/48175534864531-Can-I-transfer-from-one-external-account-to-another).

Bank delay, conservative duplicate reserves, approvals, or stale evidence may
prevent first-day completion. The system records the resulting shortfall;
it does not weaken evidence or create a late transfer to make a cycle appear
successful.

Legacy `engine.mjs`, `evidence.mjs`, and `upstream.mjs` retain the earlier
settled-refund and native-savings behavior for historical compatibility.
Those native-rule requirements do not apply to the new monthly execution path.
An existing financial ledger needs reviewed migration; clearing it would remove
the evidence that prevents duplicate requests.

## Private dashboard and scheduled wakeups (v0.7)

The dashboard reads the same private ledger as execution. Browser sessions are
scoped to a narrow dashboard API behind Vercel All Deployments authentication;
they cannot authenticate reconciliation, webhooks, or alert sending. Settings
preview is pure. Saving adds a versioned controls revision with an exact CAS and
preserves financial state. Each started cycle freezes its settings and window.

A daily cron invokes the scheduler. On the configured monthly day, a finite
queue of delayed checks can wake the current canonical coordinator before New
York midnight. Queue consumers have no financial client. They use runtime OIDC
and the existing server-side bearer secret to call the currently deployed
guarded endpoint, so deployment pinning cannot preserve obsolete live behavior.
The separate scheduler probe visits only health and records a bounded receipt.

See [dashboard](dashboard.md), [access](dashboard-access.md), and
[scheduler](scheduler.md). There are no duplicate native Sequence funding rules.
