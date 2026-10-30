# Monthly priority policy

This is the current execution policy when `MONTHLY_PRIORITY_ENABLED=true`.
It replaces the earlier Pod-refund trigger and independent native savings
schedule. Obsolete native rules must be disabled or covered by the explicit
retirement manifest and complete rule-inventory checks. The code does not enable
rules, change the account holder's brokerage strategy, or activate itself.

## One monthly opportunity

New transfers default to the **1st in America/New_York**, at or after
**15:00 UTC** for that month. This is 10 a.m. in standard time and 11 a.m. in
daylight time. The private dashboard can choose a monthly day from 1 through
28. December has its own early closing day, default 1 and editable from 1
through 15, to leave time for current-year IRA deposits to settle. A late or
cross-year settlement still requires reconciliation; choosing an early day
cannot guarantee settlement by December 31.

One daily cron calls `/api/scheduler` at **15:00 UTC**. The producer reads the
saved calendar and, when the current monthly window is open, publishes a finite
set of delayed Queue wake-ups before its immediate reconciliation call. Future
hourly boundaries provide up to 13 further checks in standard time, ending at
04:00 UTC, or 12 in daylight time, ending at 03:00 UTC. A delayed initial cron
can leave fewer remaining opportunities. No additional hourly cron is used.

The closing boundary is actual New York midnight: 04:00 UTC during daylight
time and 05:00 UTC during standard time. A delayed message expires at that
boundary, and the consumer checks expiry before calling reconciliation. The
financial engine independently checks its frozen execution window immediately
before each financial submission. Requests delayed past local midnight cannot
open or continue a financial submission.

