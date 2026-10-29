# Partial current-deployment snapshot

This directory preserves three fully recovered configuration/metadata files
from source version `0.2.1`. The five runtime implementation files are still
missing. **Do not deploy this directory.**

- `package.json` and `vercel.json` are the exact recovered bytes, checked against
  the deployment source hashes.
- `config.example.mjs` is a sanitized example derived from the recovered
  configuration. Its UUIDs are synthetic. Its numerical values are examples,
  not a live account mapping or personal financial plan.
- The package metadata retains its original `0.2.0` version, while the source
  configuration says `0.2.1`; this discrepancy is documented rather than hidden.

There are no application entry points or current-runtime tests here. See
[`../../docs/recovery.md`](../../docs/recovery.md) and
[`../../docs/source-recovery.json`](../../docs/source-recovery.json) for the
exact recovery status and expected hashes.
