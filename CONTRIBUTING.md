# Working on Finance Coordinator

## Offline validation

Use Node.js 22 or 24 and Python 3.12. From the repository root:

```bash
npm ci --ignore-scripts
npm test
python3 scripts/test_archives.py
```

Current tests use injected, mocked adapters and synthetic evidence. Historical
Python suites use the standard library and mocked providers. These commands
need no financial credentials. Passing tests validates the exercised code
paths; it is not a live financial test or proof of deployment configuration.

`npm run preflight` has a different purpose: with private environment settings
it reads the real provider and can conditionally write observation metadata to
the configured ledger. Production builds run this forced-observation check.
Neither may make a financial POST. See [activation](docs/activation.md) before
using real deployment configuration.

## Source and privacy boundaries

- Keep the new 0.3.0 runtime distinct from historical material in `archive/`
  and the incomplete 0.2.1 snapshot.
- Preserve provenance. A reimplementation or partial export is not recovered
  original source.
- Use synthetic IDs, balances, and events in fixtures and examples. Keep real
  mappings, personal policies, financial state, and credentials out of commits,
  issues, pull requests, screenshots, and logs.
- Keep GitHub Actions limited to offline tests, without financial or deployment
  credentials. Source publication does not activate financial rules.

## Changes to execution behavior

Use meaningful offline cases for identity, settlement, stale balances, reserves,
partial funds, duplicate polls, concurrency, uncertain outcomes, and policy
edits. Verify that disabled gates and forced observation prevent every financial
POST, including retry paths. Preserve the immutable body and idempotency key
after a submission may have reached the provider.

Never delete or reset the production ledger to simplify a test. Do not attach
previews to production storage or run a second production writer. No live
transfer, provider-rule change, or financial activation is part of routine
repository validation. Document behavior changes and their operational limits
alongside code.
