# Batch Slice in Print Garden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Integrate Batch Slicer into Print Garden with browser and Mac-folder inputs, web-managed profiles, a Mac Orca worker, and draft project creation.

**Architecture:** Port the Python slicing engine and bundle writer into `garden/`, add a persistent garden API queue, and have one Mac worker process both label and batch jobs. The web UI imports completed bundles through the existing project-bundle endpoint.

**Tech Stack:** React 18, Express, Node.js 22, Python 3 standard library, OrcaSlicer CLI, existing Print Garden project-bundle importer.

**Spec:** `docs/superpowers/specs/2026-10-07-batch-slice-in-print-garden-design.md`

**Status:** Implemented on the `development` branch. The repository backup and restore code already discovers live table columns, so the additive `bundle_import_key` column needs no special backup code. Tests and builds were not run for this implementation pass.

## Global Constraints

- Keep Node at `>=22 <24`.
- Keep garden API routes under `/garden`; keep new React components under `client/src/garden/`.
- Keep queue and profile data in a dedicated garden data directory, not `farm.db`.
- OrcaSlicer runs only on the Mac worker.
- Use the same authentication and access policy as Print Garden; worker-only routes require worker credentials.
- Resolve model and preset paths only inside configured roots; do not execute shell command strings.
- Imported Batch Slice projects start as drafts and preserve originals, successful slices, and failures.
- Maintain the existing Labels workflow while moving its slicer work onto the integrated worker.

## Review Focus

- Absolute paths, `..`, and symlink escapes from a Mac folder selection must be rejected by the worker.
- Empty uploads, unsupported model extensions, duplicate relative paths, and oversized batches must fail before queueing.
- A missing preset or unregistered printer model must fail validation before any model starts slicing.
- Cancellation during an active Orca process must terminate it, record completed and cancelled slices, and import a partial draft project.
- A worker restart after bundle import but before job completion must reuse the import key and return the original project rather than create a duplicate.

---

### Task 1: Port the slicing engine and bundle writer

**Files:**
- Create: `garden/batch_slice/__init__.py`
- Create: `garden/batch_slice/engine.py`
- Create: `garden/batch_slice/project_bundle.py`

**Interfaces:**
- `Profile`: `key`, `printer_model_id`, `machine`, `process`, `filaments`, and `extra` fields.
- `find_models(input_path: Path, recursive: bool = False) -> list[Path]` accepts one supported file or a source folder.
- `run_batch(input_path, output_root, profiles, orca, *, jobs, arrange, recursive, dry_run, stop_event, callback) -> BatchSummary` reports plan, start, and result events.
- `export_project_bundle(input_path, output_bundle, project_name, profiles, orca, jobs, arrange, recursive, *, stop_event, callback) -> BatchSummary` writes the existing schema version 1 bundle format.
- Preserve support for STL, 3MF, OBJ, STEP, and STP inputs; preserve `.3mf` Bambu slices and `.gcode` non-Bambu slices.

- [ ] **Step 1: Port `Profile`, `SliceResult`, `BatchSummary`, `find_models`, command construction, and the cancellable runner** from `~/projects/BatchSlicer/batch_slice.py`; add an explicit printer model ID to each profile.
- [ ] **Step 2: Port the version 1 archive writer** from `~/projects/BatchSlicer/project_bundle.py` and make it importable from the new package.
- [ ] **Step 3: Commit** the integrated Python engine.

### Task 2: Add Batch Slice queue, profiles, and worker capabilities API

**Files:**
- Create: `garden/batch-slice/server.cjs`
- Modify: `garden/index.js`

**Interfaces:**
- Mount at `/garden/api/batch-slice`.
- `GET /status` returns worker heartbeat, Orca availability, approved source-folder choices as stable IDs and display names, and available preset IDs.
- `GET /profiles` and `PUT /profiles` read and write profile definitions in the garden data directory.
- `POST /worker/heartbeat` accepts worker credentials and updates capabilities; `GET /worker/config` returns profile definitions, source-folder IDs mapped to local roots, and preset roots to an authenticated worker.
- `POST /jobs` accepts `meta` plus model files and returns `201 { job }`.
- `GET /jobs`, `GET /jobs/:id`, `POST /jobs/claim`, `GET /jobs/:id/files/:index`, `POST /jobs/:id/progress`, and `POST /jobs/:id/cancel` support history, worker processing, progress, and cancellation.
- Browser routes use the application's existing authentication boundary. Worker routes require `Authorization: Bearer <PRINTGARDEN_WORKER_TOKEN>`.
- Persist jobs and staged uploads beneath `GARDEN_BATCH_SLICE_DIR` or `server/data/garden/batch-slice` by default. Retain at most 50 completed job summaries and remove staged models and bundles after completion.

- [ ] **Step 1: Implement disk-backed job state and upload validation** with normalized filenames, allowed extensions, configurable per-file and total limits, and bounded history.
- [ ] **Step 2: Implement profile CRUD and worker capability endpoints**; reject malformed profiles and unknown printer model IDs using `server/db`'s registered model list.
- [ ] **Step 3: Implement worker claim, staged-file download, progress, cancellation, and stale-claim handling** with worker-token authentication.
- [ ] **Step 4: Mount the queue under `/garden/api/batch-slice`** without adding database schema or colliding with existing routes.
- [ ] **Step 5: Commit** the Batch Slice API.

### Task 3: Make project-bundle import idempotent for worker retries

**Files:**
- Modify: `server/db.js`
- Modify: `server/project-bundle.js`
- Modify: `server/routes/project-bundles.js`
- Modify: `server/routes/backup.js`