Queue messages carry only a version, wake kind, execution date, wake time and
expiry. They contain no transfer amounts, account IDs or financial settings.
The private `queue/v2beta` consumer does not create transfers or publish more
messages. It authenticates a call to the canonical current production
`/api/reconcile` endpoint, so a callback attached to an older deployment cannot
execute that deployment's financial code. The daily producer also calls this
endpoint outside the execution day to observe accepted transfers and ingest
new evidence. All money decisions remain in the current coordinator.
The implementation follows the official [Queue SDK](https://vercel.com/docs/queues/sdk),
[private consumers and deployment versioning](https://vercel.com/docs/queues/concepts),
and [same-project trusted authentication](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources)
contracts.

These checks resume the same durable cycle and immutable requests. They do not
recalculate percentages, create a second monthly allowance, replace an unknown
transfer, or spend later deposits under a completed plan. A recoverable first
attempt can use a later scheduled check; uncertain transfers whose identity
cannot be established still require review.

This deployment uses one daily cron on the existing Hobby plan; it does not
require an hourly cron entitlement or a hosting upgrade. Queue delivery is a
separate supported platform capability. Its production delivery and canonical
authentication must be verified; a configured trigger or a local test alone is
not evidence that a wake reached the current deployment. Vercel's cron timing
is best effort, and a failed cron invocation is not retried automatically. See
the official [cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
and [cron operation](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The Queue trigger allows at most three deliveries, with a 300-second retry
delay for failed delivery. Delayed or repeated deliveries still use the same
monthly ledger, lease and immutable request identities. Neither the queue nor
its retries grants another monthly funding allowance. If no eligible wake
arrives before the window closes, the coordinator records the missed work and
retains any uncertain request for reconciliation.

The activation cutoff is prospective. If it is later than the month's 15:00 UTC
slot on the configured day, the first eligible allocation month is the next
month. The engine permanently records that floor. A later deposit, a new
paycheck, a policy edit, or a webhook does not create another funding
opportunity. An accepted ACH transfer may finish later; that does not authorize
a new off-cycle request.

When a planned request misses its chosen day, it is recorded as missed
instead of submitted late. Accepted transfers keep their existing identities.
An unknown submission outcome must be reconciled; it cannot be replaced with
a new request simply because the calendar advanced.

## Editable dashboard controls

The dashboard edits General's monthly budget and reserve months, the explicit
Income reserve, Emergency's target and percentage, Project's percentage, the
monthly execution day, and the December closing day. Money is stored as integer
cents and percentages as integer basis points. The initial values remain
General `$750 × 3`, Emergency `$10,000` at `7.5%`, and Project `5%`.

Every save includes an expected revision and an audit entry in the same private
ledger write. A running financial worker or stale revision rejects the save.
An active installation applies changes next calendar month; inactive staging
uses the next future opportunity without a frozen plan. A subsequent partial
edit preserves already-pending values instead of silently replacing them.

Each monthly cycle freezes its settings revision, exact due window, percentage
basis and transfer plan before any submission. Changing a date cannot reopen a
completed month, change an existing request, or invent a preactivation Roth
obligation. Old Project shortfalls retain their original monthly percentage
targets. IRS limits, personal IRA eligibility, verified contribution totals,
account identities, opening income classification, the Bills forecast and
activation switches remain outside these ordinary settings controls.

## Separate the cash by authorization

Income holds three durable virtual pools:

| Pool | Meaning | Monthly use |
| --- | --- | --- |
| Regular | Verified ordinary income and other specifically authorized regular receipts. | Available to the monthly priority order. |
| Windfall | Verified bonuses or other receipts assigned to annual allocation. | Held until the December annual-close cycle, default December 1. |
| Unclassified | Unknown, conflicting, or incompletely verified receipts. | Held until an exact reviewed classification resolves them. |

These are ledger balances inside Income, not new bank accounts or Pods.
The opening baseline must be verified and its parts must sum exactly to the
observed current bank balance. Its unclassified component must be zero: classify
all existing opening cash before fixing that baseline. Later unclassified
receipts remain held until reviewed. A default unverified baseline cannot
authorize financial execution.

The private `monthly_policy` contains the opening partition, narrowly reviewed
exact-description/merchant/amount rules, and exact transaction overrides.
Rules need dated evidence explaining why the classification is appropriate.
A payroll label such as DFAS or Navy pay is not sufficient evidence that a
deposit contains no bonus. Ambiguous matches and unrecognized receipts remain
unclassified; a clearly marked bonus cannot silently pass an ordinary-pay rule.
Initial activation readiness also requires a reviewed ongoing ordinary-pay
signature with a positive amount range and no overlapping classification rule.
A verified opening balance or a one-time transaction override alone cannot
make future payroll automation ready. Unknown future windfall descriptions need
not be guessed: unmatched receipts stay reserved and create a critical
classification alert when financial automation is running.

A completed Emergency→Income return is regular money only when the provider
transfer and external bank receipt have been explicitly reconciled. Similar
amounts, dates, or descriptions are not an identity link. Each receipt is
counted once. Unknown returns stay held until their evidence is resolved.

The income ledger retains posted rows and reads an overlapping interval on later
checks. It rejects changed or disappearing rows and reconciles opening balance
plus posted credits minus posted debits to the current bank balance. Sequence
clamps external history older than 90 days; a truncated window does not prove
coverage. A durable checkpoint must already cover older periods, or the flow
requires review.

## Freeze the opening regular basis

Let `R` be the verified spendable regular-income pool at cycle opening, before
the separately configured Income reserve. Exclude windfalls, unclassified money,
future credits, and amounts already reserved for pending requests.

```text
Emergency percentage target = floor(R × 7.5%) in integer cents
Project monthly target      = floor(R × 5%) in integer cents
```

These are the default rates. Each cycle uses its saved dashboard revision's
rates; changing a future rate does not recalculate earlier monthly targets.

Store these amounts in the monthly cycle. Later transfers and balance refreshes
do not change the opening basis or compound the percentages.

In a synthetic example, $9,000 in Income is classified as $5,000 regular and
$4,000 windfall. The percentage targets are $375 for Emergency and $250 for
Project. The entire $4,000 remains excluded from ordinary allocations.

## Allocate regular cash in priority order

Protect `INCOME_RESERVE` once, then allocate the remaining regular cash:

1. **Bills and Subscriptions:** fill the gap to the current Bills cap. The cap is
   the largest forecast month in the current year rounded up to a $500 boundary.
   The private catalog retains annual renewals in their due months.
2. **General Spending:** fill the gap to
   `GENERAL_SPENDING_MONTHLY_BUDGET × GENERAL_SPENDING_RESERVE_MONTHS`.
3. **Emergency Fund:** allocate the minimum of its opening percentage target (default 7.5%), the gap
   to `EMERGENCY_FUND_TARGET` (default $10,000), and remaining regular cash.
   The gap subtracts its current posted balance and pending incoming transfers;
   a lower available balance caused by a hold does not increase cap room.
4. **Roth IRA:** allocate up to the verified unpaid eligible monthly obligations
   for the current tax year, remaining annual contribution room, and remaining
   regular cash.
5. **Project Savings:** allocate up to the current month's opening percentage target (default 5%) and
   remaining regular cash, after the Roth obligation has been satisfied.
6. **Personal Investment:** sweep eligible remaining regular cash after the
   prior steps and protected reserves.

There is no month-end regular sweep. Personal Investment is the last allocation
in the same monthly cycle, defaulting to the 1st. Missing higher-priority evidence does not make
the corresponding cash surplus.

A nonzero shortfall creates an actionable alert. An unverified Roth obligation
holds lower-priority discretionary cash rather than treating the obligation as
zero. Investment transfers fund the configured accounts; the coordinator does
not choose or purchase securities.

## Emergency excess returns

Money already held above the Emergency target may generate a separate
Emergency→Income request on the same monthly schedule. Its cash must be verified
at the source, and the exact source/destination pair must be authorized.

The monthly plan does not count that expected return as opening regular cash.
A pending incoming return is conservatively reserved. Even after provider
completion, an appropriate bank snapshot and an explicitly reconciled bank
receipt are required before the income ledger can treat it as regular cash.
There is no intermediate routing Pod.

## Roth obligations and partial funding

A verified annual allowance is divided into twelve dated monthly targets using
integer-cent rounding. A $7,500 allowance therefore gives a $625 monthly target.
Personal eligibility, outside Traditional and Roth contributions, and all own
accepted, pending, uncertain, and completed requests constrain annual room.

If a monthly target cannot be fully funded, the eligible partial amount can be
submitted and the unpaid portion remains attached to its original month.
A later **scheduled monthly day in the same year** can pay that obligation alongside the new month's
target. The engine attributes money to older eligible obligations first.

This carryforward does not create an off-cycle debit, rewrite an earlier
immutable request, invent a target for a month with missing evidence, or replay
a prior tax year's obligation. A new year requires new verified annual policy.
An unfamiliar completed Roth credit after the outside-contribution baseline
blocks new Roth funding until reconciled.

## Project history and December windfalls

Each Project obligation records its own month's frozen percentage target. Ordinary
monthly regular allocations fund the current month's target; they do not add
all historical Project shortfalls to the next regular-income request.

On the configured **December closing day** (default December 1), current-year held windfalls may address verified same-year
shortfalls in this order:

1. Unpaid eligible Roth monthly obligations, within remaining annual IRA room.
2. Recorded Project obligations that remain unfunded.
3. Personal Investment, after the first two are satisfied.

The windfall pool does not backfill Bills, General, or Emergency allocations.
If essential targets or required annual evidence are unresolved, the affected
windfall stays held. An unknown historical Project target cannot be assumed zero.

The chosen December day is the annual-close opportunity. Windfalls
received afterward have no extra off-cycle opportunity under this policy.
When they become prior-year held cash, they require review; they are not
automatically rolled into the following year's windfall budget.

## Submission, settlement, and alerts

The engine records the cycle and allocation reservations before requesting
transfers. It submits in priority order and may proceed after a higher-priority
transfer has a known accepted provider ID. Those accepted transfers can settle
at different times. Unknown outcomes stop later submissions; failures require
review. Allocation order therefore does not promise arrival order.

Cash evidence uses the smaller current/available Income balance and subtracts
pending source debits and incoming credits. Pending external-bank rows are also
reserved. The two provider feeds do not expose a reliable cross-feed identity
in every row, so an unverified duplicate representation may be reserved twice.
This conservative behavior can leave a lower allocation unfunded on the 1st.
The system reports that shortfall rather than guessing a linkage or sending
after the allowed day.

Sequence's [API reference](https://api.getsequence.io/platform/) documents a
**$1 minimum** for both direct and rule-produced transfers. Sub-dollar amounts
stay unmoved; they must not be rounded above a target or IRA limit.

The direct email adapter sends to the configured private recipient through
Resend. “Immediate” means an attempt when the coordinator detects the issue,
not continuous real-time observation of the external bank. A durable outbox
distinguishes a pending alert from provider acceptance. See
[activation](activation.md#direct-email-alerts) for setup and delivery limits.
