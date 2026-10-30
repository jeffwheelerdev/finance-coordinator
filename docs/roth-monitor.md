# Annual Roth limit monitoring

The monthly contribution amount is derived from a verified annual policy. A
separate scheduled ChatGPT task checks official IRS publications for a newly
published current or next-year IRA limit. It can add that statutory record to
the private `roth_policy` item without changing application code or deployment
variables. The runtime never guesses the next year's amount or rolls a prior
limit forward when the new year is missing.

## Sources and separation of responsibilities

Use the IRS's [IRA contribution limits](https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-ira-contribution-limits),
[annual COLA table](https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions),
and the corresponding official annual notice or newsroom announcement. Verify
the tax year, ordinary IRA base limit and age-based catch-up amount explicitly.
Do not confuse IRA amounts with 401(k), TSP, SIMPLE or other plan limits. The
[2026 announcement](https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500)
is an example of an official source, not a permanent future-year value.

Only a newly published statutory year follows the automatic update path.
Conflicting amounts for an already verified year require review. Routine
unchanged checks do not rewrite timestamps or consume configuration writes.
The monitor stays quiet unless it saves a meaningful change or finds a new
actionable issue.

Personal annual evidence is separate. IRS publication does not prove the
account holder's income eligibility, compensation limit, catch-up eligibility,
other IRA contributions or lack of another recurring schedule. The monitor
preserves existing personal records exactly and adds an **unverified** personal
placeholder for a new statutory year. It cannot automatically copy last year's
eligibility or assume zero contributions. The monthly preview changes to the
new published amount; financial submission waits for all applicable annual facts.

## Private envelope

The Global Config key contains three fields: `schemaVersion: 1`, `policy`
(the object in [Roth policy](roth-policy.md)), and `evidence`:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-29T20:00:00.000Z",
  "route": { "status": "unverified" },
  "upstream": { "status": "unverified" }
}
```

The example's unverified fields intentionally prevent submission. A verified
route adds `sourceAccountId`, `destinationAccountId`, `custodian: "fidelity"`,
`contributionYear: "current_calendar_year"`, `verifiedAt`, and a private
`reference`. Its IDs must match the configured Income and Roth destination.
Fidelity's official [direct-deposit form](https://www.fidelity.com/bin-public/060_www_fidelity_com/documents/customer-service/authorization-for-direct-deposit.pdf)
describes current-year IRA contributions. The Sequence API has no tax-year
selector; an ACH description cannot create one.

A verified upstream record adds `ruleId`, `definitionHash`, `verifiedAt`, and
`reference`. Calculate the fingerprint using `nativeRuleFingerprint()` from the
actual provider rule. It binds the reviewed schedule and step definitions,
while excluding mutable rule status and display names. The supported schedule
is the 1st/15th savings rule at 14:00 UTC. Editing its financial actions or timing
requires a new reviewed pin. An enabled flag alone is not execution evidence:
the Roth cash guard also reads the actual scheduled run and all commitments.

The annual limit monitor may modify only the envelope's monetary-policy
statutory records and create unverified annual placeholders. Route and upstream
evidence remain unchanged. It cannot alter the separate Bills keys, credentials,
execution ledger, provider rules, application live gates or recurring custodian
schedules, and cannot initiate a contribution.

## Deterministic update preparation

Use the reviewed project revision of these files together:

- `lib/roth.mjs`
- `lib/roth-monitor.mjs`
- `scripts/prepare-roth-update.mjs`

The helper uses Node built-ins only and performs no network calls. Prepare a
private JSON file outside the public checkout with this structure:

```json
{
  "envelope": {},
  "verifiedOfficialSources": true,
  "limits": [],
  "now": "2026-10-29T20:00:00.000Z"
}
```

Replace `envelope` with the complete current private value and `now` with the
actual UTC time. `verifiedOfficialSources: true` is an assertion made only after
the source review succeeds. Each newly verified limit contains `year`,
`baseLimitCents`, `catchUpLimitCents`, `verifiedAt`, and `sourceUrls`; see the
strict policy schema. Do not enter a projected, guessed or third-party amount.
An empty `limits` array means no newly published limit was found, not that the
annual allowance is zero.

```bash
node scripts/prepare-roth-update.mjs --input /tmp/unique-run/private-input.json --output /tmp/unique-run/private-output.json
```

Use a fresh run directory and output file. The helper does not replace an
existing output. It validates strict IRS URLs, exact cents, a current/next-year
window, current review evidence and monotonically newer policy versions. It
returns `requiresWrite`, an expected envelope hash, a proposed complete value,
and safe aggregate changes. No changes means no write and no notification.

Before saving, reread the current item and Global Config digest. Confirm the
envelope hash and expected policy timestamp still match the helper's snapshot.
If anything changed, discard the prepared value and recompute against the new
snapshot. Use one `update` operation for `roth_policy` in the existing store,
preserving all unrelated keys. Read back and validate the saved policy before
reporting success. An unknown write result must be inspected before any retry.

The daily watch checks for publication changes; it is not the money scheduler.
The Vercel coordinator independently checks the first-of-month contribution
and cash evidence. Neither a monitoring run nor a policy update activates
financial execution or creates historical monthly contributions.
