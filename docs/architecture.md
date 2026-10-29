# Architecture and version boundaries

## Sequence and the coordinator

Sequence owns account connections, allocation rules, and transfer execution.
The coordinator's intended role is to reconcile evidence across a financial
cycle before requesting a later rule execution. This is necessary when a later
action depends on earlier transfers and refunds being complete.

Account balance targets and allocation percentages are configuration. An
account-balance target is different from a recurring contribution amount.
Examples in this repository describe code behavior and synthetic tests, not a
personal budget or verified account state.

## Historical decision core

`archive/decision-core/coordinator_core.py` is pure Python decision logic. Its
adapter supplies normalized evidence; the core returns a decision such as
`WAIT`, `REVIEW`, `READY`, or `DONE`. It cannot independently observe a bank,
move money, or establish that a refund has posted.

The accompanying SQL schema was a proposed persistence design. Its presence in
the archive does not establish that a database migration was ever applied.

## Historical observer 0.1.0

`archive/observer-0.1.0/app.py` is a read-only WSGI application. It implements a
signed webhook receiver, a PostgreSQL inbox, constrained Sequence reads, and
status reporting. It contains no transfer or rule-trigger implementation.

Its tests mock the database and provider paths. This release is retained for
history; it is not the current Node coordinator.

## Current hosted design: partial source recovery

The complete recovered metadata declares Node 22, a pinned `@vercel/blob`
dependency, a 60-second function duration, and a daily reconciliation schedule
at 13:00 UTC. The source version constant is `0.2.1`.

Visible source prefixes show intended components for execution/policy checks,
a constrained Sequence client, and persistent Blob state. Those files are not
fully recovered, so this repository makes no claim that their complete
implementation has been reviewed or that live execution is ready.

The recovered `vercel.json` includes status, diagnostics, storage-test,
simulation-check, and reconciliation routes. Route names alone do not prove
that an endpoint is read-only. Do not exercise them as part of repository tests.

## Development and operations boundary

Repository CI runs historical offline tests. It has no credentials and does not
deploy, invoke the hosted coordinator, activate Sequence rules, or send
transfers. Source publication, hosted deployment, and financial activation are
separate operations.
