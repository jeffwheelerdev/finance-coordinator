import io
import json
import os
import sys
import time
import hmac
import hashlib
import unittest
from unittest.mock import patch
from uuid import uuid4
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import app

SECRET = 'test-only-not-a-production-secret'

def payload(kind='transfer'):
    eid = str(uuid4())
    return eid, json.dumps({'id': eid, 'type': kind+'.changed',
        'resource': {'type':kind,'id':str(uuid4())},
        'created_at':'2026-10-29T19:00:00Z'}, separators=(',',':')).encode()

def sign(raw, timestamp=None):
    t = str(int(time.time()) if timestamp is None else timestamp)
    return 't='+t+',v1='+hmac.new(SECRET.encode(),t.encode()+b'.'+raw,hashlib.sha256).hexdigest()

def call(path, method='GET', raw=b'', extra=None):
    env={'REQUEST_METHOD':method,'PATH_INFO':path,'CONTENT_LENGTH':str(len(raw)),
         'CONTENT_TYPE':'application/json','wsgi.input':io.BytesIO(raw)}
    env.update(extra or {})
    result={}
    def start(status,headers): result.update(status=int(status.split()[0]), headers=dict(headers))
    result['body']=b''.join(app.app(env,start))
    return result

class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{},clear=True); self.env.start()
    def tearDown(self): self.env.stop()
    def signed(self, raw=None, eid=None, extra=None):
        if raw is None: eid,raw=payload()
        headers={'HTTP_X_SEQUENCE_SIGNATURE':sign(raw),'HTTP_X_SEQUENCE_EVENT_ID':eid}
        headers.update(extra or {})
        os.environ['SEQUENCE_WEBHOOK_SECRET']=SECRET
        return call('/api/sequence-webhook','POST',raw,headers)
    def test_health(self):
        r=call('/api/health'); self.assertEqual(r['status'],200)
        self.assertFalse(json.loads(r['body'])['live_transfers_enabled'])
    def test_setting_cannot_enable_money(self):
        os.environ['LIVE_TRANSFERS_ENABLED']='true'
        self.assertFalse(app.status()['money_movement_possible'])
    def test_no_trigger_endpoint(self): self.assertEqual(call('/api/trigger','POST')['status'],404)
    def test_no_secret(self): self.assertEqual(call('/api/sequence-webhook','POST',b'{}')['status'],503)
    def test_good_signature(self):
        _,raw=payload(); self.assertTrue(app.verify_signature(SECRET,raw,sign(raw),int(time.time())))
    def test_changed_body(self):
        _,raw=payload(); self.assertFalse(app.verify_signature(SECRET,raw+b' ',sign(raw),int(time.time())))
    def test_expired(self):
        _,raw=payload(); self.assertFalse(app.verify_signature(SECRET,raw,sign(raw,int(time.time())-301),int(time.time())))
    def test_future(self):
        _,raw=payload(); self.assertFalse(app.verify_signature(SECRET,raw,sign(raw,int(time.time())+301),int(time.time())))
    def test_duplicate_signature_parts(self):
        _,raw=payload(); self.assertFalse(app.verify_signature(SECRET,raw,sign(raw)+',t=1',int(time.time())))
    def test_id_mismatch(self):
        eid,raw=payload(); self.assertEqual(self.signed(raw,str(uuid4()))['status'],400)
    def test_type_mismatch(self):
        eid,raw=payload(); body=json.loads(raw); body['type']='external_transaction.changed'
        self.assertEqual(self.signed(json.dumps(body).encode(),eid)['status'],400)
    def test_missing_storage_is_not_acknowledged(self):
        self.assertEqual(self.signed()['status'],503)
    def test_valid_stored_event(self):
        with patch.object(app,'store_event',return_value=True) as mock:
            result=self.signed(); self.assertEqual(result['status'],202); self.assertEqual(mock.call_count,1)
    def test_duplicate_stored_event(self):
        with patch.object(app,'store_event',return_value=False):
            result=self.signed(); self.assertTrue(json.loads(result['body'])['duplicate'])
    def test_database_conflict(self):
        with patch.object(app,'store_event',side_effect=app.EventConflict()):
            self.assertEqual(self.signed()['status'],409)
    def test_storage_errors_do_not_leak(self):
        with patch.object(app,'store_event',side_effect=RuntimeError('secret-password')):
            r=self.signed(); self.assertEqual(r['status'],503); self.assertNotIn(b'secret-password',r['body'])
    def test_cron_without_secret(self): self.assertEqual(call('/api/reconcile')['status'],401)
    def test_cron_wrong_secret(self):
        os.environ['CRON_SECRET']='a'*40
        self.assertEqual(call('/api/reconcile',extra={'HTTP_AUTHORIZATION':'Bearer wrong'})['status'],401)
    def test_authenticated_cron_fails_closed(self):
        os.environ['CRON_SECRET']='a'*40
        self.assertEqual(call('/api/reconcile',extra={'HTTP_AUTHORIZATION':'Bearer '+'a'*40})['status'],503)
    def test_cron_mock(self):
        os.environ['CRON_SECRET']='a'*40
        with patch.object(app,'reconcile',return_value={'transfers_requested':0}):
            self.assertEqual(call('/api/reconcile',extra={'HTTP_AUTHORIZATION':'Bearer '+'a'*40})['status'],200)
    def test_oversize(self):
        self.assertEqual(self.signed(extra={'CONTENT_LENGTH':'65537'})['status'],413)
    def test_invalid_signature(self):
        self.assertEqual(self.signed(extra={'HTTP_X_SEQUENCE_SIGNATURE':'bad'})['status'],401)
    def test_unsupported_kind(self):
        with self.assertRaises(ValueError): app.read_resource('rules',str(uuid4()))
    def test_non_uuid_resource(self):
        with self.assertRaises(ValueError): app.read_resource('transfer','../../rules/trigger')
    def test_scope_filter(self):
        self.assertTrue(app.summarize('external_transaction',{'accountId':str(uuid4())})['ignored'])
    def test_posting_not_assumed(self):
        a=next(iter(app.ALLOWED_ACCOUNTS))
        self.assertFalse(app.summarize('external_transaction',{'accountId':a,'status':'COMPLETE'})['bank_posting_verified'])
    def test_secrets_not_in_status(self):
        os.environ['SEQUENCE_API_KEY']='secret-marker-value'
        self.assertNotIn('secret-marker-value',json.dumps(app.status()))
    def test_no_cache(self): self.assertEqual(call('/api/health')['headers']['Cache-Control'],'no-store')
    def test_home(self): self.assertIn(b'Read-only setup deployment',call('/')['body'])
    def test_invalid_json(self):
        self.assertEqual(self.signed(b'not json',str(uuid4()))['status'],400)
    def test_get_only_request(self):
        resource_id=str(uuid4()); os.environ['SEQUENCE_API_KEY']='test-key'
        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,*args): return json.dumps({'data':{'id':resource_id}}).encode()
        with patch.object(app,'build_opener') as opener:
            opener.return_value.open.return_value=Response()
            self.assertEqual(app.read_resource('transfer',resource_id)['id'],resource_id)
            req=opener.return_value.open.call_args.args[0]
            self.assertEqual(req.method,'GET')
            self.assertTrue(req.full_url.startswith(app.API_BASE+'/transfers/'))

if __name__=='__main__': unittest.main()
