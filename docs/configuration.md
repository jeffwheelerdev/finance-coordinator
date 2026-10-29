# Configuration

Use private deployment environment variables for all real mappings and policy.
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
| `BILLS_BUFFER_TARGET` | Required nonnegative dollar string. Any shortfall in Bills is protected in Income. |
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
nine additional recipients, for ten total including General Spending. This is
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
recipient. Additional priorities are integers of at least one; General
Spending is permanently priority zero. Equal priorities sort by stable ID.

After the first live registration, a stable ID cannot be redirected to a
different account. New or re-enabled recipients become eligible no earlier
than registration and their configured start; they do not receive historical
refund backlog. Changing `startsAt` cannot move eligibility before the ledger's
recorded floor. Recipients already captured by a claimed event do not gain new
siblings through a later configuration edit.

An additional account also needs an explicit permitted Income→destination pair
on the existing Sequence key. Configuration alone does not grant that access.
All recipients share the Income reserve and Bills protection.
