# Verify alert email delivery while money stays disabled

The protected `POST /api/alerts/test` endpoint sends one fixed, clearly labeled setup email to the configured alert recipient. It is an explicit setup action: cron, builds, preview routes, and readiness checks never invoke it. The endpoint has no Sequence, financial ledger, policy writer, or critical-alert outbox dependency.

This check distinguishes **provider acceptance** from **receipt at the intended inbox**. Its response can establish the first fact; receipt must be checked separately before the private activation evidence can be marked verified.

## Configure the sender without exposing its credential

Resend's [Vercel Marketplace integration](https://resend.com/docs/guides/vercel-marketplace-integration) can provision the provider credential directly into the selected project's environment. Review the integration's current domain and account requirements before choosing that path. An existing Resend account can also use its [Vercel integration](https://resend.com/blog/vercel-integration) to connect a project. Keep the resulting `RESEND_API_KEY` in the runtime environment; it does not belong in the repository, request body, logs, or setup proof.

Use a sender permitted by the provider for ongoing critical alerts. Resend's [`onboarding@resend.dev` sender is restricted to testing and the Resend account's own email address](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain). A test using that address does not by itself establish that a different production sender is ready.

## Authorize one bounded test

Set the following values in the canonical production deployment. The gate values are literal strings, and both financial execution switches must stay off.

| Variable | Required value or purpose |
| --- | --- |
| `VERCEL_ENV` | `production`, supplied by Vercel |
| `FINANCE_CANONICAL_HOST` | The exact intended production hostname |
| `APP_MODE` | `observe` |
| `LIVE_TRANSFERS_ENABLED` | `false` |
| `CRON_SECRET` | The existing bearer credential used by protected routes |
| `RESEND_API_KEY` | The runtime-only provider credential |
| `ALERTS_EMAIL_TO` | The already authorized alert recipient; one address |
| `ALERTS_EMAIL_FROM` | The configured sender address, optionally with its supported display name |
| `ALERTS_SETUP_TEST_ENABLED` | `true` |
| `ALERTS_SETUP_TEST_ID` | A fresh UUIDv4 assigned to this authorized setup test |
| `ALERTS_SETUP_TEST_AUTHORIZED_AT` | The actual authorization time in UTC ISO format, for example `2030-01-01T14:00:00Z` |

The example date above is synthetic; use the actual authorization time. A future, invalid, or missing timestamp is rejected. Authorization expires at exactly 23 hours. Enabling the test flag alone sends nothing.

Invoke the canonical HTTPS endpoint explicitly, using the existing bearer credential through the calling environment's secret handling:

```http
POST /api/alerts/test
Authorization: Bearer <existing protected-route credential>
```

Send no request body or query parameters. The recipient, sender, subject, and message cannot be supplied by the caller. The Vercel rewrite `/api/index?route=alerts/test` uses the same authentication and safeguards; no other query parameter is accepted.

## Interpret the result and retry safely

A successful response has HTTP status `202` and includes:

```json
{
  "schemaVersion": 1,
  "status": "accepted",
  "code": "EMAIL_SETUP_PROVIDER_ACCEPTED",
  "provider": "resend",
  "providerAccepted": true,
  "recipientConfirmed": false,
  "deliveryId": "<provider message UUID>",
  "setupReference": "finance-email-setup-<opaque reference>",
  "requestHash": "<SHA-256 of the fixed request>",
  "authorizedAt": "<normalized authorization time>",
  "financialExecutionEnabled": false,
  "realTransfers": 0
}
```

The response omits the credential, addresses, and message body. `deliveryId` records provider acceptance; `setupReference` also appears in the email so the intended receipt can be matched exactly.

Each explicit invocation makes at most one provider POST. Retries use the same provider idempotency key and byte-identical message for the original test. [Resend retains idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys); the application accepts this setup authorization for only 23 hours so an authorized retry remains within that retention period.

Keep the original test ID, authorization time, sender, and recipient unchanged when retrying. A timeout, malformed accepted response, or lost connection returns an `unknown` outcome with `providerAccepted: null`; it does not establish failure to send. Inspect the provider record or intended inbox before authorizing a replacement test. Do not renew the timestamp or generate a new ID merely to bypass the original test's expiry or an uncertain result. A provider idempotency conflict also requires review. The application never retries automatically.

## Confirm receipt and finish the private evidence

Check that the actual intended inbox contains the exact setup reference with the configured sender and recipient, either through an authorized inbox read or the recipient's explicit acknowledgment. Provider acceptance alone and Resend's simulated test addresses do not prove that receipt. See [Resend's test-email documentation](https://resend.com/docs/dashboard/emails/send-test-emails).

Only after both acceptance and receipt are established, update the private `activation_policy.emailDelivery` record through the normal reviewed configuration process:

```json
{
  "status": "verified",
  "verifiedAt": "<actual verification time>",
  "reference": "<provider delivery ID and exact inbox-receipt evidence>",
  "provider": "resend",
  "recipient": "<same configured ALERTS_EMAIL_TO>",
  "sender": "<same configured ALERTS_EMAIL_FROM>",
  "providerAccepted": true,
  "recipientConfirmed": true
}
```

The surrounding activation policy's `updatedAt` must be at least as recent as `verifiedAt`. Keep addresses and proof references in that private source. The setup endpoint does not write this evidence or activate the coordinator. Readiness independently checks that the evidence matches the currently configured sender and recipient; changing either requires matching verification.

Disable `ALERTS_SETUP_TEST_ENABLED` after verification. Leave both financial execution switches off until the separate financial activation is authorized and all readiness checks pass.

## Verification in the repository

`test/email-setup.test.mjs` checks the fixed message, recipient restrictions, strict configuration, 23-hour authorization, idempotent retries, bounded provider responses, and uncertain delivery handling. `test/app-email-setup.test.mjs` checks canonical production authentication, POST-only routing, rewrite behavior, rejection of caller-controlled content, and the absence of financial, ledger, policy, or critical-outbox calls. All email requests in these tests use injected in-memory HTTP stubs.
