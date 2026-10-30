# Finance Coordinator

A Sequence coordinator for refund-triggered spending-account funding and
independent monthly Roth IRA contributions from Income. The current **0.5.0 implementation is newly authored**
Node.js code for Vercel. Its source is complete; deployment and financial
activation require the separate checks in [activation](docs/activation.md).
Source availability does not establish that a deployment is active.

The partial 0.2.1 export remains a historical snapshot. The new implementation
does not recover or reconstruct the five missing original source files. See
[recovery provenance](docs/recovery.md) for that separate inventory.

## Funding behavior

Bills has first priority. A private catalog projects the current commitments
into all twelve months of the current `America/New_York` calendar year. The
highest month determines the Bills balance target, rounded up to a $500 boundary:

```text
Bills target = ceiling(highest projected monthly bills in cents / 50,000) × 50,000
```

Annual charges stay in their renewal month rather than being divided by twelve.
Unknown annual dates are conservatively grouped into the highest month.
Confirmed cancellations take effect on their recorded local date; uncertain
obligations remain included. This forecasts the recorded obligations, not a
guaranteed limit on future spending.

General Spending follows Bills and has its own balance target:

```text
target = GENERAL_SPENDING_MONTHLY_BUDGET × GENERAL_SPENDING_RESERVE_MONTHS
```

The monthly amount accepts any nonnegative dollar amount with up to two decimal
places, within exact integer-cent limits. Change the private environment value
and redeploy to change the target; there is no fixed budget menu or hard-coded
spending target.

An opportunity to fund arises only from an actual, settled Pod→Income refund
belonging to the configured payout execution. The coordinator verifies the full
payout, checks upstream funding history, and waits for suitable cash evidence.
It fills Bills from Income first while protecting the explicit Income reserve.
It does not subtract the Bills deficit twice when funding Bills itself.
General Spending becomes eligible only after Bills is funded, any Bills
transfer has settled, and the required balances have refreshed. Additional
accounts follow General Spending.

Each recipient gets at most one immutable funding intent per refund event.
A successful partial fill consumes that recipient's opportunity; later polling
or a budget edit does not refill it from the same event. A cycle without an
actual refund creates no opportunity. Lowering a target never withdraws money
from the destination.

If a Bills attempt can fill only part of its deficit, or cannot move an eligible
amount, lower recipients are skipped for that refund cycle. A later deposit or
catalog edit does not revive them. A higher Bills target after a completed
Bills attempt also prevents lower recipients from using money needed by Bills;
it does not create a second Bills request for the same event.

## Monthly Roth contributions

Roth has a separate calendar schedule. On the first day of each New York month,
the coordinator can initiate one current-year contribution equal to one twelfth
of the verified annual Roth allowance. A $7,500 annual allowance produces twelve
$625 installments. Integer-cent installment differences distribute any remainder
over the year without exceeding the annual amount.

This flow does not require a Pod refund or an empty Pod. The daily check runs at
15:00 UTC, after the existing native savings schedule at 14:00 UTC. It verifies
that the scheduled savings run has started and all commitments are known, then
reserves pending native debits, the Bills shortfall and the explicit Income
reserve. It may fund Roth while known Emergency/Project transfers remain pending.
Missing, changed or ambiguous upstream evidence delays the Roth contribution.

The contribution policy uses statutory IRS limits, verified personal eligibility,
and tax-year contribution records across all relevant IRAs. Market value and
dividends are not contribution history. Own settled, pending and uncertain
requests share one durable annual allowance and the existing execution lease.
Another recurring contribution schedule must be reconciled before this
coordinator can become the sole ongoing contributor.

A scheduled monitor can add newly published IRS limits to private Global Config
without redeployment. New statutory limits do not establish personal eligibility
or contribution history for a new year. Missing annual facts pause Roth while
the cash-account flows retain their own rules. The prepared feature remains
subject to the global inactive gates and deliberate activation cutoff.

Insufficient cash leaves the installment waiting for a later check in the same
month. The coordinator does not make a partial contribution simply because
cash is short, automatically catch up missed months, or replay a December
contribution in January. Starting partway through a year therefore does not
guarantee the annual maximum will be reached. See [Roth policy](docs/roth-policy.md)
and [annual limit monitoring](docs/roth-monitor.md).

## Private Bills policy and monitoring

The application reads `bills_catalog` and `bills_monitor` together from private
Vercel Global Config for each operation. Reads use origin consistency, disable
fetch caching, and reject stale-on-error fallback. A matching successful
monitor check no older than seven days is required for new financial work.
Catalog changes take effect without redeploying application code.

A separate scheduled ChatGPT monitor checks connected Finances evidence and
maintains that catalog. The Vercel function has no direct Finances connector
access. See [Bills monitoring](docs/bills-monitor.md) for evidence rules,
coverage limits, update preparation and scheduling. Global Config contains
policy; the private Blob ledger remains the sole execution lock and intent
record. Missing or invalid policy blocks new submissions. An already accepted
transfer with a known provider ID may still be observed during a policy outage.

The default example is inactive: `APP_MODE=observe` and
`LIVE_TRANSFERS_ENABLED=false`. Both gates and a deliberate activation cutoff
are required for financial submission. Tests use synthetic evidence and mocked
providers; there is no live transfer test.

## Read and validate

| Document or location | Purpose |
| --- | --- |
| [Configuration](docs/configuration.md) | Private variables, dynamic Bills policy, arbitrary budgets, and future recipients. |
| [Bills monitoring](docs/bills-monitor.md) | Catalog evidence, automatic updates, freshness, and operational limits. |
| [Roth policy](docs/roth-policy.md) | Independent monthly contributions, annual room and personal evidence. |
| [Roth limit monitoring](docs/roth-monitor.md) | Official IRS updates, private policy changes and rollover behavior. |
| [Architecture](docs/architecture.md) | Evidence, reserves, durable state, retries, and limits. |
| [Activation](docs/activation.md) | Inactive setup, read checks, deliberate activation, and operations. |
| [`lib/`](lib/) and [`api/`](api/) | Current 0.5.0 implementation. |
| [`test/`](test/) | Offline tests for the current implementation. |
| [`archive/`](archive/) | Historical Python decision core and read-only observer. |
| [`snapshots/deployment-0.2.1/`](snapshots/deployment-0.2.1/) | Incomplete original runtime export, with sanitized configuration. |

Use Node.js 22 or 24 and Python 3.12 for the historical suites:

```bash
npm ci --ignore-scripts
npm test
python3 scripts/test_archives.py
```

These commands require no financial credentials and make no real provider calls.
GitHub Actions runs tests only. See [CONTRIBUTING.md](CONTRIBUTING.md) before
changing execution behavior.

This public repository contains synthetic examples. Real account and rule IDs,
credentials, private financial policies, and the execution ledger belong in
private configuration and storage.
