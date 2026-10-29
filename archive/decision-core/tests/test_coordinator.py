import unittest, hashlib, hmac
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from coordinator_core import CycleEvidence, TransferEvidence, evaluate, verify_signature

NOW = datetime(2026,11,6,15,0,tzinfo=timezone.utc)
FINISHED = NOW - timedelta(hours=2)
SNAPSHOT = NOW - timedelta(hours=1)

def fixture():
    # Synthetic starting Income: 240000 cents; 10% emergency and 3% projects.
    # A 15000-cent routing refund leaves 223800 cents available in this example.
    ts = (
        TransferEvidence('fund', 'income', 'pod', 24000, 'COMPLETE', 'LIVE', 'fund-ex', FINISHED),
        TransferEvidence('project', 'income', 'project', 7200, 'COMPLETE', 'LIVE', 'fund-ex', FINISHED),
        TransferEvidence('emergency', 'pod', 'emergency', 9000, 'COMPLETE', 'LIVE', 'route-ex', FINISHED),
        TransferEvidence('refund', 'pod', 'income', 15000, 'COMPLETE', 'LIVE', 'route-ex', FINISHED, True),
    )
    return CycleEvidence('2026-11-01','fund-ex','EXECUTED',True,'EXECUTED',ts,('refund',),
        tuple(t.id for t in ts),('fund-ex','route-ex'),'income','pod',223800,200000,
        SNAPSHOT,SNAPSHOT,0,0,True,True,0,True,False,False)

