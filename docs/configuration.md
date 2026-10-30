# Configuration — v0.6

Real account bindings, recipients, credentials, and financial policy belong in
private production settings. The [example file](../.env.example) uses synthetic
UUIDs and keeps live transfers disabled. Production secrets must not be
available to previews.

## Execution and account variables

| Variable | Contract |
| --- | --- |
| `APP_MODE` | Exactly `observe` or `live`. |
| `LIVE_TRANSFERS_ENABLED` | Exactly `true` or `false`; defaults to `false`. Financial submission also requires `APP_MODE=live`. |
| `MONTHLY_PRIORITY_ENABLED` | Exactly `true` or `false`; defaults to `false` for legacy compatibility. Set `true` for the current monthly policy. This is not an activation flag. |
| `AUTOMATION_START_AT` | Prospective timezone-qualified ISO cutoff; required in live mode. Preserve the recorded value after activation. |
| `FINANCE_ACCOUNT_IDS_JSON` | Exactly the four legacy keys `income`, `pod`, `general`, `bills`, with distinct provider UUIDs. The Pod mapping remains for identity/migration checks and is excluded from monthly routing. |
| `FINANCE_RULE_IDS_JSON` | Exactly `payout`, `funding`, `legacyGeneral`, with distinct UUIDs. All must be disabled in monthly mode. |
| `EMERGENCY_ACCOUNT_ID` | Exact Emergency cash-account UUID; required in monthly mode. Adds the internal `accounts.emergency` role. |
| `PROJECT_ACCOUNT_ID` | Exact Project cash-account UUID; required in monthly mode. |
| `PERSONAL_INVESTMENT_ACCOUNT_ID` | Exact Personal Investment destination UUID; required in monthly mode. Must be an investment account capable of receiving funds. |
| `EMERGENCY_EXCESS_RULE_ID` | Exact fourth legacy excess-return rule UUID; required in monthly mode and must also be disabled. Adds the internal `rules.excess` role. |
| `ROTH_ENABLED` | Configures Roth. Monthly priority mode requires `true`; it does not establish annual personal eligibility. |
| `ROTH_ACCOUNT_ID` | Exact privately attested Roth investment destination UUID. |
| `GENERAL_SPENDING_MONTHLY_BUDGET` | Arbitrary nonnegative dollar string, at most two decimal places. |
| `GENERAL_SPENDING_RESERVE_MONTHS` | Positive integer; the General target is budget multiplied by months. |
| `EMERGENCY_FUND_TARGET` | Dollar target; defaults to `10000`. |
| `INCOME_RESERVE` | Explicit nonnegative dollar reserve, including `0` when intended. Deducted once from the regular pool. |
| `MAX_BALANCE_AGE_HOURS` | Positive value no greater than `26`, expressible in whole milliseconds; defaults to `26`. |
| `FINANCE_ALLOCATIONS_JSON` | Keep `[]` for the current fixed monthly order. Legacy extra recipients are rejected in monthly mode. |

Every monthly role, including the excluded Pod, must have a distinct account
identity. Rule identities must also be distinct. Monthly mode currently fixes
7.5% Emergency, 5% Project, the 15:00 UTC first-day window, and December as the
annual windfall-close month. These are reviewed policy choices, not undocumented
environment variables.

Money is represented internally as exact integer cents. Invalid numeric
formats, fractional cents, and unsafe arithmetic are rejected.

## Connections and alerts

| Variable | Purpose |
| --- | --- |
| `FINANCE_CANONICAL_HOST` | Stable production hostname without scheme or path. Reconciliation and webhook writes reject a different deployment host. |
| `SEQUENCE_API_KEY` | Private scoped key for the required account/history reads and exact authorized transfer pairs. |
| `BLOB_READ_WRITE_TOKEN` | Access to the one private execution ledger. |
| `GLOBAL_CONFIG` | Private read connection for `bills_catalog`, `bills_monitor`, `roth_policy`, and `monthly_policy`. |
| `CRON_SECRET` | Private bearer secret, at least 16 characters, for cron/admin routes. |
| `SEQUENCE_WEBHOOK_SECRET` | Optional signing secret issued for the actual registered webhook endpoint. Presence is not proof of registration or delivery. |
| `RESEND_API_KEY` | Private email-provider credential. Required before monthly financial activation. |
| `ALERTS_EMAIL_TO` | One resolved private alert recipient. Never commit the production address. |
| `ALERTS_EMAIL_FROM` | A provider-permitted sender address, optionally with the supported display-name format. |

