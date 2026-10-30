import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { BlobPreconditionFailedError, BlobError, get as sdkGet } from '@vercel/blob';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createBlobStore, StoreConflict, LEDGER_PATH, MAX_LEDGER_BYTES } from '../lib/store.mjs';

const token = 'synthetic-private-blob-token';
function reply(value = { schemaVersion: 1 }, overrides = {}) {
  const contents = JSON.stringify(value);
  return { statusCode: 200, stream: new Response(contents).body,
    blob: { pathname: LEDGER_PATH, size: Buffer.byteLength(contents), contentType: 'application/json', etag: '"version-1"' }, ...overrides };
}
function store({ getImpl = async () => reply(), putImpl = async () => ({ pathname: LEDGER_PATH, etag: '"version-2"' }), ...options } = {}) {
  return createBlobStore({ token, getImpl, putImpl, ...options });
}

test('private ledger reads bypass cache and preserve the exact ETag', async () => {
  let request;
  const result = await store({ getImpl: async (...args) => { request = args; return reply(); } }).read();
  assert.deepEqual(result, { value: { schemaVersion: 1 }, etag: '"version-1"' });
  assert.equal(request[0], LEDGER_PATH); assert.equal(request[1].access, 'private');
  assert.equal(request[1].useCache, false); assert.equal(request[1].token, token);
  assert.deepEqual(request[1].headers, { 'Accept-Encoding': 'identity' });
  assert.ok(request[1].abortSignal instanceof AbortSignal);
});

test('actual SDK origin reads request identity encoding and retain its strong version for the next conditional write', async () => {
  const originalDispatcher = getGlobalDispatcher(), mock = new MockAgent(), sdkToken = 'vercel_blob_rw_syntheticstore_private';
  const contents = JSON.stringify({ schemaVersion: 1, syntheticPadding: 'x'.repeat(4096) });
  const observed = [], writes = [];
  mock.disableNetConnect();
  mock.get('https://syntheticstore.private.blob.vercel-storage.com')
    .intercept({ path: `/${LEDGER_PATH}?cache=0`, method: 'GET' }).reply(options => {
    const headers = new Headers(options.headers), identity = headers.get('accept-encoding') === 'identity';
    assert.equal(headers.get('authorization'), `Bearer ${sdkToken}`);
    observed.push(identity);
    const data = identity ? contents : gzipSync(contents);
    return { statusCode: 200, data, responseOptions: { headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)),
      etag: identity ? '"strong-stored-version"' : 'W/"compressed-version"', ...(identity ? {} : { 'content-encoding': 'gzip' }) } } };
  }).times(2);
  setGlobalDispatcher(mock);
  try {
    // The SDK itself forwards the representation's validator unchanged. A read
    // without the transport preference reproduces the failing weak metadata.
    const compressed = await sdkGet(LEDGER_PATH, { access: 'private', token: sdkToken, useCache: false });
    assert.equal(compressed.blob.etag, 'W/"compressed-version"'); await compressed.stream.cancel();
    const s = createBlobStore({ token: sdkToken, getImpl: sdkGet, putImpl: async (...args) => {
      writes.push(args); return { pathname: LEDGER_PATH, etag: '"next-strong-version"' };
    } });
    const current = await s.read();
    assert.equal(current.etag, '"strong-stored-version"'); assert.deepEqual(current.value, JSON.parse(contents));
    const next = await s.compareAndSwap(current.etag, { ...current.value, reviewed: true });
    assert.equal(next.etag, '"next-strong-version"'); assert.deepEqual(observed, [false, true]);
    assert.equal(writes.length, 1); assert.equal(writes[0][2].ifMatch, '"strong-stored-version"');
    assert.equal(writes[0][2].allowOverwrite, true);
  } finally { setGlobalDispatcher(originalDispatcher); await mock.close(); }
});

test('an origin that still returns weak or missing metadata cannot weaken the financial CAS condition', async () => {
  for (const version of ['W/"private-weak-version"', '', undefined, '*', '"one","two"']) {
    let writes = 0;
    const s = store({ getImpl: async (_path, options) => {
      assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
      const response = reply(); response.blob.etag = version; return response;
    }, putImpl: async () => { writes++; return {}; } });
    await assert.rejects(s.read(), error => error.code === 'STORE_ETAG_INVALID' &&
      !String(error).includes('private-weak-version') && !String(error).includes(token));
    assert.equal(writes, 0);
  }
});

test('only an explicit missing object is treated as an empty ledger', async () => {
  assert.equal(await store({ getImpl: async () => null }).read(), null);
  await assert.rejects(store({ getImpl: async () => undefined }).read(), { code: 'STORE_RESPONSE_INVALID' });
  await assert.rejects(store({ getImpl: async () => { throw new Error(`404 ${token}`); } }).read(), { code: 'STORE_UNAVAILABLE' });
});

