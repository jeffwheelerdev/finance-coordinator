# Working on Finance Coordinator

## Local validation

Run the recovered historical suites from the repository root:

```bash
python3 scripts/test_archives.py
```

The suites use synthetic data and mocked adapters. No provider credentials are
needed. The runner removes finance credentials from each test process and sets
observation mode. Passing historical tests does not validate a newer runtime.

## Repository boundaries

- Keep current runtime code distinct from historical material in `archive/`.
- Preserve source provenance when recovering a previous deployment. Do not
  represent a partial export or a reimplementation as the original source.
- Use synthetic identifiers, events, and balances in examples and fixtures.
- Keep account mappings, provider IDs, personal notes, keys, and state files
  outside commits. `.gitignore` covers common local configuration paths.
- Keep secrets in the appropriate deployment environment. Do not paste them
  into issues, pull requests, logs, or documentation.

## Changes to financial execution

Use mocked adapters for development and tests. Inspect failure, retry,
concurrency, and stale-data behavior before changing execution logic. Unknown
transfer outcomes need reconciliation before a retry can be considered safe.

Repository maintenance does not activate financial rules or authorize a live
test. Deployment, configuration changes, and financial activation are separate
operations. This repository's CI runs tests only and has no financial secrets or
deployment credentials.