The email integration is not connected merely because recipient settings exist.
A valid provider key, sender permission, and separately authorized delivery
verification are still needed. Resend's `onboarding@resend.dev` sender is
restricted to the email associated with that Resend account; other recipients
require an appropriate verified domain. See the
[provider restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

## Private policy records

| Global Config key | Responsibility |
| --- | --- |
| `bills_catalog` | Recorded active bills, amounts, recurrences, renewals, and dated evidence. |
| `bills_monitor` | A successful matching Finances review no older than seven days. |
| `roth_policy` | Strict statutory/personal tax-year policy plus current-year contribution-route evidence. |
| `monthly_policy` | Verified opening Income partition and reviewed receipt classifications. |

Reads use origin consistency and no stale-on-error fallback. Private policy
does not replace the conditional Blob ledger or its execution lease. The
ledger remains at the established private location; do not change it to bypass
an error or reset financial history.

The Bills target remains
`ceil(highestProjectedMonthCents / 50000) × 50000`. Annual obligations stay in
their renewal month. The obsolete `BILLS_BUFFER_TARGET` variable is ignored.
See [Bills monitoring](bills-monitor.md).

The `roth_policy` envelope retains `schemaVersion`, `policy`, and `evidence`.
The v0.6 monthly branch uses its current-year route attestation and statutory/
personal records. The old upstream native-funding pin is retained for legacy
compatibility and is not an instruction to enable a rule. See
[Roth policy](roth-policy.md) and [limit monitoring](roth-monitor.md).

A deliberately inactive monthly-policy seed is:

```json
{
  "schemaVersion": 1,
  "id": "monthly-priority",
  "updatedAt": "2030-01-01T00:00:00.000Z",
  "opening": { "status": "unverified" },
  "classification": { "rules": [], "overrides": [] }
}
```

The timestamp is synthetic and must be replaced with the actual revision time.
A verified opening record contains `asOf`, `incomeBalanceCents`,
`regularCents`, `windfallCents`, `unknownCents`, and a private evidence
`reference`; the three pools must sum to the bank balance. For the opening
snapshot, `unknownCents` must be zero: classify its entire existing balance
before fixing that immutable baseline. Later unclassified receipts can be held
and resolved with exact transaction overrides.

Classification rules use reviewed exact description/merchant criteria and
amount bounds. Exact transaction overrides can partition a receipt between
regular and windfall cents. Keep classification evidence private. Do not seed
a broad DFAS/payroll rule from the merchant name or inferred pay cadence.
A `navy-pay` rule additionally requires `excludesBonuses: true`, backed by
reviewed evidence that the signature distinguishes ordinary pay. A generic
DFAS description shared with bonuses does not establish that fact; use a
transaction-specific, documented split when the bank metadata is ambiguous.
Unclassified receipts are held. The opening record defaults to unverified
rather than assuming the entire bank balance is regular cash.

## Change a budget or extend the design

For example:

```dotenv
GENERAL_SPENDING_MONTHLY_BUDGET=1234.56
GENERAL_SPENDING_RESERVE_MONTHS=3
```

This produces a $3,703.68 target. Apply a private environment edit through a new
verified deployment. Vercel environment changes apply to new deployments;
see [Vercel environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables).

A future eligible cycle uses its validated policy. An already stored cycle
retains its frozen plan, percentage basis, and request identities. Changing a
budget does not generate another monthly opportunity or withdraw a lower
destination target automatically.

The earlier `FINANCE_ALLOCATIONS_JSON` extension mechanism belongs to the legacy
refund branch. Adding a recipient to v0.6 needs a reviewed monthly priority,
account role, funding formula, reservation rule, and exact allowed transfer
pair. It cannot be achieved by assigning an arbitrary legacy rank.

Do not alter the activation cutoff, account bindings, policy identity, or
ledger location during a routine budget change. Those changes require a
reviewed migration that preserves accepted and uncertain requests.
