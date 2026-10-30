# Finance Coordinator

Version **0.6.1** prepares the monthly Sequence coordinator for deliberate
activation, with a separate readiness report and an offline engine rehearsal.
The v0.6 allocation policy is unchanged: it funds accounts directly from Income,
records the cash reserved for each request, and keeps windfalls separate from
ordinary monthly income.

The new branch is selected with `MONTHLY_PRIORITY_ENABLED=true`. The example
configuration remains financially inactive: `APP_MODE=observe` and
`LIVE_TRANSFERS_ENABLED=false`. Implemented source, a successful deployment,
and read-only account access do not establish permission to transfer money or
proof that money has moved. See [activation](docs/activation.md).

## Monthly order

All new requests belong to the **1st of the month**, beginning at **15:00 UTC**.
The calendar is `America/New_York`: 10 a.m. during standard time and 11 a.m.
during daylight time. The daily cron also checks evidence and follows accepted
transfers; it does not authorize a second allocation date.

| Priority | Destination | Amount |
| --- | --- | --- |
| 1 | Bills and Subscriptions | Fill the gap to the highest forecast monthly bill total for the year, rounded up to the nearest $500. |
| 2 | General Spending | Fill the gap to the configurable monthly budget multiplied by the configurable reserve-month count. |
| 3 | Emergency Fund | 7.5% of the cycle's opening regular-income pool, capped by the remaining $10,000 target gap and cash left after higher priorities. |
| 4 | Roth IRA | This month's eligible installment plus unpaid eligible same-year monthly obligations, capped by annual room and remaining regular cash. |
| 5 | Project Savings | This month's 5% of the same opening regular-income pool, capped by remaining cash. |
| 6 | Personal Investment | Eligible regular surplus remaining after the earlier allocations and the explicit Income reserve. |

The two percentage targets use one frozen opening amount. They are not
recalculated from a shrinking balance between transfers. General Spending
accepts any valid dollar budget; changing `750` to `850`, or another amount,
does not require a new formula.

The Emergency target gap subtracts both its current posted balance and pending
incoming transfers. A hold that lowers available cash does not create additional
room under the Emergency cap.

The routing Pod and its refund event are not part of this branch. All four
mapped legacy Sequence rules are archived, manual-only, and disabled. They
preserve historical actions; they do not manage the current monthly logic and
must stay disabled. An Emergency balance above its target can produce a
separately recorded Emergency→Income excess return; that incoming transfer is
not spendable before settlement and reconciliation.

## Regular income and windfalls

A verified private opening record classifies the entire existing Income
balance as regular or windfall, with zero unclassified cents. Subsequent bank receipts require reviewed exact
classification records or narrowly defined reviewed rules. Unknown or ambiguous
receipts remain held. A DFAS or Navy-pay label alone does not prove a deposit
contains no bonus.

For example, a synthetic Income balance of $9,000 containing $5,000 regular
income and a $4,000 windfall uses **$5,000** as the percentage basis. The
Emergency target is $375 and the Project target is $250 before their cash and
priority limits. The $4,000 remains in Income as a separate ledger bucket.

Current-year windfalls remain held until the **December 1** cycle. They can
then fill verified same-year Roth shortfalls, followed by recorded Project
shortfalls, with the remaining eligible windfall going to Personal Investment.
They do not supplement ordinary Bills or General funding. Late receipts and
unresolved prior-year windfalls require review; January does not silently
relabel them as a new year's cash.

See [monthly priority policy](docs/monthly-priority.md) for calculations,
carryforward, annual close, classification, and timing.

## Partial Roth funding and alerts

An eligible Roth installment may be partially funded when regular cash is
short. Its unpaid amount remains a dated obligation for a later 1st in the
same tax year, subject to verified annual limits. Project and Personal
Investment cannot consume cash ahead of an unpaid or unverified Roth
obligation. Project's ordinary monthly allocation remains its new 5% target;
older Project shortfalls are addressed by the annual windfall process.

The direct email adapter uses Resend and a durable alert outbox. It attempts to
send actionable shortfall and exception alerts when the coordinator detects
them. Provider acceptance is not proof of inbox delivery. Activation requires
working provider configuration and private evidence of both acceptance and
recipient-confirmed receipt for the configured sender and recipient. Offline
tests establish neither real email delivery nor a financial transfer.

## Evidence and execution

The coordinator verifies account roles, bank snapshot age, complete provider
history, pending commitments, and posted bank activity. It preserves an
immutable request and idempotency key before each money-moving call. Known
accepted transfers can settle concurrently; unknown submission outcomes stop
further submissions. Allocation priority does not guarantee ACH arrival order.

