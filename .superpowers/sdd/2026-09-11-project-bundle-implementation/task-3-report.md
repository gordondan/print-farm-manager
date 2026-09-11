# Task 3 Report — Project-Bundle Import

## Implementation status

Implemented, uncommitted (per instruction to commit only if tests pass):

- Added idempotent nullable `parts.source_path` and `parts.source_relpath` migrations.
- Added `server/project-bundle.js` with schema-v1 archive validation, safe paths, duplicate-ID prevention, required-entry validation, supported slice extension checks, and authoritative `printer_models` validation.
- Added staged extraction through Task 1's `readEntryToFile`, then transactional draft-project, part, and G-code insertion. Any error removes staging and managed files; the SQLite transaction rolls back rows.
- Added `POST /api/project-bundles/import`, mounted after the existing runtime routers.
- Added integration coverage for nullable source fields, a two-part import with failure records, unknown models/rollback, and malformed bundle validation.

## Verification

- `node --check server/project-bundle.js`, `node --check server/routes/project-bundles.js`, and `node --check server/tests/project-bundles.test.js`: passed.
- ZIP validation smoke test using a deflated schema-v1 fixture: passed.
- `npm test -- --runInBand server/tests/project-bundles.test.js`: failed before executing the focused test body. The package script expands its configured `--testPathPatterns=server/tests`, so Jest ran the full server tree as well.

## Exact test blocker

The active runtime is Node `v25.3.0`, while this project declares Node `>=22.0.0 <24`. Every SQLite-backed suite, including `server/tests/project-bundles.test.js`, fails at `new Database(':memory:')` with:

```
Could not locate the bindings file ... better-sqlite3 ... node-v141-darwin-arm64/better_sqlite3.node
```

Attempting `npm rebuild better-sqlite3` also fails because this installed `better-sqlite3` version is incompatible with Node 25's V8 API. A Node 22 binary was available through `npx`, but the locally installed npm/node-gyp still targeted Node 25 during the rebuild.

No unrelated changes were modified. In particular, the pre-existing `docker-compose.yml` modification was left untouched.

## Fix round

Addressed the Task 3 review findings:

- Import extraction now explicitly permits entries up to 512 MiB and applies a 1 GiB total uncompressed-bundle limit. ZIP entry names must be safe and unique before staging begins.
- Staged `.3mf` slices now use the same `Metadata/plate_1.gcode` validation and operator-facing errors as regular G-code upload.
- Draft-project deletion now removes `server/projects/<project-id>` alongside its G-code records.
- Added coverage for >8 MiB artifacts, invalid `.3mf` plate layouts, source-file lifecycle deletion, archive-path traversal, and unknown models in failure records.

Fix-round verification:

- Node syntax checks passed for the importer, new `.3mf` validator, affected routes, and importer tests.
- A direct smoke test passed for extracting a deflated 9 MiB artifact through the 512 MiB import limit and for accepting a valid `.3mf` / rejecting a `plate_7`-only `.3mf`.
- `npx jest --runInBand server/tests/project-bundles.test.js` remains blocked before test bodies because the host's Node 25 runtime cannot load this repository's `better-sqlite3` binding. The test's `beforeEach` fails at `new Database(':memory:')`; this is the same Node-version mismatch documented above.

## Scoped re-review fix

- Added crafted central-directory regression coverage for the exact 512 MiB per-entry boundary, aggregate metadata over 1 GiB using three 400 MiB advertised entries, unsafe names, and duplicate names without allocating payloads.
- The exact-boundary test exposed an off-by-one in the importer; the per-entry check now rejects `>= 512 MiB` while retaining the existing 1 GiB aggregate limit.
- Node syntax checks and the standalone crafted-metadata checks pass.
- Focused Jest still cannot initialize SQLite on this host: all 17 tests fail in `beforeEach` with the missing `better-sqlite3` Node 25 binding. No Jest test body executes.

## Boundary correction

- Restored inclusive 512 MiB per-entry behavior (`>` comparison).
- Updated the crafted regression coverage to accept exactly 512 MiB and reject 512 MiB + 1 byte; the fixture changes only central-directory metadata and allocates no large payload.
- Syntax checks and the standalone inclusive/exclusive boundary checks passed.
- Focused Jest remains blocked before test bodies by the host's missing Node 25 `better-sqlite3` binding.
