# Finance Coordinator

Recovered source and development history for a Sequence financial-automation
coordinator hosted on Vercel.

**Recovery status: incomplete for the current 0.2.1 runtime.** This repository
preserves two complete historical code bundles and three recovered current
configuration/metadata files. Five current runtime files still need a complete
source export. This checkout is not a deployable replacement for the existing
hosted service. See [source recovery](docs/recovery.md) for the exact inventory.

## Repository map

| Location | Purpose |
| --- | --- |
| [`archive/decision-core/`](archive/decision-core/) | Historical pure Python decision logic, proposed schema, synthetic mapping, and 36 unit tests. |
| [`archive/observer-0.1.0/`](archive/observer-0.1.0/) | Historical read-only WSGI receiver, deployment metadata, and 31 mocked tests. |
| [`snapshots/deployment-0.2.1/`](snapshots/deployment-0.2.1/) | Recovered current package/routing metadata and a sanitized configuration example; incomplete runtime. |
| [`docs/`](docs/) | Architecture, recovery provenance, and the remaining import work. |
| [`scripts/test_archives.py`](scripts/test_archives.py) | One command to run both recovered historical test suites. |
| [`.github/workflows/tests.yml`](.github/workflows/tests.yml) | Test-only GitHub Actions workflow; no deployment or banking credentials. |

## Run the recovered tests

Python 3.12 is the historical observer's declared runtime. The test suites use
only the standard library, synthetic evidence, and mocked adapters:

```bash
python3 scripts/test_archives.py
```

The current archive baseline is **67 passing tests**: 36 decision-core tests and
31 observer tests. These results cover the archived code, not the missing
0.2.1 runtime or a complete real-money workflow.

## Intended workflow

Sequence rules perform the configured allocations and capped savings routing.
The hosted coordinator is intended to reconcile the resulting executions,
transfers, refunds, and account evidence before requesting a later spending
top-up. It must distinguish pending, failed, duplicate, stale, and ambiguous
evidence before deciding whether work can continue.

The current hosted configuration was observed with `APP_MODE=observe` and
`LIVE_TRANSFERS_ENABLED=false` during recovery. This repository import does not
change those settings or activate Sequence rules.

Read [architecture and version boundaries](docs/architecture.md) before reusing
the historical code. The earlier PostgreSQL/webhook design and newer Node/Blob
design are separate stages of the project.

## Configuration and privacy

This is a public repository. Examples use synthetic identifiers; private
account mappings, production credentials, personal financial notes, and state
records are excluded. Provider secrets belong in the deployment environment.
Do not derive a live setup from example UUIDs or illustrative monetary limits.

Current service recovery and a complete review must finish before a deployment
can be built from this checkout. There is no automated deployment workflow or
new Git-to-Vercel connection in this import.

## Continue development

1. Recover and verify the five missing current runtime files listed in
   [the source manifest](docs/source-recovery.json).
2. Externalize private account/rule mappings before publishing those files.
3. Recover or add offline tests for the current runtime and reconcile the
   package-version mismatch.
4. Review deployment and activation separately after the source is complete.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local validation and change boundaries.
