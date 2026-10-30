# Configuration — v0.6.2

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
| `RUN_SEQUENCE_SIMULATION` | Optional explicit provider-test flag. Only `true` enables the separate runner, and only with `APP_MODE=observe` and `LIVE_TRANSFERS_ENABLED=false`. Leave absent/`false` normally; remove or reset after the authorized inactive build. It cannot enable real transfers. |
| `AUTOMATION_START_AT` | Prospective timezone-qualified ISO cutoff; required in live mode. Preserve the recorded value after activation. |
| `FINANCE_ACCOUNT_IDS_JSON` | `income`, `general`, `bills`, and normally the legacy `pod`, with distinct UUIDs. In explicit monthly retirement mode, the manifest retains the Pod identity and the operational JSON may omit `pod`. |
| `FINANCE_RULE_IDS_JSON` | Normally exactly `payout`, `funding`, `legacyGeneral`, with distinct UUIDs. In monthly retirement mode the manifest supplies retired identities; supplied legacy mappings must match. Remaining old rules must stay disabled. |
| `MONTHLY_SEQUENCE_RETIREMENT_JSON` | Optional monthly-only authorization manifest with exact historical Pod/rule IDs, timestamp, and reference. Enables complete visible-rule inventory checks and retirement-compatible evidence. It does not delete provider resources or activate transfers. See [Sequence integration](sequence-integration.md). |
| `EMERGENCY_ACCOUNT_ID` | Exact Emergency cash-account UUID; required in monthly mode. Adds the internal `accounts.emergency` role. |
| `PROJECT_ACCOUNT_ID` | Exact Project cash-account UUID; required in monthly mode. |
| `PERSONAL_INVESTMENT_ACCOUNT_ID` | Exact Personal Investment destination UUID; required in monthly mode. Must be an investment account capable of receiving funds. |
| `EMERGENCY_EXCESS_RULE_ID` | Exact fourth legacy excess-return rule UUID; the retirement manifest can supply it. Any supplied value must match. A remaining old rule must stay disabled. |
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
| `SEQUENCE_API_KEY` | Existing private scoped key for the required reads and exact authorized transfer pairs. Preparation does not request a replacement. Unattended approval and limit evidence are recorded separately. |
| `BLOB_READ_WRITE_TOKEN` | Access to the one private execution ledger. |
| `GLOBAL_CONFIG` | Private read connection for `bills_catalog`, `bills_monitor`, `roth_policy`, `monthly_policy`, and `activation_policy`. |
| `CRON_SECRET` | Private bearer secret, at least 16 characters, for cron/admin routes. |
| `SEQUENCE_WEBHOOK_SECRET` | Optional signing secret issued for the actual registered webhook endpoint. Presence is not proof of registration or delivery. |
| `RESEND_API_KEY` | Private email-provider credential. Required before monthly financial activation. |
| `ALERTS_EMAIL_TO` | One resolved private alert recipient. Never commit the production address. |
| `ALERTS_EMAIL_FROM` | A provider-permitted sender address, optionally with the supported display-name format. |

The email integration is not connected merely because recipient settings exist.
A valid provider key, sender permission, and separately authorized delivery
verification are still needed. `configured=true` is a syntax/configuration
check; activation additionally requires provider acceptance and recipient
receipt recorded for the current sender and recipient. Resend's `onboarding@resend.dev` sender is
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
| `activation_policy` | Reviewed existing-key unattended authority and verified email receipt, used for activation readiness. |

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

## Private operational evidence

The `activation_policy` key has exactly `schemaVersion`, `updatedAt`,
`sequenceAuthority`, and `emailDelivery`. Its inactive seed is:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2030-01-01T00:00:00.000Z",
  "sequenceAuthority": { "status": "unverified" },
  "emailDelivery": { "status": "unverified" }
}
```

Replace the synthetic timestamp with the actual revision time. Each unverified
record contains only `status`. Verified records require these exact fields:

| Record | Required fields and meaning |
| --- | --- |
| `sequenceAuthority` | `status:"verified"`, `verifiedAt`, private `reference`, `automaticApproval`, `accountPairs`, `maxAmountCents`. |
| `accountPairs[]` | Exactly `sourceAccountId` and `destinationAccountId`; distinct valid UUIDs for each directional pair. Include Income→Bills, General, Emergency, Roth, Project, Personal Investment, and Emergency→Income. |
| `automaticApproval` | A boolean recording the existing key's reviewed ability to execute without individual human approval. Readiness requires `true`; setting this field does not change provider controls. |
| `readAllRules` | Optional boolean for backward compatibility, but must be verified `true` before initial activation in retirement mode. Records that the existing key can read the whole native-rule inventory; completing pagination alone does not prove unrestricted permission. |
| `maxAmountCents` | An integer of at least 100 for the reviewed common conservative cap, or `null` only when absence of an amount cap has been verified. For differing pair caps, use a bound no greater than any required pair's cap. Do not use `null` for an unknown limit. |
| `emailDelivery` | `status:"verified"`, `verifiedAt`, private `reference`, `provider:"resend"`, `recipient`, `sender`, `providerAccepted:true`, `recipientConfirmed:true`. Both successful provider acceptance and actual recipient receipt must be supported. |

Evidence timestamps must not be later than `updatedAt`, and the policy revision
must not be in the future. Keep all real addresses, account IDs, and evidence
references private. The email sender and recipient must match the effective
`ALERTS_EMAIL_FROM` and `ALERTS_EMAIL_TO`; changing either requires corresponding
delivery evidence. Valid configuration syntax alone cannot satisfy this record.

The provider authority review concerns the existing production credential, not
the ChatGPT OAuth connection. Sequence's OAuth money movements require human
approval, while API-key approval settings and amount caps are separate. A
simulation bypasses approval and cannot prove unattended behavior. See the
[Sequence API reference](https://api.getsequence.io/platform/).

`npm run simulate` is the no-network rehearsal of the actual monthly engine.
`npm run simulate:sequence` is a separate, explicitly gated provider check using
the existing runtime key, current configured pairs, Bills target, and statutory
Roth preview. Its requests always include `simulation:true` and synthetic cash;
its seven test amounts are described in [activation](activation.md#explicit-provider-simulations).
The output omits credentials and provider IDs. It neither changes
`activation_policy` nor writes the financial ledger. Successful scope tests do
not resolve an unverified unattended approval setting or email receipt.

`GET /api/readiness` checks these records with current account/cash reads,
disabled-rule evidence, income reconciliation, Bills monitoring, and the next
cycle's Roth policy. Its limit assessment uses a conservative upper bound for
one possible request, not a transfer plan; it can require limit review even
when a particular planned allocation is smaller. Readiness separates missing
prerequisites in `blockers` from final switches in `activationChanges`.

The initial live production build is gated on readiness. Already established
activation remains distinguishable from new activation so known transfer
observation and code repairs do not require resetting the ledger or cutoff.
The [activation runbook](activation.md) describes the fresh checks and final
authorized environment/deployment changes. No activation occurs merely by
writing a verified policy or running `npm run simulate`.

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