test('first write is create-only and later writes retain the original CAS condition', async () => {
  const calls = [], s = store({ putImpl: async (...args) => { calls.push(args); return { pathname: LEDGER_PATH, etag: '"next"' }; } });
  await s.compareAndSwap(null, { a: 1 }); await s.compareAndSwap('"previous"', { a: 2 });
  assert.equal(calls[0][2].allowOverwrite, false); assert.equal(Object.hasOwn(calls[0][2], 'ifMatch'), false);
  assert.equal(calls[1][2].allowOverwrite, true); assert.equal(calls[1][2].ifMatch, '"previous"');
  for (const [path, , options] of calls) {
    assert.equal(path, LEDGER_PATH); assert.equal(options.access, 'private'); assert.equal(options.addRandomSuffix, false);
    assert.equal(options.contentType, 'application/json'); assert.ok(options.abortSignal instanceof AbortSignal);
  }
});

test('actual SDK precondition errors are conflicts without a fallback write', async () => {
  let writes = 0;
  const s = store({ putImpl: async () => { writes++; throw new BlobPreconditionFailedError(); } });
  await assert.rejects(s.compareAndSwap('"old"', {}), StoreConflict); assert.equal(writes, 1);
});

test('SDK create-already-exists errors cannot become overwrites', async () => {
  let writes = 0;
  const s = store({ putImpl: async () => { writes++; throw new BlobError('This blob already exists'); } });
  await assert.rejects(s.compareAndSwap(null, {}), { code: 'STORE_CONFLICT' }); assert.equal(writes, 1);
});

test('unknown SDK details and credentials are redacted', async () => {
  const s = store({ putImpl: async () => { throw new Error(`secret ${token} account details`); } });
  await assert.rejects(s.compareAndSwap(null, {}), (error) => error.code === 'STORE_UNAVAILABLE' && !String(error).includes(token) && error.cause === undefined);
});

test('bad ETags cannot weaken an update condition', async (t) => {
  for (const value of ['', '*', 'W/"weak"', '"one","two"', 'bad\nheader', undefined]) {
    await t.test(String(value), async () => {
      let writes = 0;
      const s = store({ putImpl: async () => { writes++; return {}; } });
      await assert.rejects(s.compareAndSwap(value, {}), { code: 'STORE_ETAG_INVALID' }); assert.equal(writes, 0);
    });
  }
});

test('a success without an ETag is not a durable claim', async () => {
  await assert.rejects(store({ putImpl: async () => ({ pathname: LEDGER_PATH }) }).compareAndSwap(null, {}), { code: 'STORE_ETAG_INVALID' });
});

test('a write snapshots its input before awaiting the SDK', async () => {
  const value = { balance: 1 }; let release;
  const s = store({ putImpl: async (_path, text) => {
    await new Promise((resolve) => { release = resolve; });
    assert.equal(text, '{"balance":1}'); return { pathname: LEDGER_PATH, etag: '"v2"' };
  } });
  const pending = s.compareAndSwap(null, value);
  await new Promise((resolve) => setImmediate(resolve)); value.balance = 999; release();
  assert.deepEqual((await pending).value, { balance: 1 });
});

test('actual stream size is bounded even if advertised length is small', async () => {
  const large = reply({ text: 'x'.repeat(MAX_LEDGER_BYTES + 1) }); large.blob.size = 1;
  await assert.rejects(store({ getImpl: async () => large }).read(), { code: 'LEDGER_TOO_LARGE' });
});

test('oversized writes, invalid JSON, wrong path, and non-object ledgers fail closed', async () => {
  await assert.rejects(store().compareAndSwap(null, { text: 'x'.repeat(MAX_LEDGER_BYTES) }), { code: 'LEDGER_TOO_LARGE' });
  await assert.rejects(store({ getImpl: async () => reply({}, { stream: new Response('{broken').body }) }).read(), { code: 'LEDGER_INVALID' });
  await assert.rejects(store({ getImpl: async () => reply([]) }).read(), { code: 'LEDGER_INVALID' });
  const wrong = reply(); wrong.blob.pathname = 'other.json';
  await assert.rejects(store({ getImpl: async () => wrong }).read(), { code: 'STORE_RESPONSE_INVALID' });
});

test('timeout covers a stalled response body and an SDK that ignores abort', async () => {
  await assert.rejects(store({ timeoutMs: 10, getImpl: async () => reply({}, { stream: new ReadableStream({ start() {} }) }) }).read(), { code: 'STORE_TIMEOUT' });
  await assert.rejects(store({ timeoutMs: 10, putImpl: async () => new Promise(() => {}) }).compareAndSwap(null, {}), { code: 'STORE_TIMEOUT' });
});

test('two simultaneous initial claims cannot both succeed', async () => {
  let current = null;
  const s = store({ putImpl: async (_path, contents, options) => {
    if (current !== null && options.allowOverwrite === false) throw new BlobError('The blob already exists');
    current = contents; return { pathname: LEDGER_PATH, etag: '"created"' };
  } });
  const results = await Promise.allSettled([s.compareAndSwap(null, { owner: 1 }), s.compareAndSwap(null, { owner: 2 })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'STORE_CONFLICT').length, 1);
});
