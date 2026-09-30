# Task 1 implementation report

## Completed work

- Added Batch Slicer's standard-library project bundle writer in `project_bundle.py`.
- Added `BundlePart` and `BundleSlice` dataclasses, stable safe IDs derived from source-relative paths, deterministic manifest JSON, and ZIP entries for originals and slices.
- Added Print Farm Manager's `readEntryToFile(buf, name, destination, maxBytes)` helper. It validates archive entry names before creating destination directories or writing bytes, and reuses the existing bounded central-directory reader for malformed archives, unsupported compression, and size limits.

## TDD evidence

1. Python tests were added before the module existed. `python3 -m unittest tests/test_project_bundle.py -v` failed with `ModuleNotFoundError: No module named 'project_bundle'`.
2. After implementation, the focused Python tests passed. The full Batch Slicer suite also passed: 11 tests.
3. Jest tests were added before the export existed. After dependencies were made available, the requested npm command failed the new tests with `TypeError: readEntryToFile is not a function`.
4. After implementation, `npx jest --runInBand server/tests/zip-reader.test.js` passed: 1 suite, 2 tests.

## Environment notes

- The first manager test command could not find Jest because the checkout had incomplete local dependencies.
- A normal `npm ci` cannot complete under the host's Node 25 because this project is pinned to Node 22 or 23 and `better-sqlite3` has no compatible prebuild. `npm ci --ignore-scripts` installed Jest for the isolated ZIP tests. Full manager tests still require the project-supported Node version and a built `better-sqlite3` binding.
- `docker-compose.yml` was already modified and has trailing-whitespace diagnostics. It was left unchanged.

## Reviewer fix round

- Added ZIP metadata-integrity checks: stored and deflated entries must decompress to exactly the central-directory `uncompressedSize`. `readEntryToFile` receives only validated bytes and therefore never creates a destination for a mismatched entry.
- Added ZIP regression coverage for oversized entries, unsupported compression, malformed archives, and forged uncompressed-size metadata. All rejection tests verify no destination file is created.
- Added project-bundle validation for duplicate slice profile keys and duplicate derived archive paths within a part, before the output ZIP is opened. The regression test verifies duplicate profiles leave no output archive.
- TDD red run: the duplicate-profile Python test failed because the writer emitted a duplicate ZIP member, and the metadata-mismatch Jest test failed because `readEntry` returned forged data. The focused green run passed: Python 3 tests and Jest 6 tests.
