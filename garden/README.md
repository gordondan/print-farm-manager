# The garden

Fork-only additions to Print Garden (printgarden.dagordons.com) that are not
part of Joel's upstream `print-farm-manager`. Everything here lives behind a
wall so pulling upstream updates stays a clean rebase.

| Plot | URL | What |
|---|---|---|
| `labels/` | `/labels` (in the app shell), `/garden/labels/` (standalone) | Multibin label generator → STL / 3MF |

## The wall

1. **Garden code lives in `garden/`.** New files only; nothing here is
   imported by upstream code except through `garden/index.js`.
2. **Upstream files get hooks, not features.** The complete list of upstream
   files the `garden` branch touches — keep it this short:

   | File | Hook |
   |---|---|
   | `server/index.js` | `require('../garden')(app);` before the SPA static/catch-all |
   | `Dockerfile` | `COPY garden ./garden` in the runtime stage |
   | `client/src/App.jsx` | `Labels` nav item + a `/labels` route that iframes `/garden/labels/?embed` |
   | `docker-compose.yml` | joins the external `cloudflare-tunnel` network (deploy config) |

   Check it any time: `git diff --stat origin/main...garden -- . ':!garden'`
   should list only upstream fixes plus these four files.
3. **Garden URLs live under `/garden`.** The server never mounts anything
   outside that prefix, so a future upstream route can't collide.
4. **Nothing garden-specific goes upstream by accident.** Branches meant for a
   PR to Joel are cut from `origin/main`, never from `garden`.

## Branches

```
origin/main (Joel)
  └─ local/all-fixes-on-main   your fixes pending upstream
       └─ garden               hooks + this folder  ← deployed
```

## Taking Joel's updates

```bash
cd ~/projects/print-garden          # the deploy worktree, on branch garden
git fetch origin
git rebase origin/main              # replays your pending fixes, then the garden commits
```

Garden conflicts can only land in the four hook files above. If upstream has
merged one of your fixes, the rebase drops that commit as already applied.

## Deploy

The live container is built from this worktree, reusing the existing
compose project (so the same `print-farm-manager_farm-*` volumes):

```bash
cd ~/projects/print-garden
docker compose -p print-farm-manager up -d --build print-farm-manager
```

Roll back to the pre-garden build: `docker tag print-farm-manager:pre-garden print-farm-manager:latest && docker compose -p print-farm-manager up -d --no-build print-farm-manager`.

## Tests

```bash
node --test garden/labels/tests/*.test.mjs   # garden plots (node:test)
npm test                                      # upstream server suite (jest), untouched
```
