# Historical decision core

This is a sanitized archive of the pre-deployment Python decision core from
`finance_automation_setup.zip`, created on October 29, 2026. The original bundle
did not declare a software version. It predates the deployed coordinator and is
**not the current 0.2.1 service or a drop-in replacement for it**.

## Preserved components

- `coordinator_core.py`: pure decision logic returning `WAIT`, `REVIEW`, `READY`,
  or `DONE`; no network calls or money movement.
- `tests/test_coordinator.py`: 36 synthetic unit tests.
- `state_schema.sql`: a proposed PostgreSQL schema, not a migration deployed by
  this repository.
- `mapping.example.json`: synthetic account/rule identifiers and example
  parameters, with execution disabled.

The core checks transfer completeness, failed stages, simulation/live evidence
separation, dated balances, a verified refund flag, protected funds, prior
attempts, and stable per-cycle intent identity. It also includes an HMAC
signature helper. These checks consume evidence supplied by an adapter; they do
not independently verify bank postings or provide a settlement matcher. A
`READY` decision does not execute a transfer.

All monetary constants and fixture balances in this directory are synthetic
examples. The example policy was changed during sanitization to a $2,500
spending target, a $15,000 emergency target, 10% emergency allocation and 3%
project allocation. Related fixture amounts and expected results were updated
consistently; the execution algorithm is unchanged. These values are not a
personal financial plan, a current balance, or an instruction for a live account.
The example UUIDs have a zero prefix and do not identify provider accounts or rules.

## Local tests

From this directory:

```bash
python3 -B -m unittest discover -s tests
```

The tests require only the Python standard library. The recovered originals and
this sanitized copy each passed 36 tests during recovery. These are synthetic
unit tests, not live settlement or integration tests.

## Historical integration boundary

A complete implementation would need a separately reviewed evidence adapter,
durable atomic intent claiming, reconciliation of prior attempts, a stable API
idempotency key, and explicit execution configuration. Those facilities are not
implemented by this archived module. The original document's account-specific
setup instructions and financial notes were intentionally omitted.

See `PROVENANCE.json` for the source archive hash and the sanitization record.
