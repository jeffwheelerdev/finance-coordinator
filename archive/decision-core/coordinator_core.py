"""Fail-closed decision logic for a synthetic Sequence allocation workflow.

This module does NOT make API calls or move money. The live adapter must collect
and validate bank evidence, use a durable transactional store, and invoke only
the approved General Spending rule after deployment and explicit go-live review.
Amounts are integer USD cents. Unknown evidence always blocks execution.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
import hashlib
import hmac

UTC = timezone.utc
# Deliberately synthetic example policy; not a recovered personal setting.
GENERAL_TARGET = 250_000
MIN_TRANSFER = 100
BAD_STATUSES = {'FAILED', 'PARTIAL', 'ERROR', 'INCOMPLETE', 'CANCELLED', 'APPROVAL_DENIED'}

@dataclass(frozen=True)
class TransferEvidence:
    id: str
    source_id: str
    destination_id: str
    amount_cents: int
    status: str
    mode: str
    execution_id: str
    completed_at: datetime | None
    # The adapter must establish this against the bank record, not infer it from
    # an equal amount, elapsed time, or an empty routing Pod.
    bank_posting_verified: bool = False

@dataclass(frozen=True)
class CycleEvidence:
    cycle_id: str
    funding_execution_id: str
    funding_status: str
    routing_required: bool
    routing_status: str | None
    transfers: tuple[TransferEvidence, ...]
    refund_ids: tuple[str, ...]
    expected_transfer_ids: tuple[str, ...]
    expected_execution_ids: tuple[str, ...]
    income_id: str
    routing_pod_id: str
    income_available_cents: int | None
    general_available_cents: int | None
    income_snapshot_at: datetime | None
    general_snapshot_at: datetime | None
    routing_available_cents: int | None
    routing_hold_cents: int | None
    bank_evidence_complete: bool
    # True only when pending bank debits and unrepresented commitments are
    # reconciled. A displayed available balance alone is not this evidence.
    commitments_reconciled: bool
    protected_income_cents: int | None
    rules_match_approved_configuration: bool
    unexpected_pending_transfers: bool
    ambiguous_cycle_linkage: bool
    prior_topup_state: str = 'NONE'
    prior_topup_requested_at: datetime | None = None

@dataclass(frozen=True)
class Decision:
    state: Literal['WAIT', 'REVIEW', 'READY', 'DONE']
    reason: str
    planned_cents: int = 0
    intent_key: str | None = None


def _aware(value: datetime | None) -> bool:
    return value is not None and value.tzinfo is not None


def evaluate(e: CycleEvidence, now: datetime) -> Decision:
    """Evaluate evidence, never execute. READY is necessary but not sufficient.

    The live adapter also needs a database claim for this cycle, a final fresh
    recheck, least-privilege credentials, and a reviewed execution mode.
    """
    if not _aware(now):
        raise ValueError('now must be timezone-aware')
    if not e.cycle_id or not e.funding_execution_id:
        return Decision('REVIEW', 'Missing cycle identity')
    if e.prior_topup_state == 'COMPLETE':
        return Decision('DONE', 'Top-up already completed for this cycle')
    if e.prior_topup_state in {'REQUESTED', 'IN_PROGRESS', 'APPROVAL_PENDING'}:
        return Decision('WAIT', 'Observe the existing top-up; do not send another')
    if e.prior_topup_state != 'NONE':
        # A timeout is not proof that a POST failed. Never blind-retry after
        # Sequence's 24-hour idempotency-retention window.
        return Decision('REVIEW', 'Reconcile prior attempt before another request')
    if not e.rules_match_approved_configuration:
        return Decision('REVIEW', 'A saved rule differs from the approved configuration')
    if e.ambiguous_cycle_linkage:
        return Decision('REVIEW', 'Cannot uniquely link routing to this allocation cycle')
    for status in (e.funding_status, e.routing_status):
        if status in BAD_STATUSES:
            return Decision('REVIEW', 'A preceding stage failed or only partly completed')
    if e.funding_status != 'EXECUTED':
        return Decision('WAIT', 'Initial percentage allocation has not completed')
    if e.routing_required and e.routing_status != 'EXECUTED':
        return Decision('WAIT', 'Emergency routing has not completed')
    if e.routing_available_cents is None or e.routing_hold_cents is None:
        return Decision('WAIT', 'Routing balance or hold status is unknown')
    if e.routing_available_cents != 0 or e.routing_hold_cents != 0:
        return Decision('WAIT', 'Routing Pod still contains funds or holds')
    if e.unexpected_pending_transfers:
        return Decision('WAIT', 'A competing or unexplained transfer remains pending')
    if len({t.id for t in e.transfers}) != len(e.transfers):
        return Decision('REVIEW', 'Duplicate evidence records')
    transfers = {t.id: t for t in e.transfers}
    if set(transfers) != set(e.expected_transfer_ids):
        return Decision('WAIT', 'Transfer evidence is incomplete or contains unrelated records')
    if not set(e.refund_ids).issubset(transfers):
        return Decision('WAIT', 'Refund record is missing')
    for t in e.transfers:
        if t.mode != 'LIVE':
            return Decision('REVIEW', 'Simulation evidence cannot authorize a live transfer')
        if t.execution_id not in e.expected_execution_ids:
            return Decision('REVIEW', 'Transfer belongs to another execution')
        if not isinstance(t.amount_cents, int) or t.amount_cents <= 0:
            return Decision('REVIEW', 'Invalid transfer amount')
        if t.status in BAD_STATUSES:
            return Decision('REVIEW', 'A transfer failed or was cancelled')
        if t.status != 'COMPLETE' or not _aware(t.completed_at):
            return Decision('WAIT', 'A transfer is not confirmed complete')
        if t.completed_at > now:
            return Decision('REVIEW', 'Completion timestamp is in the future')
    for refund_id in e.refund_ids:
        t = transfers[refund_id]
        if t.source_id != e.routing_pod_id or t.destination_id != e.income_id:
            return Decision('REVIEW', 'Refund does not match the approved account direction')
        if not t.bank_posting_verified:
            return Decision('WAIT', 'Refund has not been independently matched to a posted bank credit')
    if not e.bank_evidence_complete or not e.commitments_reconciled:
        return Decision('WAIT', 'Bank postings or remaining obligations are not reconciled')
    last_completed = max((t.completed_at for t in e.transfers), default=None)
    for ts in (e.income_snapshot_at, e.general_snapshot_at):
        if not _aware(ts):
            return Decision('WAIT', 'A dated bank-balance snapshot is missing')
        if ts > now or (now - ts).total_seconds() > 26 * 3600:
            return Decision('WAIT', 'Balance snapshot is stale or future-dated')
        if last_completed and ts <= last_completed:
            return Decision('WAIT', 'Balance must be refreshed after the preceding transfers')
    amounts = (e.income_available_cents, e.general_available_cents, e.protected_income_cents)
    if any(type(x) is not int for x in amounts):
        return Decision('WAIT', 'Income, General Spending or protected-money amount is unknown')
    if e.general_available_cents < 0 or e.protected_income_cents < 0:
        return Decision('REVIEW', 'Negative spending balance or invalid protected-money amount')
    gap = max(GENERAL_TARGET - e.general_available_cents, 0)
    usable = max(e.income_available_cents - e.protected_income_cents, 0)
    amount = min(gap, usable)
    if gap == 0:
        return Decision('DONE', 'General Spending is already at or above its target')
    if usable == 0:
        return Decision('REVIEW', 'No uncommitted Income funds are available for the top-up')
    if amount < MIN_TRANSFER:
        return Decision('DONE', 'Below documented $1 transfer minimum; leave until next cycle')
    # Binding cycle + funding execution ensures duplicate deliveries reuse the
    # same intent. A durable store must still enforce a UNIQUE constraint.
    key = hashlib.sha256((e.cycle_id + ':' + e.funding_execution_id + ':general-topup').encode()).hexdigest()
    return Decision('READY', 'Evidence supports a capped top-up', amount, key)


def verify_signature(secret: bytes, raw: bytes, signature: str, now_seconds: int) -> bool:
    """Sequence t=<unix-seconds>,v1=<HMAC-SHA256>; 5-minute replay window."""
    try:
        parts = dict(p.strip().split('=', 1) for p in signature.split(','))
        timestamp = int(parts['t'])
        if abs(now_seconds - timestamp) > 300:
            return False
        expected = hmac.new(secret, str(timestamp).encode() + b'.' + raw, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, parts['v1'])
    except (ValueError, KeyError, TypeError):
        return False
