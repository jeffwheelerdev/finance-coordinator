# Roth contribution policy

**v0.6 monthly priority mode:** Roth is fourth, after Bills, General Spending,
and Emergency, within the single first-day cycle. Eligible partial funding is
allowed; unpaid dated obligations carry to later first-day cycles in the same
tax year. The older full-installment/native-savings behavior belongs only to
the legacy branch. See [monthly priority policy](monthly-priority.md).

`lib/roth.mjs` validates private, tax-year-specific policy and calculates a
monthly cash contribution. It does not select or purchase investments, infer
contributions from an account balance, or certify the custodian's transfer
classification. The executor separately verifies the destination, contribution
route, current cash commitments, balances, and activation gates. The monthly
executor uses this fiscal policy together with its dated obligation ledger.

## Monthly schedule

The policy uses `America/New_York` to identify the current calendar month and
tax year. Each month's slot is due on the first at **15:00 UTC**. This is
10 a.m. Eastern Standard Time or
11 a.m. Eastern Daylight Time. A slot cannot execute before its due time or
before the configured activation cutoff. A due time before activation is
excluded; activation does not recover earlier months or increase the scheduled
installment. In v0.6 all new requests remain inside the first local day; a later
daily check does not authorize a late transfer. A monthly cycle freezes one Roth
request, which can fund several eligible dated obligations and records their
individual attribution.

For a verified annual Roth allowance `A`, in integer cents, installment `m` is:

```text
floor(A × m / 12) − floor(A × (m − 1) / 12)
```

The twelve installments sum exactly to `A`, including when it does not divide
evenly by twelve. An indicative preview uses the published base limit when
personal eligibility is unknown; the executable amount remains zero.

## Policy schema

The complete top-level object has exactly these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `id` | The permanent identifier `roth-ira`. |
| `timeZone` | Exactly `America/New_York`. |
| `updatedAt` | A timezone-qualified ISO revision timestamp. |
| `statutoryLimits` | Up to 100 independently verified IRS year records. |
| `years` | Up to 100 independent personal tax-year records. |

A statutory record has `year`, nonnegative integer `baseLimitCents` and
`catchUpLimitCents`, `verifiedAt`, and `sourceUrls`. Sources must be clean HTTPS
URLs on `irs.gov` or `www.irs.gov`, without credentials, query strings or
fragments. A source URL identifies the evidence; the parser does not retrieve
the page or establish that an amount was published. The monitoring process must
verify that fact. Different years cannot share an implied or forecast limit.

Each personal year contains:

| Field | Accepted value |
| --- | --- |
| `year` | The specific tax year being verified. |
| `catchUpEligible` | `true`, `false`, or `null` when unknown. |
| `eligibility` | An unverified status or both verified personal ceilings. |
| `outsideContributions` | An unverified status or separate verified Traditional and Roth totals. |
| `exclusiveCoordinator` | Whether the coordinator is confirmed as the sole future contribution executor. |
| `otherSchedule` | Whether the absence of another active contribution schedule has been verified. |

The unverified variants are deliberately explicit:

```json
{
  "year": 2030,
  "catchUpEligible": null,
  "eligibility": { "status": "unverified" },
  "outsideContributions": { "status": "unverified" },
  "exclusiveCoordinator": { "confirmed": false },
  "otherSchedule": { "status": "unverified" }
}
```

This is a synthetic example year. It supplies no statutory limit or personal
authorization. Unverified objects cannot also contain plausible-looking zero
amounts or evidence fields.

Verified `eligibility` requires `status: "verified"`,
`annualRothLimitCents`, `annualCombinedLimitCents`, `verifiedAt`, and `reference`.
The first ceiling is the person's permitted direct Roth amount after applicable
income and compensation limits. The second is the permitted combined regular
Traditional-plus-Roth amount after the applicable compensation limit. Roth
cannot exceed combined, and combined cannot exceed the applicable published
base-plus-eligible-catch-up amount. Neither value is derived from salary
deposits or brokerage balances.

Verified `outsideContributions` requires `status: "verified"`,
`traditionalCents`, `rothCents`, `verifiedAt`, and `reference`. These are amounts
attributed to the specified **tax year**, across the relevant accounts, and
exclude every contribution tracked by this coordinator. They must not silently
include rollovers, conversions, earnings, reinvested dividends, or a different
tax year's contributions.

Confirmed `exclusiveCoordinator` requires `confirmed: true`, `confirmedAt`,
and `reference`. A verified `otherSchedule` requires `status: "none"`,
`verifiedAt`, and `reference`. All evidence timestamps must be no later than
the policy revision. A future-dated policy cannot authorize a current request.

## Two independent contribution ceilings

The remaining permitted contribution is the smaller of:

```text
Roth room     = personal Roth ceiling − outside Roth − own reserved contributions
Combined room = personal combined ceiling − outside Traditional − outside Roth
                − own reserved contributions
```

The pure fiscal forecast bounds the current installment by remaining room.
The v0.6 planner can combine that target with verified unpaid same-year monthly
obligations, and can fund a partial amount when cash is short. The aggregate
request still cannot exceed remaining annual room. The executor supplies
`ownReservedCents` from immutable
requests for the same year, including accepted, uncertain and settled requests.
When rechecking an uncertain request, it excludes that request itself from the
aggregate before deciding whether its unchanged amount still fits.

Ordinary monthly Roth shortfalls are retained for later scheduled monthly cycles in
the same year. Project and Personal Investment cannot consume cash ahead of an
unpaid or unverified Roth obligation. In December's annual-close cycle, held
current-year windfalls can help fund those obligations before Project catch-up
and Personal Investment. A prior-year shortfall is never automatically replayed
as a current-year ACH contribution.

For a **synthetic example**, suppose the published/compensation ceiling is
$8,000, a verified income restriction reduces the direct Roth ceiling to
$4,000, and outside Traditional contributions total $1,000. With no outside
Roth or own requests, Roth room is $4,000 and combined room is $7,000. The
remaining Roth allowance is therefore $4,000. Subtracting the Traditional
amount from the Roth ceiling a second time would incorrectly reduce it to
$3,000.

Verified zero is a legal no-contribution outcome, not missing information.
An already exhausted allowance creates no additional contribution. Contributions
above either verified ceiling block new requests for review. Negative amounts,
fractional cents and integer overflow are errors.

## Annual rollover and monitoring

Every new year needs its own published IRS record and personal evidence.
Prior-year eligibility, outside totals, catch-up eligibility and exclusivity
are never copied automatically. An unverified new year supplies no executable
amount. The statutory monitor may update published limits and create an
unverified personal-year placeholder; it must preserve existing personal
evidence rather than inventing confirmations. See
[Roth monitoring](roth-monitor.md) for that separate workflow.

The normalized policy includes sorted year/source records; its forecast also
includes a SHA-256 hash of that policy. The executor retains the revision and
hash with its decisions so later policy changes cannot silently rewrite an
earlier transfer intent.

## IRS references

The legal contribution limit is shared across regular Traditional and Roth
contributions and is subject to compensation; direct Roth contributions also
have filing-status and income restrictions. Contribution year and transfer
date can differ near the tax filing deadline. Consult the current official
sources when verifying a policy year:

- [IRA contribution limits](https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits)
- [Cost-of-living adjustment tables](https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions)
- [Publication 590-A](https://www.irs.gov/publications/p590a)
- [Form 8606 instructions](https://www.irs.gov/instructions/i8606)