**Interfaces:**
- `importProjectBundle(db, archivePath, { idempotencyKey, projectsDir, gcodeDir })` returns the created project for a new key and the existing project for a previously committed key.
- `POST /api/project-bundles/import` accepts an optional `Idempotency-Key` header and returns the existing project when that key was already imported.
- Add nullable `projects.bundle_import_key` with a unique partial index for non-null values. Existing bundle imports without a key retain current behavior.

- [ ] **Step 1: Add the nullable column and unique partial index** using the repository's additive migration pattern.
- [ ] **Step 2: Store the idempotency key in the same transaction as project creation** and return the existing imported project and parts when the key already exists.
- [ ] **Step 3: Forward the optional request header from the route** and preserve existing import behavior when it is absent.
- [ ] **Step 4: Update backup export and restore to include the new column.**
- [ ] **Step 5: Commit** the idempotent project-bundle import.

### Task 4: Integrate both slicer workflows into one Mac worker

**Files:**
- Create: `garden/slicer/worker.py`
- Create: `garden/slicer/labels.py`
- Create: `garden/slicer/printgarden_add.py`
- Modify: `garden/labels/worker/install.sh`
- Modify: `garden/labels/server.cjs`

**Interfaces:**
- `worker.py` claims queued Labels and Batch Slice work sequentially and uses one `PRINTGARDEN_WORKER_TOKEN`.
- `process_batch_slice(job)` resolves either staged uploads or a relative path beneath an approved source root, calls `export_project_bundle`, and posts the bundle to `POST /api/project-bundles/import`.
- Batch bundle imports send `Idempotency-Key: batch-slice:<job id>`.
- `process_label_job(job)` preserves the current plate queue behavior and uses the integrated engine/profile definitions instead of `~/projects/BatchSlicer` and the external `printgarden_add.py` skill path.
- Running jobs report progress and per-model/profile logs; cancellation terminates the active Orca process and records remaining work as cancelled.
- `install.sh` replaces the old launchd label worker with `com.dagordons.garden-slicer-worker` and preserves restart behavior and logs.
- Worker environment variables are `PRINTGARDEN_URL`, `PRINTGARDEN_WORKER_TOKEN`, `PRINTGARDEN_SOURCE_ROOTS`, `ORCA_PRESET_ROOTS`, and `ORCA_PATH`.

- [ ] **Step 1: Implement source and preset resolution** using stable IDs from the queue API; reject paths outside worker-configured roots.
- [ ] **Step 2: Implement Batch Slice processing** using Task 1's engine and Task 2's queue endpoints; import the result as a draft and persist the project ID.
- [ ] **Step 3: Move the label helper into the repository** and update it to use the integrated engine and profile API while preserving current project naming, `parts_per_plate`, and activation behavior.
- [ ] **Step 4: Implement fair sequential polling for both queues** so a continuous queue of one type cannot starve the other.
- [ ] **Step 5: Update the launchd installer** to install one slicer worker and safely unload the previous label-only agent.
- [ ] **Step 6: Commit** the integrated Mac worker.

### Task 5: Build the Batch Slice web page and navigation

**Files:**
- Create: `client/src/garden/BatchSlice.jsx`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Add a nested **Batch Slice** navigation link beneath **Labels** and route `/batch-slice` to `BatchSlice`.
- The page uses `/garden/api/batch-slice` for worker status, profiles, source folders, job creation, history, progress, and cancellation.
- Upload mode accepts supported files and directory selection with preserved relative paths.
- Mac-folder mode only offers worker-advertised relative folders.
- Profile controls manage output key, printer model, machine/process/filament preset selections, optional argument list, and enabled state.
- Batch controls include project name, parallel job count, arrange, recursive scan, dry run, start, and cancel.

- [ ] **Step 1: Add the nested navigation item and route** while preserving the current Labels iframe and mobile navigation behavior.
- [ ] **Step 2: Implement worker status, profile management, upload and folder selection, and job submission** against Task 2's API.
- [ ] **Step 3: Implement polling for progress and job history**, render per-model/profile result states and logs, and link completed jobs to Projects.
- [ ] **Step 4: Implement dry-run preview and cancel controls** with clear queued, running, cancelled, failed, and completed states.
- [ ] **Step 5: Commit** the Batch Slice page.

### Task 6: Document deployment and integrate the release

**Files:**
- Modify: `garden/README.md`
- Modify: `garden/labels/README.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docker-compose.yml` if a new persistent data mount is required

**Interfaces:**
- Document the page route, API, worker token, source-root configuration, preset-root configuration, profile setup, launchd installation, supported inputs, and draft-project result.
- Keep all queue data on the persistent data volume and leave `farm.db` schema unchanged.
- The existing label workflow and the new Batch Slice workflow share one Mac worker installation.

- [ ] **Step 1: Write deployment docs** for worker environment variables, allowed folders, preset roots, authentication boundary, and launchd install/update.
- [ ] **Step 2: Add a dated changelog entry** describing the integrated Batch Slice page and Mac worker.
- [ ] **Step 3: Update Docker volume wiring only if the default queue directory is not already persistent.**
- [ ] **Step 4: Commit** deployment docs and integration wiring.

## Execution order

Run Tasks 1 and 2 in order because the worker depends on their engine and API contracts. Task 3 makes project import retries idempotent before Task 4 invokes the importer. Task 4 depends on Tasks 1 through 3. Task 5 can start after the Task 2 endpoint contract is stable and finish against Task 4's worker states. Task 6 closes the release after the other tasks are integrated.
