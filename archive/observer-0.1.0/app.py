"""Read-only Sequence webhook receiver. This release cannot move money.

Durable PostgreSQL storage is mandatory before acknowledging a webhook.
Only GET requests are implemented against the Sequence API. No rule-trigger,
transfer, account creation, or investment endpoint exists in this release.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http import HTTPStatus
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID
import hashlib
import hmac
import html
import json
import os
import time

VERSION = '0.1.0-observer'
MAX_BODY = 65_536
API_BASE = 'https://api.getsequence.io/platform/v1'
EVENT_PATHS = {'transfer': 'transfers', 'external_transaction': 'external-transactions'}
# Synthetic account IDs for archival tests; not a live account configuration.
ALLOWED_ACCOUNTS = frozenset({
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000006',
})
REQUIRED = ('SEQUENCE_API_KEY', 'SEQUENCE_WEBHOOK_SECRET', 'DATABASE_URL', 'CRON_SECRET')
DDL = """CREATE TABLE IF NOT EXISTS finance_observer_events (
 event_id UUID PRIMARY KEY,
 body_hash CHAR(64) NOT NULL,
 event_type TEXT NOT NULL,
 resource_id UUID NOT NULL,
 event_created_at TIMESTAMPTZ NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 observed_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 observation JSONB,
 last_error TEXT,
 needs_check BOOLEAN NOT NULL DEFAULT TRUE
)"""


class SetupRequired(Exception):
    pass


class EventConflict(Exception):
    pass


class ReadFailure(Exception):
    pass


def status() -> dict:
    configured = {name: bool(os.environ.get(name)) for name in REQUIRED}
    return {
        'service': 'finance-coordinator', 'version': VERSION,
        'mode': 'read_only_observation', 'money_movement_possible': False,
        'live_transfers_enabled': False,
        'configuration_present': configured,
        'connections_verified': False,
        'automatic_general_spending_topup': 'not_enabled',
        'bank_refund_matching': 'not_validated',
        'pending': [name for name, present in configured.items() if not present]
            + ['database connectivity test', 'signed webhook delivery test',
               'bank-posting correlation', 'bill-reserve policy',
               'live-action implementation and approval'],
    }


def verify_signature(secret: str, raw: bytes, header: str, now: int) -> bool:
    if not secret or len(header) > 512:
        return False
    try:
        parts = [part.strip().split('=', 1) for part in header.split(',')]
        if len(parts) != 2 or any(len(pair) != 2 for pair in parts):
            return False
        values = dict(parts)
        if set(values) != {'t', 'v1'}:
            return False
        timestamp = int(values['t'])
        if abs(now - timestamp) > 300:
            return False
        digest = hmac.new(secret.encode(), values['t'].encode() + b'.' + raw,
                          hashlib.sha256).hexdigest()
        return hmac.compare_digest(digest, values['v1'])
    except (ValueError, TypeError, UnicodeError):
        return False


def parse_event(raw: bytes, header_id: str) -> dict:
    event = json.loads(raw)
    if not isinstance(event, dict) or not isinstance(event.get('resource'), dict):
        raise ValueError('Invalid event')
    event_id = str(UUID(event['id']))
    if event_id != str(UUID(header_id)):
        raise ValueError('Event IDs differ')
    resource = event['resource']
    resource_id = str(UUID(resource['id']))
    kind = resource['type']
    if kind not in ('transfer', 'external_transaction', 'card_transaction'):
        raise ValueError('Unsupported resource')
    if event['type'] != kind + '.changed':
        raise ValueError('Event type mismatch')
    created = datetime.fromisoformat(event['created_at'].replace('Z', '+00:00'))
    if created.tzinfo is None:
        raise ValueError('Timestamp must be timezone-aware')
    return {'id': event_id, 'type': event['type'], 'kind': kind,
            'resource_id': resource_id, 'created_at': created,
            'body_hash': hashlib.sha256(raw).hexdigest()}


def connect_db():
    dsn = os.environ.get('DATABASE_URL', '')
    if urlparse(dsn).scheme not in ('postgres', 'postgresql'):
        raise SetupRequired('Database not configured')
    import psycopg  # Loaded only when durable storage is needed.
    return psycopg.connect(dsn, connect_timeout=5, sslmode='require',
                           options='-c statement_timeout=5000')


def store_event(event: dict) -> bool:
    with connect_db() as conn:
        conn.execute(DDL)
        result = conn.execute("""INSERT INTO finance_observer_events
          (event_id, body_hash, event_type, resource_id, event_created_at, needs_check)
          VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id""", (event['id'], event['body_hash'], event['type'],
          event['resource_id'], event['created_at'], event['kind'] in EVENT_PATHS)).fetchone()
        if result:
            return True
        old = conn.execute('SELECT body_hash FROM finance_observer_events WHERE event_id=%s',
                           (event['id'],)).fetchone()
        if old is None or old[0] != event['body_hash']:
            raise EventConflict('An event ID was reused with different content')
        return False


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_resource(kind: str, resource_id: str) -> dict:
    if kind not in EVENT_PATHS:
        raise ValueError('Unsupported read')
    resource_id = str(UUID(resource_id))
    key = os.environ.get('SEQUENCE_API_KEY', '')
    if not key:
        raise SetupRequired('Read-only API key required')
    request = Request(API_BASE + '/' + EVENT_PATHS[kind] + '/' + resource_id,
                      method='GET', headers={'Authorization': 'Bearer ' + key,
                      'Accept': 'application/json',
                      'x-called-reason': 'Read-only finance coordinator validation'})
    try:
        with build_opener(NoRedirects()).open(request, timeout=6) as response:
            raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ReadFailure('Response too large')
        record = json.loads(raw)['data']
        if not isinstance(record, dict) or record.get('id') != resource_id:
            raise ReadFailure('Response identity mismatch')
        return record
    except HTTPError as exc:
        # Do not expose upstream bodies, tokens or connection details.
        raise ReadFailure('HTTP_' + str(exc.code)) from None


def summarize(kind: str, record: dict) -> dict:
    if kind == 'transfer':
        source = (record.get('source') or {}).get('id')
        destination = (record.get('destination') or {}).get('id')
        allowed = source in ALLOWED_ACCOUNTS and destination in ALLOWED_ACCOUNTS
    else:
        allowed = record.get('accountId') in ALLOWED_ACCOUNTS
    if not allowed:
        return {'ignored': True, 'reason': 'outside_configured_accounts'}
    # Do not persist names, account numbers, descriptions or raw webhook bodies.
    return {'status': record.get('status'), 'mode': record.get('executionMode'),
            'source_id': (record.get('source') or {}).get('id'),
            'destination_id': (record.get('destination') or {}).get('id'),
            'account_id': record.get('accountId'),
            'rule_id': record.get('ruleId'), 'execution_id': record.get('ruleExecutionId'),
            'amount_cents': record.get('amountInCents'), 'direction': record.get('direction'),
            'completed_at': record.get('completedAt'),
            'bank_posting_verified': False}


def reconcile() -> dict:
    if not os.environ.get('SEQUENCE_API_KEY'):
        raise SetupRequired('Read-only API key required')
    with connect_db() as conn:
        conn.execute(DDL)
        rows = conn.execute("""SELECT event_id,event_type,resource_id
          FROM finance_observer_events WHERE needs_check AND next_check_at<=NOW()
          ORDER BY next_check_at,event_id LIMIT 3 FOR UPDATE SKIP LOCKED""").fetchall()
        for event_id, _, _ in rows:
            conn.execute("""UPDATE finance_observer_events SET next_check_at=NOW()+INTERVAL '2 minutes',
              attempts=attempts+1 WHERE event_id=%s""", (event_id,))
    observed, deferred = 0, 0
    for event_id, event_type, resource_id in rows:
        error = None
        observation = None
        pending = True
        try:
            observation = summarize(event_type.removesuffix('.changed'),
                read_resource(event_type.removesuffix('.changed'), str(resource_id)))
            pending = not observation.get('ignored', False) and observation.get('status') not in {
                'COMPLETE', 'FAILED', 'CANCELLED', 'APPROVAL_DENIED'}
            observed += 1
        except Exception as exc:
            # Never store arbitrary exception text: it could contain credentials.
            error = type(exc).__name__
            deferred += 1
        with connect_db() as conn:
            conn.execute("""UPDATE finance_observer_events SET observed_at=NOW(),
              observation=%s::jsonb,last_error=%s,needs_check=%s,
              next_check_at=NOW()+INTERVAL '6 hours' WHERE event_id=%s""",
              (json.dumps(observation), error, pending, event_id))
    return {'mode': 'read_only_observation', 'records_observed': observed,
            'records_deferred': deferred, 'transfers_requested': 0,
            'bank_posting_verified': False}


def reply(start_response, code: int, data, content_type='application/json'):
    body = (json.dumps(data, separators=(',', ':')) if content_type == 'application/json' else data).encode()
    start_response(f'{code} {HTTPStatus(code).phrase}', [
        ('Content-Type', content_type + '; charset=utf-8'), ('Content-Length', str(len(body))),
        ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
        ('X-Frame-Options', 'DENY'), ('Referrer-Policy', 'no-referrer'),
        ('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")])
    return [body]


def app(environ, start_response):
    method, path = environ.get('REQUEST_METHOD'), environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/api/health':
        return reply(start_response, 200, {'service': 'finance-coordinator',
            'version': VERSION, 'mode': 'read_only_observation', 'live_transfers_enabled': False})
    if method == 'GET' and path == '/api/status':
        return reply(start_response, 200, status())
    if method == 'GET' and path == '/':
        rows = ''.join('<li><code>' + html.escape(key) + '</code>: ' +
                       ('Configured; not yet verified' if value else 'Not configured') + '</li>'
                       for key, value in status()['configuration_present'].items())
        page = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finance coordinator | Setup</title><style>body{font:17px/1.6 system-ui;background:#f4f6f9;color:#172638;margin:0;padding:6vh 6vw}main{max-width:760px;margin:auto;background:white;padding:36px;border-radius:14px}h1{line-height:1.2}li{margin:12px 0}code{font-size:.86em}aside{border-left:4px solid #aa690c;padding:12px 18px;background:#fff7e8}</style>
<main><h1>Finance coordinator</h1><p><strong>Read-only setup deployment</strong></p><aside>This version cannot move money. Scheduled allocation rules and automatic General Spending funding are not activated by this service.</aside>
<h2>Configuration</h2><ul>''' + rows + '''</ul><h2>Before financial automation</h2><p>Connect durable storage and a read-only Sequence key. Configure signed webhook delivery, then validate transfer completion, bank-posting evidence, bill reserves and duplicate protection. Live execution requires a separately reviewed implementation and explicit approval.</p><p>Do not enter secrets on this page. Use Vercel project environment settings. Keep existing Sequence rules paused.</p></main></html>'''
        return reply(start_response, 200, page, 'text/html')
    if method == 'POST' and path == '/api/sequence-webhook':
        secret = os.environ.get('SEQUENCE_WEBHOOK_SECRET', '')
        if not secret:
            return reply(start_response, 503, {'error': 'webhook_secret_not_configured'})
        try:
            length = int(environ.get('CONTENT_LENGTH', '0'))
            if not 0 < length <= MAX_BODY:
                return reply(start_response, 413, {'error': 'invalid_body_size'})
            if environ.get('CONTENT_TYPE', '').split(';')[0].strip().lower() != 'application/json':
                return reply(start_response, 415, {'error': 'json_required'})
            raw = environ['wsgi.input'].read(length)
            if len(raw) != length:
                raise ValueError('Incomplete body')
            if not verify_signature(secret, raw, environ.get('HTTP_X_SEQUENCE_SIGNATURE', ''), int(time.time())):
                return reply(start_response, 401, {'error': 'invalid_signature'})
            event = parse_event(raw, environ.get('HTTP_X_SEQUENCE_EVENT_ID', ''))
        except (ValueError, TypeError, KeyError, AttributeError):
            return reply(start_response, 400, {'error': 'invalid_event'})
        try:
            inserted = store_event(event)
        except EventConflict:
            return reply(start_response, 409, {'error': 'event_identity_conflict'})
        except Exception:
            return reply(start_response, 503, {'error': 'durable_storage_unavailable'})
        return reply(start_response, 202, {'recorded': True, 'duplicate': not inserted,
                                         'mode': 'read_only_observation'})
    if method == 'GET' and path == '/api/reconcile':
        secret = os.environ.get('CRON_SECRET', '')
        supplied = environ.get('HTTP_AUTHORIZATION', '')
        if len(secret) < 32 or not hmac.compare_digest(supplied, 'Bearer ' + secret):
            return reply(start_response, 401, {'error': 'unauthorized'})
        try:
            return reply(start_response, 200, reconcile())
        except Exception:
            return reply(start_response, 503, {'error': 'observer_dependencies_unavailable'})
    return reply(start_response, 404, {'error': 'not_found'})
