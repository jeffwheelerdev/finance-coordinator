# Private finance dashboard

The dashboard presents the coordinator's saved financial plan, observed balances, transfer progress, settings and diagnostics. The money map describes the direct transfers the coordinator manages. It does not create Sequence rules or turn on financial execution.

The current execution settings and the settings saved with an existing plan are separate facts. Editing a budget or execution date creates a future settings revision. It does not rewrite a submitted request, reset contribution history, or move a completed monthly cycle to another date.

## Reading the money map

There are seven real account roles. Windfall and unclassified money are accounting pools inside Income, not additional accounts.

| Account | Meaning in the monthly process |
| --- | --- |
| Income | Holds regular cash, protected windfall cash and receipts awaiting classification. |
| Bills & subscriptions | Receives the amount needed to reach the forecast's rounded spending cap. |
| General spending | Receives the amount needed to reach the configured monthly budget multiplied by the reserve months. |
| Emergency fund | Receives the configured percentage of the cycle's opening regular pool, limited by its remaining cap and available regular cash. Posted balance plus incoming commitments count toward the cap. |
| Roth IRA | Receives its eligible installment and eligible same-year shortfall, subject to the separate annual contribution safeguards. |
| Project savings | Receives its configured percentage of the same opening regular pool when the higher priorities permit it. |
| Personal investment | Receives the remaining eligible surplus after the preceding priorities. |

The six allocation arrows all start at Income. Priority numbers express reservation and submission order; money does not travel through Bills to General and then through the other accounts. A separate Emergency → Income arrow represents a return of verified Emergency excess. That returned money is not assumed available before it posts and is reconciled.

The regular and windfall portions of each allocation are shown separately. The annual windfall opportunity is the December cycle. Same-year Roth shortfalls come first, then eligible Project shortfalls, then Personal investment. A prior-year windfall awaiting review is shown separately from this year's eligible windfall. A late receipt is not silently assigned to an already frozen December plan.

## Balances, targets and commitments

The dashboard preserves the distinction between these values:

- **Posted balance:** the provider's current account balance at its own update time.
- **Available balance:** the provider's separately reported available balance.
- **Coordinator spendable cash:** the conservative amount remaining after known pending commitments and evidence checks.
- **Incoming commitments:** transfers still in progress; they can count toward a destination's target but are not available source cash.
- **Target:** the desired cash cap or contribution obligation, not the amount already transferred.
- **Planned:** the amount allocated by a saved plan or an explicitly labelled hypothetical scenario.
- **Committed:** an immutable request exists, including a request whose provider outcome requires reconciliation.
- **Submitted:** the ledger has a validated accepted provider transfer in a pending or complete state.
- **Settled:** the coordinator has validated the provider's completion evidence.

Investment account balances are currently absent from the monthly evidence model. Their cards therefore show an unavailable balance instead of zero. Contribution progress is still available from the coordinator's ledger. An investment account value would not establish annual Roth contribution room.

Bank and Sequence pending records can describe overlapping cash restrictions without a trustworthy cross-feed identifier. The conservative cash calculation can reserve those restrictions more than once. The dashboard reports their components separately and marks that they may overlap; it does not describe their sum as distinct new spending.

An unavailable source or unverified opening partition produces an unavailable income pool, not a zero-dollar pool. Existing frozen plans and recorded transfer progress remain readable when a bill monitor or provider is unavailable. A failure to read the ledger itself is also shown as unavailable rather than an empty transfer history.

## Transfer and cycle states

| Dashboard state | Recorded meaning |
| --- | --- |
| Planned | A saved allocation exists; no accepted transfer is claimed. |
| Submission unknown | A request may have reached the provider and must be reconciled using its existing identity. |
| Approval required | The provider reports an approval-pending transfer. |
| Pending | A validated accepted transfer has not completed. |
| Complete | Completion evidence was validated. |
| Failed | The provider reported a failure, denial or cancellation, or definitively rejected the request. |
| Review required | Evidence or identity is unresolved; failure or completion is not assumed. |
| Not needed | No transfer was submitted for the line, including a line below the provider minimum. |
| Skipped | The opportunity was missed or the saved line was otherwise closed without submission. |

