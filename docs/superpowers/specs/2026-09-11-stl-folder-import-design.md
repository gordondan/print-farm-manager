# STL Folder Import Design

## Goal

Create an RC Loader project from a folder of STL files so the print-farm manager can track each model as a part and retain a managed copy of the source files.

## Scope

- Add an “Import STL folder” action to the Projects page.
- Accept a folder selection through a server-side import endpoint.
- Recursively discover `.stl` files and preserve each file’s relative path.
- Create one draft project and one open part per STL, with target quantity 1.
- Copy source files into managed storage under the project.
- Store the managed source path and relative source path on each part.
- Reject empty folders and duplicate project names without partially creating data.
- Do not create G-code records or dispatch jobs; G-code remains a separate upload step.

## Data flow

The UI sends a folder path and project name to the API. The server validates that the folder exists, discovers and sorts STL files, creates the project and parts in one database transaction, and copies the files into a project-specific storage directory. If file copying fails, the operation removes the newly created database rows and managed files before returning an error.

## Data model

Add nullable `source_path` and `source_relpath` columns to `parts`. `source_path` points to the managed copy used for future workflows; `source_relpath` is the user-facing path relative to the imported folder. Existing parts remain valid with both fields null.

## UI behavior

The Projects page offers a folder picker and project-name field. The default name is derived from the selected folder. On success it refreshes the project list and opens the imported project. The project detail view shows the source filename/path for each imported part and explains that G-code must still be uploaded before scheduling.

## Verification

- Unit tests cover recursive discovery, sorting, duplicate names, empty folders, transaction cleanup, and migration compatibility.
- API tests cover a successful import and failure cases.
- A production build is run.
- The actual RC Loader folder is imported only after the implementation is verified; the operation creates one draft project with one part per discovered STL.
