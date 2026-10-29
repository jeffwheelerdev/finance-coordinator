# Finance Coordinator

A Sequence coordinator for funding spending accounts from Income after a
verified Pod refund. The current **0.3.0 implementation is newly authored**
Node.js code for Vercel. Its source is complete; deployment and financial
activation require the separate checks in [activation](docs/activation.md).
Source availability does not establish that a deployment is active.

The partial 0.2.1 export remains a historical snapshot. The new implementation
does not recover or reconstruct the five missing original source files. See
[recovery provenance](docs/recovery.md) for that separate inventory.

## Funding behavior

General Spending has a balance target:

```text
target = GENERAL_SPENDING_MONTHLY_BUDGET × GENERAL_SPENDING_RESERVE_MONTHS
```

The monthly amount accepts any nonnegative dollar amount with up to two decimal
places, within exact integer-cent limits. Change the private environment value
and redeploy to change the target; there is no fixed budget menu or hard-coded
spending target.

An opportunity to fund arises only from an actual, settled Pod→Income refund
belonging to the configured payout execution. The coordinator verifies the full
payout, checks upstream funding history, waits for suitable cash evidence, and
protects the Bills shortfall and explicit Income reserve before filling the
remaining target gap. General Spending has first priority; additional accounts
can be configured prospectively.

Each recipient gets at most one immutable funding intent per refund event.
A successful partial fill consumes that recipient's opportunity; later polling
or a budget edit does not refill it from the same event. A cycle without an
actual refund creates no opportunity. Lowering a target never withdraws money
from the destination.

The default example is inactive: `APP_MODE=observe` and
`LIVE_TRANSFERS_ENABLED=false`. Both gates and a deliberate activation cutoff
are required for financial submission. Tests use synthetic evidence and mocked
providers; there is no live transfer test.

## Read and validate

| Document or location | Purpose |
| --- | --- |
| [Configuration](docs/configuration.md) | Private variables, arbitrary budgets, and future recipients. |
| [Architecture](docs/architecture.md) | Evidence, reserves, durable state, retries, and limits. |
| [Activation](docs/activation.md) | Inactive setup, read checks, deliberate activation, and operations. |
| [`lib/`](lib/) and [`api/`](api/) | Current 0.3.0 implementation. |
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
