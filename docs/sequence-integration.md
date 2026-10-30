# Sequence integration and retirement

This document describes the reviewed monthly policy and its integration with
Sequence. It is not a live transfer plan, an activation instruction, or evidence
that a transfer has occurred.

**Cleanup status: provider deletion is pending.** The retirement manifest below
authorizes compatibility with the removal of obsolete resources; setting it
does not delete anything in Sequence or establish that deletion is complete.

## What runs where

Vercel runs the coordinator: it classifies Income receipts, maintains the durable
ledger, calculates allocations, checks evidence, and submits exact account-to-
account transfer requests to Sequence. Sequence supplies account and transfer
data and executes accepted requests. The monthly branch does not trigger the
four old native rules or route funds through the obsolete Pod.

All new monthly requests belong to the first day of the month in
`America/New_York`, beginning at 15:00 UTC. The daily reconciliation schedule
also observes accepted transfers and updates evidence; it does not create an
additional allocation day. See the [monthly policy](monthly-priority.md) for
the complete calculation and execution constraints.

| Funding pool | Reviewed allocation order |
| --- | --- |
| Eligible regular Income | Bills, General Spending, Emergency Fund, Roth IRA, Project Savings, then Personal Investment. |
| Eligible current-year windfalls, held until December 1 | Verified same-year Roth shortfalls, recorded Project shortfalls, then Personal Investment. |
| Emergency excess above its target | A separately recorded return to Income; cash is reusable only after settlement and reconciliation. |

Each ordinary allocation is a separate Income-to-destination transfer. The
ordered list is allocation priority, not a chain that moves cash from Bills to
General to Emergency. Known accepted transfers may settle concurrently, so
priority does not guarantee bank arrival order. Windfalls and unclassified
receipts remain separately reserved within Income; they are ledger categories,
not newly created Sequence Pods.

## What Sequence's native map shows

Sequence documents that an **active native rule has a solid line** on the map,
while an **inactive native rule has a dotted line**. Inactive rules retain their
configuration. See [Rule Settings](https://intercom.help/sequence/en/articles/12856829-rule-settings).
Dragging from one account to another is a documented way to create a native
rule; see [What are Rules?](https://intercom.help/sequence/en/articles/12830934-what-are-rules).

The current documented API and available connector tools provide accounts,
rules, transfers, and histories. They do not expose a nonexecuting canvas-edge
or annotation facility for an external coordinator's planned flows. The
accounts can remain on the map, and actual transfer progress is available in
account details and Transfer History. See
[How do Transfers Work?](https://intercom.help/sequence/en/articles/12831042-how-do-transfers-work)
and the [Sequence API reference](https://api.getsequence.io/platform/).

Do not create dummy or paused native rules solely to draw the coordinator's
flows. Those rules would retain executable financial instructions without
representing its income classification, annual contribution checks, or durable
reservations. A separate read-only policy visual can explain the reviewed
process; the authenticated coordinator status and plan reports describe current
evidence and proposals. A native rule simulation tests that native rule, not
the coordinator's monthly engine.

Removing the visible routing Pod also does not remove Sequence's internal
banking route: its transfer guide describes an internal holding account for
external-to-external transfers.

## Private retirement manifest

The optional `MONTHLY_SEQUENCE_RETIREMENT_JSON` environment variable is supported
only in monthly mode. It preserves the exact old resource IDs as audit
tombstones and records authorization to retire them. Historical identifiers
remain private even after the resources disappear from the map.

Its shape is:

```json
{
  "schemaVersion": 1,
  "authorizedAt": "ISO_8601_UTC_TIMESTAMP",
  "reference": "PRIVATE_AUTHORIZATION_REFERENCE",
  "podAccountId": "RETIRED_ROUTING_POD_UUID",
  "rules": {
    "payout": "OLD_POD_PAYOUT_RULE_UUID",
    "funding": "OLD_INCOME_ALLOCATION_RULE_UUID",
    "legacyGeneral": "OLD_GENERAL_TOP_UP_RULE_UUID",
    "excess": "OLD_EMERGENCY_EXCESS_RULE_UUID"
  }
}
```

These are explanatory placeholders, not deployable values. Use a valid UTC
authorization timestamp, a private evidence reference, and the exact existing
UUIDs. The manifest is not a replacement for the current account mappings,
financial policies, or activation evidence. It does not authorize a different
account, create a transfer, enable a rule, or switch financial execution on.

With the manifest, the evidence layer checks a complete, unfiltered rule
inventory and can recognize these outcomes for the mapped historical rules:

| Inventory outcome | Interpretation |
| --- | --- |
| `DISABLED` | The mapped rule still exists and is inactive; cleanup may still be pending. |
| `DELETED` | The provider explicitly identifies the mapped rule as deleted. |
| `ABSENT` | The mapped rule was not returned in the inventory. This alone does not prove deletion. |

Every inventory page must be read. Completing pagination proves completeness
within the deployed key's visible scope; it does not prove that scope covers
the whole organization. A key restricted to selected rules could omit a rule
that still exists. A failed individual lookup is also not sufficient evidence
of retirement.

Before initial activation, verify that the **existing** production key has
`READ_RULES` visibility over all rules and record
`activation_policy.sequenceAuthority.readAllRules: true`, alongside the existing
verified unattended-transfer, account-pair, and amount-limit proofs. The boolean
records an independently reviewed fact; it does not grant provider permission.
Do not request a replacement key merely for this cleanup. Any active rule that
could independently allocate the same funds must be resolved before activation.

## Cleanup order

1. **Deploy retirement compatibility while inactive.** Keep `APP_MODE=observe`
   and `LIVE_TRANSFERS_ENABLED=false`. Configure the reviewed private manifest,
   confirm the deployment reads the complete unfiltered visible inventory.
   Separately verify organization-wide rule visibility before financial activation.
   The compatibility deployment must precede
   deletion: the earlier implementation requires all mapped rules to exist and
   be disabled.
2. **Remove the four obsolete native rules through Sequence's supported
   dashboard controls.** The retired roles are Income allocation, Pod payout,
   legacy General top-up, and Emergency excess return. Verify their resulting
   inventory states. Do not enable them during cleanup.
3. **Remove the unused routing Pod after checking it is empty and has no pending
   activity or remaining dependency.** Sequence's documented procedure requires
   a $0 balance: open the Pod, use its three-dot menu, and choose **Delete Pod**.
   See [Adding and Deleting a Pod](https://intercom.help/sequence/en/articles/12856426-adding-and-deleting-a-pod).
   The published article does not specify rule-deletion cascade behavior, so
   verify rule retirement separately rather than relying on a cascade.
4. **Recheck the inactive deployment.** Confirm the intended resources are
   retired, retained account roles and private evidence remain valid, and the
   canonical deployment still reports financial execution disabled. Preserve
   the manifest and historical ledger. Finish the separate
   [activation prerequisites](activation.md) before enabling the coordinator.

The manifest and compatibility deployment make cleanup reviewable. Provider
deletion, activation readiness, and live financial execution are distinct
states; none should be inferred from the others.