A cycle marked `COMPLETE` can contain both completed transfers and skipped or no-op allocations. The dashboard includes skipped counts and settled amounts so a closed cycle does not imply every planned dollar moved. Similarly, the planner's `FUNDED` reason means the arithmetic fully allocated a target; it does not mean a bank transfer completed.

The cycle's total planned and settled amounts describe its six Income allocations. Emergency excess returns are reported separately so they do not inflate progress against the outbound plan.

## Settings and dates

The editable control fields are:

| Field | Stored unit |
| --- | --- |
| `generalMonthlyBudgetCents` | Integer cents |
| `generalReserveMonths` | Whole months |
| `incomeReserveCents` | Integer cents |
| `emergencyTargetCents` | Integer cents |
| `emergencyRateBasisPoints` | Integer basis points; 750 means 7.5% |
| `projectRateBasisPoints` | Integer basis points; 500 means 5% |
| `executionDay` | Day 1–28 of the monthly cycle |
| `decemberDay` | Day 1–15 for the December cycle |

The initial schedule remains the first day at 15:00 UTC. That is 10:00 a.m. or 11:00 a.m. in New York, depending on daylight saving time. The displayed next opportunity comes from the same calendar helper as the executor. Its closing time is local midnight at the end of the selected execution day. Settlement observation can continue after that window closes.

December retains a separate early date because requesting an ACH transfer late in December does not guarantee a December settlement or contribution year. Even an early December date does not itself prove settlement; the contribution reconciliation safeguards remain in force.

Current settings, pending settings and the settings revision frozen with a cycle are shown separately. An authenticated edit is saved with an expected revision, so a stale browser cannot silently overwrite a newer edit. Account mappings, provider authority, verified personal financial facts and the live execution gates are outside this settings form.

## What-if calculator

`simulateDashboardPlan` calls the actual pure priority planner with explicitly hypothetical cash inputs. It does not call Sequence, reconcile the financial ledger, submit a transfer, send email or change settings.

The request is an object with these required fields:

```json
{
  "monthKey": "2030-06",
  "regularIncomeCents": 500000,
  "windfallCents": 400000,
  "billsBalanceCents": 0,
  "generalBalanceCents": 0,
  "emergencyBalanceCents": 900000
}
```

These are synthetic example values, not current account balances. The only optional cash fields are `rothRemainingCents`, `rothCarryCents` and `projectCarryCents`. Every amount must be a nonnegative safe integer number of cents. Additional fields, routing overrides, live flags and fractional cents are rejected.

The facade resolves effective settings for the requested month, the bill forecast from the current known catalog, and the applicable year's known Roth installment. An unknown future Roth limit stays unknown and blocks the corresponding hypothetical lower-priority allocations; today's installment is not copied into an unsupported future year.

The result is labelled `synthetic_estimate`. Its assumptions are part of the response:

- Entered cash is hypothetical, pending transfers are excluded and settlement is not predicted.
- Roth eligibility is hypothetical. If remaining annual room is omitted, the scenario assumes room only for its current and entered carried target; this is not a verification of personal contribution room.
- Earlier shortfalls are zero unless entered. Entered carry is assigned only within the same year, and January rejects previous-year carry.
- Current known bill schedules and year-specific limits are used; future changes are not predicted.
- Windfall cash is assumed to belong to the scenario's current year. Unclassified receipts are not converted to regular income.
- An estimated Emergency excess return is displayed separately and is not added to the scenario's spendable Income cash.

Amounts below Sequence's one-dollar transfer minimum can occur in the mathematical estimate. The result marks them rather than implying the provider will send them. See the [official transfer documentation](https://api.getsequence.io/platform/).

## Activity, diagnostics and test results

Activity is a projection of recorded monthly cycles and allocation requests across the ledger. It is labelled **recorded milestones** and is separate from the coordinator run journal.

