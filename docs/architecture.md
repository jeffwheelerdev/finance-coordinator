# Architecture

## Version boundary

The root application is the newly authored 0.3.0 Node.js coordinator. Sequence
owns account connections, rules, and transfer execution; the coordinator reads
evidence and, when explicitly activated, submits constrained Income→recipient
transfers. Vercel Functions runs it and a private Blob ledger preserves its
decisions across invocations.

The Python decision core and 0.1.0 observer in `archive/` are historical work.
The observer is read-only, and its PostgreSQL schema is not the current storage
design. `snapshots/deployment-0.2.1/` remains an incomplete original export.
Current files with similar names are replacements, not recovered originals.

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

```text
target           = monthly budget × reserve months
bills shortfall  = max(0, Bills buffer target − Bills cash)
protected Income = explicit Income reserve + bills shortfall
usable Income    = max(0, Income cash − protected Income)
target gap       = max(0, target − destination cash)
transfer         = min(target gap, usable Income)
```

The coordinator reserves the Bills shortfall in Income; it does not itself
transfer that reserve to Bills. An amount below the provider's minimum is a
recorded no-op. There is no borrowing, reverse withdrawal, or transfer solely
because spending has reduced a destination balance.

General Spending always has priority zero. Additional enabled recipients run
in ascending priority and stable-ID order, sharing the same Income protection.
Each accepted transfer must resolve, and subsequent cash evidence must reflect
settlement, before another recipient can spend from Income.

## Durable event and request state

The private object `finance-v3/ledger.json` records activation, bindings,
recipient eligibility, refund events, immutable requests, provider transfer IDs,
and webhook receipts. The activation cutoff, ledger location, and recorded
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

## Concurrency and uncertain outcomes

Blob conditional writes compare the current ETag before committing a change.
A 360-second lease exceeds the function's 300-second maximum lifetime; the
engine also has a shorter internal deadline. One writer and one unresolved
transfer serialize all recipients. See [Vercel Blob conditional writes](https://vercel.com/docs/vercel-blob#conditional-writes).

An uncertain response never creates a fresh request key. The identical key and
body can be retried only within 23 hours of the first attempt, inside Sequence's
24-hour idempotency period, and only after current evidence still supports the
entire frozen amount. Lowering a budget cannot enlarge or resize that request.
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

The daily cron is scheduled at 13:00 UTC. On Vercel Hobby it can run within that
hour; it is not a precise-minute or settlement guarantee. Optional signed
webhooks can wake the same reconciler after durable receipt. Payloads supply
notifications, not trusted transfer evidence. Registration and delivery must
be configured separately. See [cron timing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Pagination, provider requests, runtime, and ledger size are bounded. Reaching a
limit stops processing rather than assuming the omitted history is safe. A
large history will need a reviewed archival or cursor design that preserves
pending work and deduplication; deleting state is not an archival procedure.
