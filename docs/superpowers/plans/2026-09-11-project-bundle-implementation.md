# Project Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Batch Slicer export a versioned ZIP containing original STLs and uniquely named printer-ready slices, and make Print Farm Manager import that ZIP as a draft project.

**Architecture:** Batch Slicer owns discovery, slicing, unique artifact naming, estimates, and manifest creation. Print Farm Manager owns ZIP validation, managed storage, database creation, and project presentation. The manifest is the only cross-repository contract; each part maps one original STL to zero or more successful printer-profile artifacts.

**Tech Stack:** Python 3.12 standard library (`zipfile`, `json`, `pathlib`), OrcaSlicer CLI, Node.js 22, Express, better-sqlite3, React 18, Jest, and Supertest.

**Spec:** `docs/superpowers/specs/2026-09-11-stl-folder-import-design.md`

## Global Constraints

- The manager must remain compatible with Node `>=22.0.0 <24`.
- Imported projects start as `draft` and never dispatch jobs during import.
- Original STLs are retained for traceability; only sliced artifacts create G-code records.
- Bambu printer artifacts must remain `.3mf`; SV08 artifacts may remain `.gcode`.
- Incomplete bundles and failed slices must be reported clearly without partial database or filesystem state.
- Preserve unrelated existing worktree changes, especially `docker-compose.yml`.

---

### Task 1: Define and test the shared manifest and archive layout

**Files:**
- Create: `/Users/gordon/projects/BatchSlicer/project_bundle.py`
- Test: `/Users/gordon/projects/BatchSlicer/tests/test_project_bundle.py`
- Modify: `/Users/gordon/projects/print-farm-manager/server/zip-reader.js`
- Test: `/Users/gordon/projects/print-farm-manager/server/tests/zip-reader.test.js`

**Interfaces:**
- Batch Slicer produces `manifest.json` with `schema_version`, `project_name`, `source_root`, `parts`, and `profiles`.
- Each part has `id`, `name`, `source_relpath`, and `slices`; each slice has `profile_key`, `printer_model`, `filename`, `archive_path`, `parts_per_plate`, `est_print_secs`, and `material_grams`.
- The archive contains `manifest.json`, `originals/<source_relpath>`, and `slices/<profile_key>/<part-id>.<ext>`.
- The manager ZIP helper exports `readEntryToFile(buf, name, destination, maxBytes)` and rejects path traversal, oversized entries, unsupported compression, and malformed archives.

- [ ] **Step 1: Write failing Python tests** for deterministic manifest serialization, source-relative paths, safe part IDs, and ZIP entries for originals and slices.
- [ ] **Step 2: Run `python3 -m unittest tests/test_project_bundle.py -v` and confirm failure because the bundle module is absent.**
- [ ] **Step 3: Implement the manifest dataclasses and `write_bundle(path, project_name, source_root, parts, profiles)` using only the standard library.**
- [ ] **Step 4: Run the focused Python tests and confirm they pass.**
- [ ] **Step 5: Write failing Jest tests for extracting a deflated entry to a destination and rejecting `../escape.stl`.**
- [ ] **Step 6: Run `npm test -- --runInBand server/tests/zip-reader.test.js` and confirm the new export is missing.**
- [ ] **Step 7: Implement bounded ZIP entry extraction using the existing central-directory reader and `zlib`, writing only after validation.**
- [ ] **Step 8: Run the focused Jest tests and commit both repositories separately.**

### Task 2: Make Batch Slicer produce unique per-part slice artifacts

**Files:**
- Modify: `/Users/gordon/projects/BatchSlicer/batch_slice.py`
- Modify: `/Users/gordon/projects/BatchSlicer/batch_slicer_app.py`
- Modify: `/Users/gordon/projects/BatchSlicer/tests/test_batch_slice.py`
- Modify: `/Users/gordon/projects/BatchSlicer/tests/test_project_bundle.py`

**Interfaces:**
- `SliceResult` gains the actual produced artifact path when slicing succeeds.
- `run_batch` writes each job to a unique job directory or renames `plate_1.gcode` immediately, so no profile run can overwrite another model’s output; Bambu profiles additionally export a sliced `.3mf` with Orca’s `--export-3mf` option.
- `export_project_bundle(input_path, output_bundle, project_name, profiles, orca, jobs, arrange, recursive)` runs the batch, packages all originals and successful artifacts, and returns a summary including failed slices.

