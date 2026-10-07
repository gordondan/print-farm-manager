# The garden

Fork-only additions to Print Garden (printgarden.dagordons.com) that are not
part of Joel's upstream `print-farm-manager`. Everything here lives behind a
wall so pulling upstream updates stays a clean rebase.

| Plot | URL | What |
|---|---|---|
| `labels/` | `/labels` (in the app shell), `/garden/labels/` (standalone), `/garden/api/labels` (job queue) | Multibin label generator → STL / 3MF, or **Send to Print Garden** (slice + queue) |
| `batch-slice/` | `/batch-slice`, `/garden/api/batch-slice` | Browser uploads or approved Mac folders, Print Garden managed Orca profiles, progress and draft project import |
| `fleet/` | "Next:" line on each Fleet card, `/garden/api/fleet/next-jobs` | Read-only preview of what each printer would be dispatched next. Mirrors the scheduler's candidate walk; its test compares against `_reserveJob`, so run it after every rebase. |

## The wall

1. **Garden code lives in `garden/`.** New files only; nothing here is
   imported by upstream code except through `garden/index.js`. One exception:
   React components must sit inside Vite's root, so client-side garden code
   lives in `client/src/garden/` (new files only, nothing upstream there).
2. **Upstream files get hooks, not features.** The complete list of upstream
   files the `development` branch touches — keep it this short:

   | File | Hook |
   |---|---|
   | `server/index.js` | `require('../garden')(app);` before the SPA static/catch-all |
   | `Dockerfile` | `COPY garden ./garden` in the runtime stage |
   | `client/src/App.jsx` | `Labels` nav item + a `/labels` route that iframes `/garden/labels/?embed` |
   | `client/src/pages/Fleet.jsx` | imports `../garden/NextJobLine` and renders `<NextJobLine printerId={printer.id} />` as the last child of `PrinterCard` |
   | `docker-compose.yml` | joins the external `cloudflare-tunnel` network (deploy config) |

   Check it any time: `git diff --stat origin/main...development -- . ':!garden'`
   should list only upstream fixes, these five files, and `client/src/garden/`.
3. **Garden URLs live under `/garden`.** The server never mounts anything
   outside that prefix, so a future upstream route can't collide.
4. **Nothing garden-specific goes upstream by accident.** Branches meant for a
   PR to Joel are cut from `origin/main`, never from `garden`.

## Branches

```
origin/main (Joel)
  └─ local/all-fixes-on-main   your fixes pending upstream
       └─ development          hooks + this folder  ← deployed
```

## Taking Joel's updates

```bash
cd ~/projects/print-garden          # the deploy worktree, on branch development
git fetch origin
git rebase origin/main              # replays your pending fixes, then the garden commits
```

Garden conflicts can only land in the five hook files above. After a rebase,
run the fleet test: it is what notices the scheduler's rules changing under
`fleet/next-job.js`. If upstream has
merged one of your fixes, the rebase drops that commit as already applied.

## Deploy

The live container is built from this worktree, reusing the existing
compose project (so the same `print-farm-manager_farm-*` volumes):

```bash
cd ~/projects/print-garden
docker compose -p print-farm-manager up -d --build print-farm-manager
```

Roll back to the pre-garden build: `docker tag print-farm-manager:pre-garden print-farm-manager:latest && docker compose -p print-farm-manager up -d --no-build print-farm-manager`.

## Mac-side services

Some garden work can't run in the Linux container. The shared Labels and Batch
Slice worker (`slicer/worker.py`) runs on the Mac as a launchd agent because
OrcaSlicer and its preset files stay on the worker. Install or reinstall it
with `garden/labels/worker/install.sh`. It logs to
`~/Library/Logs/garden-slicer-worker.log`.

Set the same `PRINTGARDEN_WORKER_TOKEN` in the Print Garden deployment `.env`
and in the shell before installing the launchd agent. Also set
`ORCA_PRESET_ROOTS` to one or more colon-separated Orca preset directories and
`PRINTGARDEN_SOURCE_ROOTS` to the Mac folders users may batch-slice. Set
`ORCA_PATH` only when OrcaSlicer is not discoverable in its standard app or
command locations. These values are copied into the LaunchAgent plist.

Profiles are managed under **Batch Slice** in the app. Select registered
Print Garden printer model IDs and presets reported by the worker. Preset paths
stay on the Mac; the browser sees stable preset IDs and display names. Batch
jobs and uploads are persisted in the existing `farm-data` volume under
`server/data/garden/batch-slice`; no queue tables are added to `farm.db`.

## Tests

```bash
node --test garden/labels/tests/*.test.mjs   # garden plots (node:test); the queue API
                                              # test needs express, so run it in the deps image
node --test garden/fleet/tests/*.test.mjs    # needs better-sqlite3 + express: deps image
npm test                                      # upstream server suite (jest), untouched
```