The run journal retains up to 100 coordinator results committed with the existing ledger lease. Each entry shows the time, mode, result, month, newly confirmed provider acceptances and newly confirmed settlements. These counts describe confirmations during that run, not transfer attempts or lifetime totals: an uncertain submission has zero confirmed acceptances until later reconciliation verifies it. Busy invocations and checks rejected before acquiring and saving the lease are not recorded. Older deployments did not maintain this journal, so an empty journal does not prove that the coordinator has never run. Reaching the 100-entry retention bound is labelled explicitly; the dashboard does not invent a count of discarded entries.

Activity pages default to 25 entries, with a maximum of 100. A cursor is tied to its redacted snapshot; if the underlying records change, the API requires a fresh page rather than silently skipping or repeating changed rows. The main overview includes the first 12 entries.

The debug download is a bounded JSON projection: at most 256 KiB, 100 activity entries, 50 run entries and 50 alert entries. It explicitly reports truncation and whether the run journal has reached its retention bound. Provider account and transfer identifiers, idempotency keys, credentials, raw provider responses, payer descriptions, private evidence references and session/CSRF values are omitted. It can still contain financial amounts and status information appropriate to a private owner download.

Test evidence has three separate sections:

- **Offline rehearsal:** deterministic scenarios using the actual engine and in-memory providers. Its receipt reports software version, scenario count and a result hash. It proves those scenarios, not live bank authority or email delivery.
- **Provider simulation:** separately authorized synthetic requests to Sequence, always in simulation mode. Its receipt states tested amounts and times. Provider simulation bypasses human approval and does not prove unattended approval settings, real balances, banking settlement or inbox delivery.
- **Scheduler delivery:** one expiring health-only queue probe in observation mode. A queued acknowledgement is separate from a completed callback receipt. Completion proves a private queue callback reached the protected canonical health endpoint with runtime OIDC and saved the matching receipt. It sends no money or email. Proof from another software version or deployment is shown as unverified. See [the scheduler design and its limits](scheduler.md).

No receipt means `not_run`; it is not converted into a passing badge. A build's output log is not automatically a durable runtime receipt. An on-demand offline rehearsal must run in isolation or use an actual recorded build receipt: the existing rehearsal script temporarily replaces `globalThis.fetch` to prove the no-network property and must not interfere with another request's provider calls.

Alert state `DELIVERED` in the financial ledger means the email provider accepted the message. The dashboard labels this **provider accepted** and leaves individual inbox receipt unverified. Verified setup delivery is a separate activation proof bound to the configured sender and recipient.

## Backend projection contract

`lib/dashboard-view.mjs` exports four pure functions:

```js
buildDashboardView({
  config, state, settings, readiness, evidence, incomePools,
  billsPolicy, rothSummary, sectionErrors, tests, now
});

dashboardActivity({ state, cursor, limit });
dashboardDebug({ snapshot, state, now });

simulateDashboardPlan({
  config, settings, billsTargetCents, rothMonthlyCents, input, now
});
```

The overview returns `schemaVersion`, `asOf`, `currency`, `system`, `schedule`, `settings`, `readiness`, `accounts`, `income`, `cycle`, `flows`, `annual`, `bills`, `activity`, `runs`, `alerts`, `tests` and `sections`. The `runs` model includes `status`, newest-first `items`, `storedCount`, `limit`, `coverage`, `retentionReached`, `hasMore` and a safe `code`. Each item contains only `at`, `mode`, `status`, `code`, `monthKey`, `submittedCount` and `settledCount`.

All monetary values are integer cents or `null`. Timestamps are explicit UTC instants; account `balanceAsOf` preserves the bank's timestamp. `asOf` is the projection time, not a substituted balance-update time. Role names are stable application labels, not provider identifiers.

The account roles are `income`, `bills`, `general`, `emergency`, `roth`, `project` and `personalInvestment`. Allocation IDs retain the engine names: `bills`, `general-spending`, `emergency-fund`, `roth-ira`, `project-savings`, `personal-investment` and optional `emergency-excess`.

The authenticated application facade supplies the private source reads and settings persistence. The projection layer has no financial execution route, arbitrary proxy, environment access or writable store dependency. Browser access must not expose the coordinator's cron bearer secret or provider API key.