- [ ] **Step 1: Add a failing test asserting two models in one profile produce two distinct artifact paths.**
- [ ] **Step 2: Run the focused Batch Slicer tests and confirm the current shared `plate_1.gcode` behavior fails the assertion.**
- [ ] **Step 3: Change the runner to allocate `output_root/<profile-key>/<stable-part-id>/` per model, capture `plate_1.gcode`, and request a sliced `.3mf` for Bambu profiles.**
- [ ] **Step 4: Run all Batch Slicer tests and confirm unique output behavior passes without regressing dry-run or cancellation behavior.**
- [ ] **Step 5: Add a failing test for an exported bundle containing originals, successful slices, and explicit failure entries.**
- [ ] **Step 6: Implement the export orchestration through `project_bundle.write_bundle`, preserving per-profile printer metadata and estimates where available.**
- [ ] **Step 7: Add a GUI “Export project bundle…” action with a project-name and destination flow, and show the output path plus failed-slice count on completion.**
- [ ] **Step 8: Run Python unit tests and manually export a small three-STL fixture.**
- [ ] **Step 9: Commit the Batch Slicer exporter changes.**

### Task 3: Add transactional project-bundle import to the manager

**Files:**
- Modify: `/Users/gordon/projects/print-farm-manager/server/db.js`
- Create: `/Users/gordon/projects/print-farm-manager/server/project-bundle.js`
- Create: `/Users/gordon/projects/print-farm-manager/server/routes/project-bundles.js`
- Modify: `/Users/gordon/projects/print-farm-manager/server/index.js`
- Test: `/Users/gordon/projects/print-farm-manager/server/tests/project-bundles.test.js`

**Interfaces:**
- `importProjectBundle(db, archivePath)` validates the manifest and files, creates managed files under `server/projects/<project-id>/originals` and `server/gcode`, and returns the created project.
- `POST /api/project-bundles/import` accepts multipart field `file` with a ZIP archive and returns `201 { project, parts, failures }`.
- Parts store `source_path` and `source_relpath`; G-code rows use the manifest’s `printer_model`, `parts_per_plate`, estimates, and managed filepath.

- [ ] **Step 1: Add failing migration/API tests for nullable part source columns and a successful two-part import.**
- [ ] **Step 2: Run `npm test -- --runInBand server/tests/project-bundles.test.js` and confirm the route and columns are absent.**
- [ ] **Step 3: Add idempotent `ALTER TABLE parts ADD COLUMN source_path` and `source_relpath` migrations.**
- [ ] **Step 4: Implement manifest validation: exact schema version, safe relative paths, unique part IDs, existing archive entries, supported slice extensions, known printer models, and non-empty parts.**
- [ ] **Step 5: Implement staging into a temporary directory, then a database transaction that inserts the draft project, parts, and G-code rows.**
- [ ] **Step 6: On any failure, remove staging and managed files and ensure no project/part/G-code rows remain.**
- [ ] **Step 7: Mount the route after the existing runtime routers and run focused plus full manager tests.**
- [ ] **Step 8: Commit the manager import implementation.**

### Task 4: Add the manager UI and source-artifact visibility

**Files:**
- Modify: `/Users/gordon/projects/print-farm-manager/client/src/pages/Projects.jsx`
- Modify: `/Users/gordon/projects/print-farm-manager/client/src/pages/Projects.css` if required by the existing layout
- Test: `/Users/gordon/projects/print-farm-manager/client/src/pages/Projects.test.jsx` if the repository’s client test setup supports it; otherwise cover behavior through API tests and a production build.

**Interfaces:**
- Projects page provides an “Import sliced project” file picker accepting the Batch Slicer ZIP.
- Successful import refreshes projects and opens the returned draft project.
- Part detail shows the preserved relative STL path, imported printer profiles, and a clear “upload/import does not activate this project” message.

- [ ] **Step 1: Add the import control and error-state test or an equivalent API-backed UI fixture.**
- [ ] **Step 2: Run the focused client check and confirm the control is absent.**
- [ ] **Step 3: Implement multipart upload, progress/disabled state, success refresh, and actionable validation errors.**
- [ ] **Step 4: Render source-relative paths and slice-failure information in the project detail view.**
- [ ] **Step 5: Run `npm run build` and the full test suite.**
- [ ] **Step 6: Commit the UI changes.**

### Task 5: End-to-end RC Loader verification

**Files:**
- No source changes expected; use `/Users/gordon/projects/RC Loader/rc-wheel-loader-diy-model_files` and a fresh temporary bundle/output path.

- [ ] **Step 1: Export a small three-STL RC Loader bundle and inspect `manifest.json` plus archive entries.**
- [ ] **Step 2: Export the full RC Loader bundle, confirming each model/profile has a unique artifact or an explicit failure record.**
- [ ] **Step 3: Import the bundle through the local manager API and verify one draft project and one part per STL.**
- [ ] **Step 4: Verify P1S artifacts are accepted as `.3mf` and SV08 artifacts as `.gcode`; do not activate or dispatch the project.**
- [ ] **Step 5: Record counts and paths in the final handoff, including any slice failures.**
