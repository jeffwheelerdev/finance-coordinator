# Configuration

Use private deployment environment variables for real mappings and execution
settings. Bills obligations and monitoring metadata live in private Global Config.
The repository's [example file](../.env.example) contains synthetic UUIDs and
illustrative amounts. Production credentials must be scoped to Production;
previews should remain unconfigured or use completely isolated credentials and
storage.

## Required settings

| Variable | Format and behavior |
| --- | --- |
| `APP_MODE` | Required: exactly `observe` or `live`. |
| `LIVE_TRANSFERS_ENABLED` | Exactly `true` or `false`; defaults to `false`. A submission requires this to be `true` **and** `APP_MODE=live`. |
| `AUTOMATION_START_AT` | Timezone-qualified ISO timestamp. Optional in observation; required for live mode. Choose a deliberate future UTC cutoff for initial activation, then retain it permanently. |
| `GENERAL_SPENDING_MONTHLY_BUDGET` | Required nonnegative dollar string, with at most two decimals. No built-in budget default. |
| `GENERAL_SPENDING_RESERVE_MONTHS` | Required positive integer. Multiplies the monthly budget to obtain the balance target. |
| `GLOBAL_CONFIG` | Private Global Config connection string with read access to `bills_catalog` and `bills_monitor`. Required for current Bills policy; never put it in a URL shared with a user or in source control. |
| `INCOME_RESERVE` | Required nonnegative dollar string. Set an explicit value, including `0` when intended. |
| `MAX_BALANCE_AGE_HOURS` | Positive number at most `26`; defaults to `26`. Must resolve to whole milliseconds. |
| `FINANCE_ACCOUNT_IDS_JSON` | JSON object with exactly `income`, `pod`, `general`, and `bills`; four distinct provider UUIDs. |
| `FINANCE_RULE_IDS_JSON` | JSON object with exactly `payout`, `funding`, and `legacyGeneral`; three distinct provider UUIDs. |
| `FINANCE_CANONICAL_HOST` | Stable production hostname, without scheme or path, such as `your-project.vercel.app`. Required for production reconciliation and webhook processing. |
| `SEQUENCE_API_KEY` | Existing private Sequence key, with the read access and transfer permissions described in [activation](activation.md). |
| `BLOB_READ_WRITE_TOKEN` | Token for the single private production ledger store. |
| `CRON_SECRET` | Private random bearer secret of at least 16 characters, used by the cron and administrator endpoints. |

`SEQUENCE_WEBHOOK_SECRET` is optional. Set it only to the signing secret issued
for the actual registered endpoint. Its presence alone does not establish that
webhook delivery is configured or can reach the deployment.

Money is parsed into exact integer cents. Signs, exponents, whitespace,
non-numeric values, and more than two decimal places are rejected. Amounts,
products, and reserve calculations must fit JavaScript's safe integer range.
Zero is permitted for a budget or reserve; reserve months must remain positive.

## Dynamic Bills target

Version 0.4.0 always includes Bills at priority zero. It calculates the Bills
target from the private catalog on each invocation; no environment amount sets
that target. The old `BILLS_BUFFER_TARGET` variable is obsolete and ignored,
including on deployments where its old value still exists. Remove it when
updating deployment settings to avoid confusion.

Global Config must supply these two items together:

| Item | Role |
| --- | --- |
| `bills_catalog` | Validated obligations, stable bill IDs, positive cent amounts, recurrence, dated evidence and confirmed cancellation details. |
| `bills_monitor` | A successful `chatgpt_finances` review with a matching catalog revision and a check time no older than seven days. |

The application uses an origin-consistent `getAll` read with caching and stale
fallback disabled. Missing, malformed, mismatched, unavailable or stale data
blocks new financial submissions. It does not fall back to a fixed target, an
old environment value or a cached catalog. A known accepted transfer can still
be observed by its saved provider ID; that exception cannot submit or retry an
unknown request.