External bank snapshots and ACH settlement can delay execution. Sequence
documents roughly daily external balance refreshes and asynchronous transfers.
Removing the visible Pod does not remove the provider's internal routing.
See [Sequence balances](https://intercom.help/sequence/en/articles/12856934-intro-to-external-accounts)
and [external-to-external transfers](https://support.getsequence.io/hc/en-us/articles/48175534864531-Can-I-transfer-from-one-external-account-to-another).

## Activation readiness

The authenticated `GET /api/readiness` report distinguishes unfinished
prerequisites from the final activation changes. `readyForActivation=true` can
coexist with `executionEnabled=false`; that is the intended prepared state.
`blockers` identify missing evidence, while `activationChanges` lists the live
gates and prospective cutoff still to apply after authorization.

The private `activation_policy` records the existing Sequence key's reviewed
unattended transfer authority, exact account pairs and amount limits, plus real
email acceptance and recipient receipt. It defaults to unverified. No replacement
Sequence key is requested. Syntactically valid settings or a successful read do
not establish these operational facts.

An initial production build with the live-transfer gate enabled must pass this
readiness gate. Established activation is kept distinct so known transfers can
remain observable and an ordinary code repair need not masquerade as a new
activation. Existing evidence, execution safeguards, and build checks still
apply.

“Activate automation” can be the final instruction once the prerequisites are
complete and freshly checked. Until missing financial facts, email receipt,
and provider approval controls are resolved, one-phrase activation is not
established. See the [activation runbook](docs/activation.md#4-activate-prospectively-when-authorized).

## Documentation and validation

| Location | Purpose |
| --- | --- |
| [Monthly policy](docs/monthly-priority.md) | Priority calculations, regular/windfall separation, shortfalls, and annual close. |
| [Configuration](docs/configuration.md) | Private variables, policy records, and account bindings. |
| [Architecture](docs/architecture.md) | Evidence, durable reservations, retries, and operational limits. |
| [Activation](docs/activation.md) | Staged checks, email readiness, deliberate activation, and recovery. |
| [Rehearsal receipt](docs/monthly-rehearsal.json) | Deterministic synthetic scenarios and their results; no live financial data. |
| [Bills monitor](docs/bills-monitor.md) | Private catalog evidence and automatic forecast updates. |
| [Roth policy](docs/roth-policy.md) | Personal tax-year ceilings, contribution history, and route evidence. |
| [Roth limit monitor](docs/roth-monitor.md) | Official IRS publication checks and annual policy updates. |

Use Node.js 22 or 24 and Python 3.12 for the historical suites:

```bash
npm ci --ignore-scripts
npm test
npm run simulate
python3 scripts/test_archives.py
```

These tests use synthetic evidence and mocked providers. They need no financial
credentials and make no real transfers or send real emails.

`npm run simulate` runs `scripts/rehearse-monthly.mjs` against the actual monthly
engine with in-memory providers, storage, and alerts. It emits a deterministic
JSON receipt for annual carryforward, December windfalls, shortages, retries,
timing, and year transitions. Network access is forbidden in the runner. This
rehearsal is separate from Sequence's native-rule simulation and from production
read-only readiness checks.

The separately authorized provider check is `npm run simulate:sequence`. It uses
the existing runtime Sequence key and requires all three exact settings:
`RUN_SEQUENCE_SIMULATION=true`, `APP_MODE=observe`, and
`LIVE_TRANSFERS_ENABLED=false`. The default offline rehearsal never enables this
check. An inactive production build may run it once under the explicit flag;
reset that flag to `false` or remove it afterward.

The provider runner sends at most seven synthetic probes through a separate
adapter. Every POST hardcodes `simulation:true` and a synthetic source balance.
It checks the six Income destinations and Emergency→Income, stops on the first
failure, and never retries or writes the application ledger. Sequence records
the simulations, but no live transfer is requested. Results show safe route
labels and tested amounts, excluding credentials and provider identifiers.

Successful provider simulations establish acceptance of the configured pairs
at those test amounts. They do not establish unlimited authority, real available
cash, personal IRA eligibility, ACH settlement, email receipt, or unattended
approval: Sequence bypasses human approval during simulations. Operational
readiness remains a separate requirement.

## History and privacy

The v0.3–v0.5 refund coordinator remains in source for reviewed legacy operation;
it is not the execution path when monthly priority mode is enabled. It must not
run alongside the new monthly coordinator. Existing financial history requires
a reviewed migration, not a ledger reset.

The [historical Python implementations](archive/) and
[incomplete 0.2.1 export](snapshots/deployment-0.2.1/) remain unchanged historical
artifacts. The five missing original files were not reconstructed; see
[recovery provenance](docs/recovery.md).

This public repository contains synthetic examples. Production account and rule
IDs, email recipients, credentials, financial classifications, and the execution
ledger belong in private configuration and storage.
