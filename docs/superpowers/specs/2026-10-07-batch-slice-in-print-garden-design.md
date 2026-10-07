# Batch Slice in Print Garden

**Status:** Design for review
**Date:** 2026-10-07

## Goal

Move the Batch Slicer workflow into Print Garden so a user can choose models, configure printer profiles, run OrcaSlicer batches, inspect progress, and create a Print Garden project from the results without opening the separate Batch Slicer desktop app.

Joel Telling's upstream Print Farm Manager remains a clean reference. The existing `origin/main` remote and the separate `~/projects/print-farm-manager-reference` clone are used to review upstream changes selectively. Print Garden owns the integrated UI and worker workflow.

## Agreed user workflow

- Add a **Batch Slice** child item under **Labels** in the left navigation. Keep the existing Labels page and its queue behavior.
- Accept model files uploaded from the browser and folders selected from worker-approved folders on the Mac.
- Let the user enter a project name, select and manage printer profiles, choose parallel job count, enable Orca plate arrangement, enable recursive folder scanning, and request a dry run.
- Show worker availability, job progress, per-model and per-profile results, logs, cancellation, and the created project link.
- A successful batch creates a draft Print Garden project using the existing project-bundle importer. Preserve original models, successful slices, and profile-specific failures in the imported project.
- A dry run previews the plan and commands but does not slice or create a project.

## Architecture

### Print Garden web application

The React application owns the Batch Slice page and profile management UI. Its route is `/batch-slice`; its sidebar entry is indented under Labels on desktop and appears as a distinct item in the mobile navigation.

The page reads worker health, approved model folders, available Orca presets, and configured printer profiles from the garden API. Profile definitions are stored in the garden data directory, identify a printer model registered in Print Garden, and reference machine, process, and filament presets known to the worker. User-entered Orca arguments are represented as an argument list, never a shell command string.

### Garden API and job queue

Add a separate Batch Slice queue under `/garden/api/batch-slice`. Persist queue state and uploaded model files under a dedicated garden data directory, not in `farm.db`. Job state includes the source selection, profile keys, options, progress, results, logs, cancellation request, and imported project ID.

The API validates supported model types, project names, profile selection, option ranges, folder selections, upload counts, and configured size limits before queueing work. Uploaded filenames and relative paths are normalized before storage. Queue cleanup removes staged uploads and temporary bundles after completion while retaining a bounded history of job summaries.

### Mac slicer worker

The existing Mac launchd worker is extended into the single slicer agent for both Labels and Batch Slice. It processes one top-level queue job at a time so the two workflows do not start competing Orca batches. Batch Slice parallelism remains controlled by the selected `jobs` value inside one batch.

Move the Python slicing engine and bundle writer from Batch Slicer into a Print Garden-owned Python module under `garden/`. The worker imports that integrated module and invokes OrcaSlicer locally. It no longer depends on `~/projects/BatchSlicer` or the separate Batch Slicer settings file.

The worker reports health, Orca availability, preset inventory, and approved source folders to the garden API. Profile definitions remain owned by the garden API and are validated by the worker before use. Local filesystem paths remain on the worker. The browser receives display names and stable identifiers, not arbitrary filesystem access.

### Project creation

The worker uses the integrated bundle writer to include every original model, every successful printer-specific slice, and failure records. It posts the bundle to the existing `POST /api/project-bundles/import` endpoint. The existing importer validates the bundle and creates a draft project with parts and G-code rows. The Batch Slice job records the returned project ID for navigation.

## File and folder input

Browser uploads may select supported files individually or use directory selection to preserve relative paths. Supported formats are STL, 3MF, OBJ, STEP, and STP. The API stores uploads in the job's staging directory.

Mac folder input is limited to worker-configured roots. The worker lists directories relative to those roots. When processing a selection, it resolves the path and verifies the resolved path remains beneath the configured root, including symlink checks. The API and worker reject arbitrary absolute paths and path traversal.

The same discovery and slicing functions handle both input modes. Recursive discovery applies to folder sources; uploaded directory structure is preserved and the selected recursive option determines which descendants are included.

## Profiles and presets

Profile configuration moves into Print Garden. Profiles include an output key, enabled state, registered Print Garden printer model ID, machine preset, process preset, filament preset list, and optional Orca argument list.

Preset files stay on the Mac. The worker exposes only preset files discovered under configured Orca preset roots and validates each selection before starting a job. The web UI can add, edit, enable, disable, and remove profile definitions without editing preset JSON contents. Missing presets, invalid printer-model mappings, or an unavailable Orca executable block job start with actionable errors.

## Progress, failures, and cancellation

Progress is reported for the overall batch and each model/profile slice. A failed slice does not hide successful results. The bundle records failures so they remain visible on the created project.

Queued jobs can be cancelled immediately. For running jobs, the API records a cancellation request; the worker sets the engine stop event and terminates the active Orca process, then records completed and cancelled work. The worker imports the partial bundle as a draft project so successful slices and failure records remain reviewable. If bundle validation or import fails, it reports the batch as failed without leaving a partial project.

Worker loss leaves queued jobs available for retry. A stale running claim can be reclaimed after a configured timeout, following the existing Labels queue model.

## Upstream reference workflow

Keep `~/projects/print-farm-manager-reference` on Joel's `origin/main` as the clean reference clone. Keep the current customized Print Garden fork as the implementation and deployment source. For upstream changes, compare commits and port only the changes that benefit the fork; do not require an upstream PR or wait for the upstream merge cadence.

The reference clone is separate from the Batch Slicer source. The integrated engine under `garden/` is maintained as part of Print Garden. When reviewing upstream Batch Slicer improvements, compare the upstream project history and port useful changes into the integrated engine.

## Failure handling and safety

- The Batch Slice page and its browser-facing APIs use the same authentication and access policy as the rest of Print Garden. Do not add a separate user login. Worker claim and heartbeat endpoints use worker credentials and are not callable as browser controls.
- If the worker is offline, allow job configuration but disable submission and show the last worker heartbeat.
- If Orca or a selected preset is missing, fail validation before slicing.
- If bundle import fails, mark the batch failed and preserve its log and slice summary for diagnosis. Do not leave a partially created project.
- Validate all model paths against their upload staging area or approved Mac roots before opening them.
- Bound upload size, file count, archive size, and retained job history using configuration values.
- Never expose unrestricted Mac paths or execute user-supplied shell text.

## Verification plan

- Python checks for model discovery, profile validation, command construction, dry run, per-profile failures, cancellation, and deterministic project bundle generation.
- API checks for upload validation, worker-folder validation, queue lifecycle, progress updates, cancellation, stale claims, and bounded cleanup.
- UI checks for both input modes, profile management, validation, progress, logs, cancellation, and project navigation.
- Verify imports create draft projects and preserve originals, successful slices, and failed profile records.
- Verify the Labels worker behavior still works through the refactored single slicer agent.
- Build the client and run the existing project test suite when implementation is complete.