The forecast uses current catalog rates for all twelve months of the current
`America/New_York` year, then computes
`ceil(highestMonthCents / 50000) × 50000`. An exact $500 boundary stays unchanged.
Annual bills occupy their renewal months; an unknown annual date is placed
conservatively into the highest month. Confirmed future cancellations remain
included until their local effective date. Uncertain obligations remain
included with warnings. An empty or fully excluded catalog requires review
instead of creating a zero target.

Catalog updates need no redeployment. The runtime carries the catalog revision,
hash, forecast year and effective local date into policy and ledger metadata.
It rejects older catalog versions and older projection dates. A cancellation
may legitimately change the forecast on a later effective date without a
catalog rewrite. See [Bills monitoring](bills-monitor.md) for the complete
catalog, monitor and update contract.

The fixed private Blob object `finance-v3/ledger.json` remains separate from
Global Config. The latter is not an execution lease or a substitute for
conditional ledger writes.

## Change a budget

For example, these synthetic values produce a target of $3,703.68:

```dotenv
GENERAL_SPENDING_MONTHLY_BUDGET=1234.56
GENERAL_SPENDING_RESERVE_MONTHS=3
```

Edit the private values for the production environment, then create and verify
a new deployment using the same production host and ledger. Vercel applies
environment changes to new deployments, so an environment edit alone does not
change a running deployment. See [Vercel environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables).

The next eligible allocation that has not submitted a request uses the updated
target. Completed events are never replayed. A lower target causes no reverse
transfer. An existing uncertain request retains its exact body and key; a new
budget cannot silently rewrite it, and a smaller safe amount may require
review. A zero budget creates no dollar gap while keeping the recipient's
identity intact.

Do not change `AUTOMATION_START_AT`, account/rule bindings, or the ledger
location as part of a budget edit. The protected status endpoint exposes the
effective budget and configuration hash without revealing account UUIDs.

## Additional accounts

`FINANCE_ALLOCATIONS_JSON` is optional and defaults to `[]`. It accepts up to
nine additional recipients, for eleven total including Bills and General Spending. This is
an illustrative entry, not a real account mapping:

```json
[
  {
    "id": "travel",
    "destinationAccountId": "88888888-8888-4888-8888-888888888888",
    "monthlyBudget": "250.00",
    "reserveMonths": 2,
    "priority": 1,
    "enabled": true,
    "startsAt": "2099-01-01T00:00:00Z"
  }
]
```

Replace the illustrative date with the intended future start, or omit
`startsAt` to use the recipient's prospective registration time. This field
can also be `null`. The `enabled` field is optional and defaults to `true`;
all other displayed fields except `startsAt` are required. Unknown fields are
rejected.

Use a stable lowercase ID beginning with a letter and containing only letters,
digits, underscores, or hyphens. IDs and destinations must be unique, including
disabled entries. A destination cannot be Income, the Pod, Bills, or another
recipient. Additional configured priorities are integers of at least one.
For compatibility with existing configuration, the runtime adds one to each
additional priority: configured `1` becomes effective priority `2`. Bills is
permanently priority `0` and General Spending is priority `1`. Equal optional
priorities sort by stable ID. Optional recipients cannot replace or disable
the mandatory Bills allocation.

After the first live registration, a stable ID cannot be redirected to a
different account. New or re-enabled recipients become eligible no earlier
than registration and their configured start; they do not receive historical
refund backlog. Changing `startsAt` cannot move eligibility before the ledger's
recorded floor. Recipients already captured by a claimed event do not gain new
siblings through a later configuration edit.

An additional account also needs an explicit permitted Income→destination pair
on the existing Sequence key. Configuration alone does not grant that access.
All recipients share the Income reserve and Bills protection. Funding an
optional recipient also requires Bills to have completed its priority step for
that refund; a partial or unfunded Bills deficit skips lower recipients for
that cycle.
