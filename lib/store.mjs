/** Private origin reads and atomic conditional writes for the single ledger. */
export const LEDGER_PATH = 'finance-v3/ledger.json';
export const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

export class StoreError extends Error {
  constructor(code = 'STORE_UNAVAILABLE') { super(code); this.name = 'StoreError'; this.code = code; }
}
export class StoreConflict extends StoreError {
  constructor() { super('STORE_CONFLICT'); this.name = 'StoreConflict'; }
}

function etag(value) {
  // Preserve the exact opaque version. A wildcard or weak/list condition cannot
  // establish that the particular state we read is still current.
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
      /[\r\n*,]/.test(value) || value.startsWith('W/')) throw new StoreError('STORE_ETAG_INVALID');
  return value;
}

function sanitize(error, creating = false) {
  if (error instanceof StoreError) return error;
  const name = error?.constructor?.name ?? error?.name;
  if (name === 'BlobPreconditionFailedError' || error?.name === 'BlobPreconditionFailedError' ||
      (creating && (['BlobAlreadyExistsError', 'BlobPathnameConflictError'].includes(name) ||
        /(?:already exists|precondition failed)/i.test(String(error?.message ?? ''))))) return new StoreConflict();
  return new StoreError();
}

async function boundedStream(stream) {
  if (!stream || typeof stream.getReader !== 'function') throw new StoreError('STORE_RESPONSE_INVALID');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, contents = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new StoreError('STORE_RESPONSE_INVALID');
      bytes += value.byteLength;
      if (bytes > MAX_LEDGER_BYTES) {
        void reader.cancel().catch(() => {});
        throw new StoreError('LEDGER_TOO_LARGE');
      }
      contents += decoder.decode(value, { stream: true });
    }
    return contents + decoder.decode();
  } finally { reader.releaseLock(); }
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('LEDGER_INVALID');
  return value;
}

export function createBlobStore({ token, getImpl, putImpl, timeoutMs = 20_000 } = {}) {
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) throw new StoreError('STORE_CONFIGURATION_REQUIRED');
  if ((getImpl !== undefined && typeof getImpl !== 'function') || (putImpl !== undefined && typeof putImpl !== 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000) throw new StoreError('STORE_CONFIGURATION_INVALID');
  let sdk;
  async function functions() {
    if (getImpl && putImpl) return { get: getImpl, put: putImpl };
    sdk ??= import('@vercel/blob');
    const imported = await sdk;
    return { get: getImpl ?? imported.get, put: putImpl ?? imported.put };
  }
  async function timed(operation, creating = false) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new StoreError('STORE_TIMEOUT')); }, timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), timeout]); }
    catch (error) { throw sanitize(error, creating); }
    finally { clearTimeout(timer); }
  }
  return {
    async read() {
      return timed(async (abortSignal) => {
        const { get } = await functions();
        const result = await get(LEDGER_PATH, { access: 'private', token, useCache: false, abortSignal });
        if (result === null) return null;
        if (result?.statusCode !== 200 || result.blob?.pathname !== LEDGER_PATH ||
            !Number.isSafeInteger(result.blob.size) || result.blob.size < 0 ||
            !/^application\/json(?:;|$)/i.test(result.blob.contentType ?? '')) throw new StoreError('STORE_RESPONSE_INVALID');
        if (result.blob.size > MAX_LEDGER_BYTES) {
          void result.stream?.cancel?.().catch(() => {});
          throw new StoreError('LEDGER_TOO_LARGE');
        }
        const version = etag(result.blob.etag);
        const text = await boundedStream(result.stream);
        let value;
        try { value = object(JSON.parse(text)); } catch { throw new StoreError('LEDGER_INVALID'); }
        return { value, etag: version };
      });
    },
    async compareAndSwap(expectedEtag, value) {
      if (expectedEtag !== null) etag(expectedEtag);
      // Snapshot before the first await: the exact committed bytes are the returned value.
      let contents, snapshot;
      try { contents = JSON.stringify(object(value)); snapshot = object(JSON.parse(contents)); }
      catch { throw new StoreError('LEDGER_INVALID'); }
      if (Buffer.byteLength(contents, 'utf8') > MAX_LEDGER_BYTES) throw new StoreError('LEDGER_TOO_LARGE');
      return timed(async (abortSignal) => {
        const { put } = await functions();
        const result = await put(LEDGER_PATH, contents, {
          access: 'private', token, contentType: 'application/json', addRandomSuffix: false,
          allowOverwrite: expectedEtag !== null, ...(expectedEtag === null ? {} : { ifMatch: expectedEtag }),
          cacheControlMaxAge: 60, abortSignal,
        });
        if (result?.pathname !== LEDGER_PATH) throw new StoreError('STORE_RESPONSE_INVALID');
        return { value: snapshot, etag: etag(result.etag) };
      }, expectedEtag === null);
    },
  };
}
