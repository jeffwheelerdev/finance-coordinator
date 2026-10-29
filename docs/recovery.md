# Source recovery

Recovery date: October 29, 2026.

The repository root now contains a complete, newly authored **0.3.0** runtime.
It uses verified provider contracts and the recovered design intent. It does not
represent a recovery of the five missing 0.2.1 files below. This page and the
source manifest preserve the historical recovery record; that missing export
does not prevent building the new implementation.

## Complete historical bundles

The two original source ZIPs were recovered and extracted. Their sanitized
source, meaningful tests, and per-file provenance are preserved in `archive/`.
The original ZIPs are not published because they include private configuration
and historical financial notes.

| Bundle | Published directory | Existing tests |
| --- | --- | ---: |
| `finance_automation_setup.zip` | `archive/decision-core/` | 36 |
| `finance_coordinator_deployed_source.zip` | `archive/observer-0.1.0/` | 31 |

Both original suites and both sanitized copies passed locally using synthetic
evidence or mocks. Archive provenance files contain the original archive and
source hashes, with a record of the publication transformations.

## Deployment observed during recovery: 0.2.1

That deployment's source tree has eight files. The source-export integration returns
only a truncated base64 prefix for five of them. Truncated files have not been
committed or represented as complete source.

| Source file | Recovery status |
| --- | --- |
| `lib/config.mjs` | Complete source recovered and SHA-1 verified; a synthetic configuration example is published. |
| `package.json` | Complete, byte-exact metadata recovered and SHA-1 verified. |
| `vercel.json` | Complete, byte-exact routing/scheduling metadata recovered and SHA-1 verified. |
| `api/index.mjs` | Complete source still required. |
| `lib/engine.mjs` | Complete source still required. |
| `lib/policy.mjs` | Complete source still required. |
| `lib/sequence.mjs` | Complete source still required. |
| `lib/store.mjs` | Complete source still required. |

Expected source hashes and publication transformations are recorded in
[`source-recovery.json`](source-recovery.json). A source-dashboard sign-in or a
complete owner-provided source export is required to finish the import through
the recovery routes currently available.

The recovered package version is `0.2.0`, while the configuration's exported
`VERSION` is `0.2.1`. The snapshot preserves that mismatch; it does not silently
alter the recovered source metadata.

## Completing the historical import, if desired

Match recovered source bytes against the expected deployment hashes. Keep
private source copies outside this public repository, then remove account and
rule identifiers from publishable code in favor of validated environment
configuration. Record that transformation separately from exact recovery.

Any subsequently recovered files belong in a clearly identified historical
snapshot, with their original hashes preserved. They must not overwrite the
new root runtime merely because filenames coincide. Historical test results
must not be presented as validation of either the missing original 0.2.1 code
or the separately authored 0.3.0 implementation.
