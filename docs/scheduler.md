# Monthly scheduler and safe delivery test

The scheduler wakes the existing coordinator. It does not contain account routes, contribution amounts, financial credentials in messages, or transfer logic. The current canonical coordinator remains responsible for activation, saved settings, current evidence, cash reservations, annual contribution room, the execution window and immutable request identity.

## Daily kickoff and finite retries

Vercel Hobby permits one execution per day for each cron job and schedules within the configured hour. The project therefore has one daily `0 15 * * *` cron calling `/api/scheduler`. It does not use hourly cron expressions or multiple daily jobs to imitate a faster cron. See [Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).

The authenticated production-only producer reads the saved ledger and shared calendar. It accepts the configured canonical hostname or the exact production hostname supplied by `VERCEL_URL`, both over HTTPS and with the existing cron bearer token. This accommodates Vercel's documented [production deployment URL for cron requests](https://vercel.com/docs/cron-jobs); it does not broaden the financial endpoint's canonical-host requirement. When the current monthly window is open, it publishes the remaining hourly UTC wake times before that window closes, then calls the canonical `/api/reconcile` once. There are at most 13 delayed wakes in winter or 12 in summer. A frozen cycle retains its original slot after later settings edits. Future activation, completed cycles and elapsed windows do not create a new monthly opportunity.

Outside the monthly window, the daily producer still calls the canonical coordinator once for observation and settlement monitoring. It publishes no delayed wakes. A fresh inactive preparation remains prospective and does not enqueue retries for an already elapsed start time; the separate health-only test verifies queue delivery without starting a financial cycle. An existing bound cycle can still receive observation wakes while paused. If the saved state cannot be read or validated, the producer fails closed with `SCHEDULER_SAVED_STATE_UNAVAILABLE`; it cannot safely select a saved window in that invocation.

Queue publishing uses deterministic date-and-hour idempotency keys. Each message expires at the actual following midnight in `America/New_York`, with a payload limited to:

```js
{ schemaVersion: 1, kind: 'wake', date, wakeAt, expiresAt }
```

The consumer validates that shape, accepts only the configured topic, and checks the expiry both before obtaining runtime identity and immediately before requesting reconciliation. A late message is acknowledged without a request. The consumer never republishes. Delays are eligibility times, not a guarantee of exact hourly delivery.

Vercel Queues supports delayed messages and at-least-once delivery. The SDK acknowledges successful consumers and retries failed ones. This project caps each message at three deliveries, with a five-minute retry interval. Duplicate calls still enter the existing coordinator lease and immutable transfer requests. A partially successful or uncertain enqueue is reported as such; the primary daily reconciliation still runs. See the [Queue SDK reference](https://vercel.com/docs/queues/sdk).

## Current deployment and private access

The Node consumer is registered as a private `queue/v2beta` function through `experimentalTriggers`; it has no public rewrite. Queue messages remain attached to the deployment that published them, including after a new production deployment. Therefore the consumer only makes a bodyless request to the fixed `https://FINANCE_CANONICAL_HOST/api/reconcile`. It never invokes its own deployment's financial implementation. Pausing the current canonical coordinator still stops new financial execution, even if an older queue continues delivering. Redirects are rejected. See [Queue security and deployment behavior](https://vercel.com/docs/queues/concepts).

The canonical request includes the existing `CRON_SECRET` authorization and a short-lived Vercel OIDC token in `x-vercel-trusted-oidc-idp-token`. [Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources) supports same-project production-to-production access by default. Secure Backend Access with OIDC Federation must remain enabled, and custom self-access rules must preserve that environment pair. This adapter does not create or require a static protection-bypass secret. Tokens and response bodies are never included in its returned summaries.

The adapter pins `@vercel/queue` and `@vercel/oidc` in the lockfile. Canonical reconciliation is bounded to three minutes, enqueue to twenty seconds, and health reads to fifteen seconds, within the function's five-minute maximum. A timed-out request may already have reached the coordinator; it is reported as uncertain and recovery uses the existing financial ledger, not a new transfer identity.

## Delivery test and evidence

The dashboard's scheduler test is available only in production observation mode with live transfers disabled. It first records an expiring intent in the private ledger, then publishes one message delayed by sixty seconds:

```js
{ schemaVersion: 1, kind: 'probe', id, queuedAt, expiresAt }
```

The consumer's probe branch can only `GET /api/health`. It cannot call reconciliation, regardless of its environment's live setting. Completion requires HTTP 200 JSON declaring ready, the expected software version, observation mode and disabled live transfers. A matching, unexpired CAS receipt then proves that a private queue callback reached the canonical health endpoint using runtime OIDC. The proof is bound to its publishing deployment and software version; a subsequent deployment makes an older receipt unverified until a new test completes.

An enqueue acknowledgement means queued, not delivered. A missing callback, expired message, inaccessible canonical endpoint, conflicting ledger write, unexpected response or changed deployment cannot produce a completed receipt. This test sends no money or email and does not prove financial transfer approval, settlement, inbox receipt, future uptime, or exact timer precision.

## Operational limits

Queues is a Vercel Beta feature available on all plans. Hobby includes its published queue-operation allowance; function computation is still subject to the normal plan limits. The finite wake set is small, but availability and allowances must be monitored rather than described as unlimited or guaranteed free. See [Queue pricing and limits](https://vercel.com/docs/queues/pricing).

The daily kickoff remains an external scheduling dependency: a wholly missed cron cannot publish its wake set. Expired or exhausted messages stop instead of running after the approved financial window. Existing conservative reservations can also hold lower-priority legs when the same pending bank movement appears in multiple feeds. Durable wake delivery improves retry opportunities; it does not relax those financial safeguards.

Deployment verification should confirm the single daily cron, private queue trigger, current same-project OIDC access, a completed current-deployment health probe, and continued anonymous denial of private dashboard/API pages. The ordinary offline test suite uses injected queue and HTTP dependencies; it never publishes a real message or performs a financial transfer.
