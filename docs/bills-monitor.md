# Bills catalog monitoring

The coordinator reads a private Vercel Global Config catalog. A separate
scheduled ChatGPT task checks the owner's connected Finances records and
updates that catalog. The deployed function does not have direct access to the
ChatGPT Finances connector.

Monitoring and money movement are separate. A catalog update changes the next
eligible plan. It does not create a refund event, call Sequence, replay an
event, change activation gates, or withdraw excess cash from Bills.

## Source and forecast

`bills_catalog` is a versioned object validated by `parseBillCatalog` in
[`lib/bills.mjs`](../lib/bills.mjs). It contains stable bill IDs, positive integer
cent amounts, billing cadence, evidence, and optional renewal dates. It must
use `America/New_York` and schema version 1. The catalog contains derived
obligations, not bank statements, account credentials, or transaction history.

The calculator projects all twelve months of the current local calendar year
using current catalog rates. It does not average annual charges across months.
Known annual renewals occupy their renewal month; undated annual renewals are
conservatively placed together in the highest month. Weekly and biweekly bills
use calendar occurrence counts, including years with extra payments. The result
is a projection of the catalog, not a guarantee of maximum real-world spending.

```text
Bills target = ceiling(highest projected month in cents / 50,000) × 50,000
```

A peak exactly on a $500 boundary stays at that boundary. Uncertain obligations
remain included with a warning. An empty or malformed catalog cannot become a
zero-dollar target. Confirmed canceled renewals are excluded when their
effective date arrives, even if prepaid access continues.

## Monitoring contract

The scheduled task owns catalog writes. Do not run a second writer or edit the
same catalog concurrently. The Vercel connector supports atomic batch patches
but does not expose a compare-and-swap precondition. The execution ledger stays
in private Blob storage, which supplies the conditional writes and lease.

For each check:

1. Read the existing catalog, monitor metadata, and store digest through the
   authorized Vercel connector. Keep these records private.
2. Read linked-account coverage, recurring outflows, and saved financial
   corrections in Finances. Obtain supporting posted transactions or verified
   invoice information when needed. A completed query is not proof that every
   account is linked, that balances are current, or that every bill is captured.
3. Match evidence to an exact existing bill ID. Preserve every existing ID;
   never rebuild the catalog solely from the latest detected active streams.
   Missing payments, stale detections, or old cancellation-free descriptions
   cannot remove an obligation. Honor explicit cancellation records even when
   the bank's recurring detector still labels the stream active.
4. Prepare changes with `applyBillObservations` and the monitor helper. A
   matching posted charge can support a conservative increase. A decrease,
   cadence change, reactivation, or cancellation needs explicit user or provider
   evidence of the ongoing obligation. One lower utility invoice, a refund, or
   a partial payment cannot reduce a variable-bill allowance. A new bill needs
   an identified service, amount, cadence, and credible evidence; ambiguous
   charges are review items rather than invented obligations.
5. Recalculate with the same pure calculator used in production. Preserve the
   current catalog exactly if there is no material change. Never handwrite a
   target amount into the catalog or environment.
6. Immediately reread the store digest and relevant values before a write. If
   they changed, discard the prepared patch and rebuild it against the current
   catalog. Patch `bills_catalog` and `bills_monitor` in one batch. Verify the
   resulting values by reading them back before reporting success.
7. Report new material bill changes, cap changes, or issues needing input.
   Suppress unchanged reminders and successful heartbeat-only updates. Do not
   send messages to other people or modify banking rules, transfers, permissions,
   provider subscriptions, deployment code, environment gates, or the ledger.

Credit-card repayments and own-account movements are not additional bills when
their underlying purchases are already counted. Existing debt obligations need
their own verified treatment. A planned future cancellation is not a completed
cancellation. Unidentified services and accounts absent from Finances remain
explicit coverage gaps, not zero-cost items.

### Deterministic update preparation