class CoordinatorTests(unittest.TestCase):
    def test_ready_gap(self):
        d=evaluate(fixture(),NOW); self.assertEqual((d.state,d.planned_cents),('READY',50000))
    def test_small_source(self):
        self.assertEqual(evaluate(replace(fixture(),income_available_cents=10000),NOW).planned_cents,10000)
    def test_protected_bills(self):
        self.assertEqual(evaluate(replace(fixture(),protected_income_cents=210000),NOW).planned_cents,13800)
    def test_no_usable_cash(self):
        self.assertEqual(evaluate(replace(fixture(),protected_income_cents=300000),NOW).state,'REVIEW')
    def test_unknown_protection(self):
        self.assertEqual(evaluate(replace(fixture(),protected_income_cents=None),NOW).state,'WAIT')
    def test_no_refund_needed(self):
        e=fixture(); ts=e.transfers[:2]+(replace(e.transfers[2],amount_cents=24000),)
        e=replace(e,transfers=ts,refund_ids=(),expected_transfer_ids=tuple(t.id for t in ts),income_available_cents=208800)
        self.assertEqual(evaluate(e,NOW).state,'READY')
    def test_emergency_skipped(self):
        e=fixture(); ts=(e.transfers[1],)
        e=replace(e,routing_required=False,routing_status=None,transfers=ts,refund_ids=(),expected_transfer_ids=('project',),income_available_cents=232800)
        self.assertEqual(evaluate(e,NOW).state,'READY')
    def test_pending_refund(self):
        e=fixture(); ts=e.transfers[:-1]+(replace(e.transfers[-1],status='PROCESSING'),)
        self.assertEqual(evaluate(replace(e,transfers=ts),NOW).state,'WAIT')
    def test_bank_credit_not_confirmed(self):
        e=fixture(); ts=e.transfers[:-1]+(replace(e.transfers[-1],bank_posting_verified=False),)
        self.assertEqual(evaluate(replace(e,transfers=ts),NOW).state,'WAIT')
    def test_empty_pod_not_proof(self):
        self.assertEqual(evaluate(replace(fixture(),routing_status='IN_PROGRESS'),NOW).state,'WAIT')
    def test_funding_pending(self):
        self.assertEqual(evaluate(replace(fixture(),funding_status='IN_PROGRESS'),NOW).state,'WAIT')
    def test_failed_stage(self):
        self.assertEqual(evaluate(replace(fixture(),routing_status='PARTIAL'),NOW).state,'REVIEW')
    def test_simulation_cannot_authorize(self):
        e=fixture(); ts=(replace(e.transfers[0],mode='SIMULATION'),)+e.transfers[1:]
        self.assertEqual(evaluate(replace(e,transfers=ts),NOW).state,'REVIEW')
    def test_stale_snapshot(self):
        self.assertEqual(evaluate(replace(fixture(),income_snapshot_at=NOW-timedelta(days=2)),NOW).state,'WAIT')
    def test_snapshot_before_settlement(self):
        self.assertEqual(evaluate(replace(fixture(),income_snapshot_at=FINISHED),NOW).state,'WAIT')
    def test_missing_balance_date(self):
        self.assertEqual(evaluate(replace(fixture(),general_snapshot_at=None),NOW).state,'WAIT')
    def test_competing_transfer(self):
        self.assertEqual(evaluate(replace(fixture(),unexpected_pending_transfers=True),NOW).state,'WAIT')
    def test_rule_changed(self):
        self.assertEqual(evaluate(replace(fixture(),rules_match_approved_configuration=False),NOW).state,'REVIEW')
    def test_ambiguous_cycle(self):
        self.assertEqual(evaluate(replace(fixture(),ambiguous_cycle_linkage=True),NOW).state,'REVIEW')
    def test_completed_never_repeated(self):
        self.assertEqual(evaluate(replace(fixture(),prior_topup_state='COMPLETE'),NOW).state,'DONE')
    def test_pending_never_repeated(self):
        self.assertEqual(evaluate(replace(fixture(),prior_topup_state='IN_PROGRESS'),NOW).state,'WAIT')
    def test_unknown_post_result_review(self):
        self.assertEqual(evaluate(replace(fixture(),prior_topup_state='UNKNOWN'),NOW).state,'REVIEW')
    def test_same_cycle_same_key(self):
        self.assertEqual(evaluate(fixture(),NOW).intent_key,evaluate(fixture(),NOW).intent_key)
    def test_new_cycle_different_key(self):
        self.assertNotEqual(evaluate(fixture(),NOW).intent_key,evaluate(replace(fixture(),cycle_id='2026-11-15'),NOW).intent_key)
    def test_at_target(self):
        self.assertEqual(evaluate(replace(fixture(),general_available_cents=250000),NOW).state,'DONE')
    def test_over_target(self):
        self.assertEqual(evaluate(replace(fixture(),general_available_cents=300000),NOW).state,'DONE')
    def test_under_minimum(self):
        self.assertEqual(evaluate(replace(fixture(),general_available_cents=249950),NOW).planned_cents,0)
    def test_wrong_refund_account(self):
        e=fixture(); ts=e.transfers[:-1]+(replace(e.transfers[-1],source_id='unrelated'),)
        self.assertEqual(evaluate(replace(e,transfers=ts),NOW).state,'REVIEW')
    def test_missing_transfer(self):
        e=fixture(); self.assertEqual(evaluate(replace(e,transfers=e.transfers[:-1]),NOW).state,'WAIT')
    def test_pod_hold_unknown(self):
        self.assertEqual(evaluate(replace(fixture(),routing_hold_cents=None),NOW).state,'WAIT')
    def test_wrong_execution(self):
        e=fixture(); ts=e.transfers[:-1]+(replace(e.transfers[-1],execution_id='unrelated'),)
        self.assertEqual(evaluate(replace(e,transfers=ts),NOW).state,'REVIEW')
    def test_future_snapshot(self):
        self.assertEqual(evaluate(replace(fixture(),income_snapshot_at=NOW+timedelta(hours=1)),NOW).state,'WAIT')

class SignatureTests(unittest.TestCase):
    def signature(self,body=b'{"id":"x"}',ts=1000):
        return 't='+str(ts)+',v1='+hmac.new(b'test-secret',str(ts).encode()+b'.'+body,hashlib.sha256).hexdigest()
    def test_valid(self):
        self.assertTrue(verify_signature(b'test-secret',b'{"id":"x"}',self.signature(),1000))
    def test_modified_body(self):
        self.assertFalse(verify_signature(b'test-secret',b'{"id":"y"}',self.signature(),1000))
    def test_replay(self):
        self.assertFalse(verify_signature(b'test-secret',b'{"id":"x"}',self.signature(),1301))
    def test_malformed(self):
        self.assertFalse(verify_signature(b'test-secret',b'{}','bad',1000))

if __name__=='__main__': unittest.main()
