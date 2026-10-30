# Private dashboard access and API

The browser dashboard uses the existing Vercel deployment and existing private ledger. Vercel authenticates its permitted viewers. The application then restricts the dashboard to the canonical production origin and uses a short-lived, signed session to protect browser requests. Dashboard sessions do not authorize the coordinator's financial, webhook or setup-email endpoints.

## Enable access in this order

Keep `APP_MODE=observe` and `LIVE_TRANSFERS_ENABLED=false` while setting up and checking the dashboard. Dashboard access and money activation are separate decisions.

1. Enable **Vercel Authentication → All Deployments** for the project. Verify the actual provider setting is `ssoProtection.deploymentType: "all"`, including the production domain. Vercel made production authentication available on every plan in September 2026; older pricing guidance may differ. See the [official announcement](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan) and [Vercel Authentication documentation](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).
2. Review the allowed audience. Team members, project viewers, individually granted users, share links, automation bypasses and trusted sources can affect who reaches the application. This app does not distinguish their identities. Configure access for the intended owner; do not use a protection-bypass URL as the owner's dashboard entry point.
3. With the dashboard still disabled, test the **canonical production hostname** from a clean, unauthenticated browser or request without a bypass token. Confirm Vercel denies access before it reaches private application responses. Also verify the owner's normal signed-in access.
4. Set the runtime values below only after those checks succeed. Deploy the application, then repeat the anonymous denial and owner-access checks against the canonical domain. Review protection again whenever the domain, project audience or protection policy changes.
5. Confirm the existing Vercel cron can still reach its bearer-protected handler while money remains off. The application continues to require the existing `CRON_SECRET` authorization on machine endpoints. Follow the [official cron guidance](https://vercel.com/docs/cron-jobs/manage-cron-jobs); do not expose that secret to the dashboard browser or weaken endpoint authentication.

| Runtime value | Required value |
| --- | --- |
| `DASHBOARD_ENABLED` | Literal `true` |
| `DASHBOARD_ACCESS_POLICY` | Literal `vercel-all-deployments` |
| `VERCEL_ENV` | Vercel-provided `production` |
| `FINANCE_CANONICAL_HOST` | Exact production hostname, without a scheme or path |
| `CRON_SECRET` | Existing server-only signing credential; never include it in public assets |

The first two values record an operator's reviewed decision. **They do not turn on Vercel protection or independently authenticate the owner.** If the deployment is made public while these values remain enabled, an anonymous caller could obtain a dashboard session. Disable `DASHBOARD_ENABLED` before removing or relaxing deployment protection.

Preview deployments, a noncanonical origin, a missing signing key or an unconfigured access policy return a sanitized `503` before private dependencies are read. No request header is treated as an invented Vercel identity assertion. Static dashboard assets contain application code only; enabling the private API is a separate server gate.

## Session and request integrity

`GET /api/dashboard` creates or reuses a 30-minute session. Its cookie is named `__Host-finance-dashboard` and has `Path=/`, `HttpOnly`, `Secure` and `SameSite=Strict`; it has no `Domain` attribute. The signed payload contains a random nonce and its issuance and expiry times, bound to the canonical origin. Purpose-specific HMAC keys are derived from the existing runtime signing credential. The response supplies a separate `csrfToken` and `sessionExpiresAt`; it does not expose the cookie or signing key.

Every dashboard POST requires that cookie, an exact same-origin `Origin`, a matching `X-CSRF-Token` header and `Content-Type: application/json`. When `Sec-Fetch-Site` is present, it must also say `same-origin`. JSON bodies are limited to 16 KiB of actual streamed bytes and a five-second body-read deadline. Unknown fields, query overrides, proxy destinations and alternative actions are rejected. An expired session requires a fresh overview GET before retrying a deliberate action. A changed signing key invalidates existing sessions.

Responses are `no-store`, deny framing and cross-origin resource use, and do not set permissive CORS headers. Errors contain fixed codes rather than private source bodies, submitted values or credentials. Debug exports also omit session data.

## Endpoint contract

These are the only dashboard API routes. The deployment rewrites each route to the existing API handler; `/api/index?route=dashboard/...` uses the same checks. Other query parameters are forbidden except the two documented activity parameters.

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/dashboard` | GET | Reads saved ledger and policy sources; returns the redacted overview and creates or reuses the dashboard session. No provider client is constructed. |
| `/api/dashboard/activity` | GET | Requires a session; reads recorded milestones with optional `cursor` and `limit` (default 25, maximum 100). |
| `/api/dashboard/debug` | GET | Requires a session; produces a bounded, redacted financial debug export. |
| `/api/dashboard/simulate` | POST | Runs the real pure planner against explicitly synthetic inputs. No provider calls, emails or ledger writes. |
| `/api/dashboard/settings/preview` | POST | Returns the proposed control view, including its actual effective month, without saving the ledger. |
| `/api/dashboard/settings` | POST | Saves a prospective control revision using one exact ledger ETag comparison. No financial provider call or money activation. |
| `/api/dashboard/diagnostics` | POST | Performs bounded, read-only provider and policy checks; returns the full overview plus diagnostic results. No financial ledger write, transfer or email. |
| `/api/dashboard/scheduler-test` | POST | With money disabled, queues one short-lived health-only probe and records its delivery result. No reconciliation or financial request. |

The overview's financial fields are documented in [dashboard.md](dashboard.md). A normal overview does not read bank balances, so they remain unavailable until diagnostics succeeds. Diagnostics adds `diagnosticSummary` with `checkedAt`, `status`, `readOnly`, `realTransfers`, `financialLedgerWrites` and a list of safe check results. Failed source sections make that summary `partial`; an unverified financial fact remains a readiness blocker rather than being presented as verified.

The separate `runs` section shows up to 100 finalized coordinator checks, newest first. Each stored row contains only the check time, execution mode, safe status and code, month and newly confirmed acceptance/settlement counts. Unknown provider outcomes do not count as successful requests. The history is saved with the coordinator's existing final ledger comparison, so it does not add a separate write or relax financial invariants. A busy worker, a rejection before obtaining the ledger lease, a process failure or a failed final save can leave no history row. This is a bounded history of persisted checks, not a claim that every HTTP or scheduled invocation was recorded. Existing transfer milestones remain a separate activity view. Debug exports include at most 50 run rows and report truncation.

Diagnostics accepts only `{}`. Its Sequence client is configured for reads, with no allowed transfer pairs, a 70-request budget, five-second request timeouts and a 45-second provider deadline. The evidence helper receives only the five required read methods. It does not call the general preflight/reconciliation handler or construct an alert sender. An initial dashboard refresh may run one diagnostic request; avoid repeated automatic full-history polling.

The simulator accepts exactly `{ "input": { ... } }`; its inner input schema and assumptions are documented in [dashboard.md](dashboard.md). The facade resolves settings, current known bill schedules and the known Roth policy for the requested month. It does not copy a current Roth limit into an unsupported future year. There is no arbitrary transfer button or native rule proxy.

Settings accepts exactly:

```json
{
  "expectedRevision": 0,
  "changes": {
    "generalMonthlyBudgetCents": 85000
  }
}
```

This is a synthetic example of changing the budget to $850. The response contains `status: "saved"`, the safe control view and `realTransfers: 0`. The eight permitted fields and date ranges appear in [dashboard.md](dashboard.md). Account identifiers, eligibility proof, Roth legal limits, email recipients, provider authority and live execution flags cannot be changed here.

Send this same request first to `/api/dashboard/settings/preview` to review the effective month and resulting settings. Its response includes the proposed `settings`, `preview: true` and `financialLedgerModified: false`. It uses the same validation and calendar helper as saving and does not write. Submit the reviewed request to `/api/dashboard/settings` to save it; the preview itself does not reserve a revision.

The save request may additionally contain `expectedEffectiveMonth: "YYYY-MM"`, copied from the reviewed proposed version. If the clock crosses its scheduling opportunity before saving, the server returns `409 DASHBOARD_SETTINGS_PREVIEW_EXPIRED` rather than silently saving a different effective month. The dashboard sends this field. The preview request itself keeps the two-field schema above; clients that omit the optional save guard remain supported.

The save handler validates the existing ledger, rejects an active financial-worker lease, prepares one immutable control version and saves it with the exact ETag it read. A concurrent ledger change or stale `expectedRevision` returns `409`; the handler does not silently retry a stale edit. Reload the overview and review the current revision before submitting a new edit. Current, pending and frozen cycle settings remain distinct.

The existing `/api/reconcile`, status/preflight/readiness routes, webhook and `/api/alerts/test` retain their own bearer or signature rules. A valid dashboard cookie or CSRF token cannot substitute for those credentials.

## Test the protected scheduler connection

The scheduler test is an explicit owner action. It requires the same session and CSRF checks as settings, an exact `{}` body, production deployment identity, `APP_MODE=observe` and `LIVE_TRANSFERS_ENABLED=false`. It rejects a current financial-worker lease. `VERCEL_DEPLOYMENT_ID` is read only from the server runtime; it is not returned to the browser or accepted from a request.

The API first records a private, randomly identified intent by exact ledger CAS. It then publishes only `{schemaVersion, kind: "probe", id, queuedAt, expiresAt}` to the fixed scheduler topic. The message has a five-minute lifetime and a sixty-second initial delay. Its queue idempotency key derives from that saved private ID. A ten-minute cooldown prevents a lost browser or publication response from creating another probe immediately.

The private queue consumer maps `kind: "probe"` to a fixed **GET of the canonical `/api/health`**. It never maps the probe to reconciliation, financial execution or an arbitrary URL. It uses the runtime Vercel OIDC identity to cross deployment protection, rejects redirects, requires bounded JSON rather than HTML, and checks the response's ready status, current software version and disabled money flags. It records success with another exact ledger CAS only while the message remains unexpired and the saved publisher deployment matches the consumer's current deployment. A fresh clock/lease check runs after any asynchronous ledger read and immediately before saving the receipt.

The receipt appears in `tests.scheduler` and the immediate test response. It contains only safe times, version, status and code, fixed `transport: "vercel-queue"`, `authentication: "vercel-oidc"`, `target: "health_only"`, and zero real-transfer/email counts. Its statuses distinguish these facts:

| Status | Meaning |
| --- | --- |
| `not_run` | No probe receipt exists. |
| `pending` | The private intent was saved; queue acknowledgement has not been durably recorded. |
| `queued` | Queue publication was acknowledged; delivery remains unproven. |
| `unknown` | The publication outcome was ambiguous. A matching actual delivery may still complete it. |
| `completed` | The matching private queue delivery reached and verified the protected canonical health endpoint for the recorded current release. |
| `expired` | An unfinished probe exceeded its five-minute window. |
| `unverified` | The receipt is malformed, its clock is invalid, or its software/deployment binding is stale. |

No private probe ID, deployment ID, queue-provider ID, OIDC token, bearer credential or raw response appears in the dashboard or debug download. A completed receipt does not prove bank authority, transfer settlement, personal financial eligibility or email receipt. It is deliberately not an activation-build prerequisite: activating money creates a deployment, while this setup action only runs with money off. A new deployment makes the previous receipt unverified instead of reusing it as fresh proof.

The initial delay means delivery cannot be expected during a thirty-second polling window. The dashboard may poll a small bounded number of overview reads over roughly two minutes, updating the test panel without clearing other evidence or edited form values. A manual refresh remains available after polling stops. No automatic repeated probe is scheduled.

## Offline verification and limits

The focused suites use synthetic policies, in-memory ledger/provider fixtures and injected readers. They exercise access gates, cookie tampering and expiry, origin/CSRF checks, body limits and timeouts, strict request schemas, unchanged machine-route authentication, provider-free simulations, exact settings CAS behavior, read-only diagnostics and response redaction.

```sh
node test/dashboard-access.test.mjs
node test/app-dashboard.test.mjs
```

These tests do not prove that Vercel protection is enabled, that the owner's real browser can enter, that cron passes the deployment perimeter, or that any bank or inbox accepts live operations. Those separate deployment checks remain necessary while money is disabled. The dashboard's offline simulation also does not verify personal Roth eligibility or complete outside contribution history.

Do not run the existing `scripts/rehearse-monthly.mjs` function inside a shared live request process: its deliberate temporary replacement of `globalThis.fetch` belongs in an isolated test process. The build reduces its actual successful result through `makeDashboardRehearsalReceipt` and writes `lib/generated-rehearsal.mjs`. That module is statically included in the server bundle. Runtime code only validates and projects the saved result; it never executes a rehearsal. Absent, malformed, future-dated or different-version receipts remain `not_run`. The receipt keeps five known scenario identifiers and statuses, zero-I/O counts, the software version, build-check time and full-result digest. Raw fixtures and scenario amounts are omitted.