Use the reviewed versions of `lib/bills.mjs`, `lib/bills-monitor.mjs`, and
`scripts/prepare-bills-update.mjs`. The helper uses only Node built-ins and does
not require a package install or any credentials. Keep input and output outside
the public repository:

```sh
node scripts/prepare-bills-update.mjs \
  --input /tmp/finance-monitor/private-input.json \
  --output /tmp/finance-monitor/private-output.json
```

The input object contains `catalog`, `monitor`, and `verifiedCoverage: true`,
plus optional `observations`, `additions`, `reviewCodes`, and an actual UTC
`now`. An observation has an exact `billId`, changed amount/schedule/status
fields, and evidence in the catalog schema. An addition is a complete, newly
verified expense record with a new stable ID. `reviewCodes` is the complete
current set; omit it to retain existing unresolved codes. Only set
`verifiedCoverage` after actually reading the available accounts, records and
corrections. It does not assert that unlinked accounts are covered.

The output includes `requiresWrite`, `shouldNotify`, `blocked`, the old and new
targets, a complete validated `catalog` and `monitor`, and an atomic `patch`
containing both configuration keys. With `--output`, stdout contains only a
summary. `expectedCatalogHash` and `expectedMonitorCheckedAt` identify the
snapshot used to prepare it; also compare the Vercel store digest immediately
before applying it. A false `requiresWrite` means no patch. A blocked result
must never be written. This CLI itself performs no network calls or writes to
Vercel.

The helper keeps an unchanged catalog byte-for-byte equivalent as a JSON value,
so repeated matching prices do not generate new revisions. It retains existing
IDs, validates additions, deduplicates review warnings by bill, and records a
bounded `writeHistory` in monitor metadata. When a confirmed future cancellation
becomes effective, the calculator can lower the cap without a catalog rewrite;
the execution ledger rejects any regression to an earlier projection date.

## Heartbeat and write limits

`bills_monitor` contains:

```json
{
  "schemaVersion": 1,
  "source": "chatgpt_finances",
  "status": "ok",
  "checkedAt": "2030-01-01T12:00:00.000Z",
  "catalogUpdatedAt": "2030-01-01T12:00:00.000Z",
  "reviewCodes": []
}
```

These dates are illustrative. A successful check uses its actual UTC time.
`checkedAt` records a review of available Finance records, not a claim that
every bank or provider has freshly synchronized. `catalogUpdatedAt` must exactly
match the validated catalog revision. Review codes preserve unresolved items
without falsely describing them as canceled or free.

The task can check hourly, but it writes only material changes and at most one
routine heartbeat per 24 hours. The preparation helper tracks a conservative
maximum of 90 writes in a rolling 30-day window; hitting that guard requires
attention rather than repeatedly attempting writes. This leaves room under the
current Hobby allowance of 100 writes per month. Reads and limits are described
in the official [Global Config limits](https://vercel.com/docs/global-config/global-config-limits).

If Finances cannot be read or coverage is insufficient to support a successful
review, retain the last good catalog and heartbeat and report the failure. Never
advance `checkedAt` to conceal a failed check. New financial submissions stop
after seven days without a successful heartbeat. An accepted transfer with a
known provider ID can still be observed during a catalog outage; it cannot be
replaced or retried without valid policy.

## Runtime reads and verification

The server reads both items together with `consistentRead: true`, fetch caching
disabled, and `staleIfError: false`. It validates the catalog and matching fresh
heartbeat before creating a new transfer plan. Runtime changes need no
deployment. The SDK contract is documented in the
[official package](https://github.com/vercel/storage/tree/main/packages/global-config).

Authenticated `GET /api/bills` exposes the forecast and current cap without
returning the bill catalog. `GET /api/status` and `/api/preflight` include
aggregate policy and monitoring metadata. Public health exposes configuration
booleans only. A passing health response does not establish fresh bank balances
or permission to execute an Income-to-Bills transfer.

The production build forces observation and disables Sequence financial POSTs.
Local tests exercise calculator boundaries, policy freshness, prioritization,
duplicate-event handling and uncertain outcomes using synthetic data.
