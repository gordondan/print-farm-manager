# Batch Slicer Project-Bundle Design

## Goal

Make Batch Slicer produce a complete, printer-ready project bundle that the print-farm manager can ingest as one project. Original STLs are retained for traceability, while only sliced files participate in scheduling and printer dispatch.

## Scope

- Add a Batch Slicer export mode that recursively discovers `.stl` files and preserves each relative path.
- Slice each STL independently for every enabled printer profile, using unique output names.
- Export original STLs, printer-ready slice files, and a machine-readable manifest in a single versioned archive.
- Add an “Import sliced project” action to the print-farm manager.
- Create one draft project and one open part per STL, with target quantity 1.
- Create one printer-specific G-code record per successfully sliced profile and copy all managed files into farm storage.
- Reject malformed, incomplete, empty, or duplicate project bundles without partially importing data.
- Keep the project in draft status; importing never dispatches jobs.

## Data flow

Batch Slicer writes a versioned archive containing `manifest.json`, an `originals/` tree, and a `slices/` tree. Each manifest part maps one original STL to its printer-specific sliced artifacts, printer model, parts-per-plate value, and optional estimates. The manager validates the entire archive before opening a database transaction, copies originals and slices into project-specific managed storage, creates the project/parts/G-code rows, and rolls back both database and filesystem changes on failure.

## Data model

Add nullable `source_path` and `source_relpath` columns to `parts`. `source_path` points to the managed original STL; `source_relpath` is the user-facing path relative to the source folder. Existing parts remain valid with both fields null. The bundle format includes a schema version so future exporters/importers can reject incompatible archives clearly.

## UI behavior

Batch Slicer offers an export destination and project-name field; the default name is derived from the input folder. The Projects page offers a bundle file picker and import action. On success it refreshes the project list and opens the imported draft. The project detail view shows the source filename/path and the imported printer profiles, including any profiles that failed slicing.

## Verification

- Batch Slicer tests cover recursive discovery, unique output naming, manifest generation, and incomplete-slice reporting.
- Manager tests cover archive validation, successful import, duplicate names, malformed manifests, and transaction cleanup.
- A production build is run for both applications.
- The actual RC Loader folder is exported and imported only after verification; the result is one draft project with one part per discovered STL and printer-specific G-code rows for successful slices.
