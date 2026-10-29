# Historical observer 0.1.0

This is a sanitized archive of the Python `0.1.0-observer` release recovered
from `finance_coordinator_deployed_source.zip`, created on October 29, 2026. It
is **not the current 0.2.1 coordinator**. Nothing in this directory is imported
by the current service merely because it is included in the repository.

## Preserved components

- `app.py`: the historical WSGI application, signed webhook receiver, PostgreSQL
  event inbox, and GET-only Sequence observation code.
- `tests/test_receiver.py`: 31 tests using synthetic events and mocked storage
  or API responses.
- `requirements.txt` and `pyproject.toml`: the original Python 3.12 dependency
  and entry-point declarations.
- `vercel.json`: the historical deployment configuration, including its daily
  reconciliation schedule; this is not the repository-root deployment config.

This version contains no Sequence transfer or rule-trigger implementation. It
requires durable storage before acknowledging webhook events, checks signatures
and replay windows, filters observations to an account allowlist, and redacts
errors. It does not include a complete financial-cycle matcher, verified bank
refund correlation, a live executor, or a complete-history guarantee.

The account allowlist now contains clearly synthetic UUIDs. Test secrets are
explicit test fixtures. No personal account mapping, provider deployment IDs,
team URLs, real credentials, balance history, or original deployment manifest
is included.

## Local tests

From this directory:

```bash
python3 -B -m unittest discover -s tests
```

The existing suite mocks the database and API paths and uses only synthetic
events. The recovered originals and this sanitized copy each passed 31 tests
during recovery. These results do not establish live webhook delivery, database
connectivity, bank settlement, or current-service readiness.

The original connection and credential setup instructions are intentionally
omitted because they described an earlier deployment stage. Consult the current
service documentation for current configuration.

See `PROVENANCE.json` for the source archive hash and the sanitization record.
