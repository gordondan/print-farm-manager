# Multibin Label Generator

Browser replacement for the Fusion 360 `LabelGen` / `LabelGenBatch` scripts in
`~/projects/label-holder` (which keeps the Fusion script and label lists as
history). Pick a size (1CU / 2CU / 3CU / custom), type text or paste a batch,
and download STL, per-part STLs, or a colored 3MF for Bambu Studio.

Served by Print Garden at `/labels` (inside the app shell) and
`/garden/labels/` (standalone). Geometry is generated in the browser with no
build step: three.js, opentype.js, fflate and the Arimo font are vendored in
`vendor/` and `fonts/`.

## Send to Print Garden

```
browser ──plates──▶ /garden/api/labels (server.cjs, queue on disk)
                          ▲  claim / progress
                          │
            Mac: worker/label_worker.py ──▶ add-to-printgarden helper
                                              (BatchSlicer + OrcaSlicer)
                                              ──▶ Print Garden API
```

- **Plates:** the batch is packed onto P1S-size plates (256 mm, the smallest
  bed; see `lib/plates.js`), with each label kit whole on one plate. The page
  uploads one single-color STL per plate.
- **Worker:** claims the job and runs the helper once per plate. Plate 1
  creates the project as a draft, and later plates join it by id with their
  own `--parts-per-plate`.
- **Activation:** the project is activated only if every plate loaded;
  otherwise it stays a draft and the job shows why.
- **Printers:** the helper's defaults apply (P1S = PLA, SV08 = PETG, any
  color), and each part gets one plate per printer model.
- **Storage:** the queue lives in `server/data/garden/labels/` on the data
  volume and never touches `farm.db`. Finished jobs keep their `job.json`
  (last 50) and drop their plate files.
- **Worker offline:** jobs wait; the page warns when the worker hasn't
  checked in for a minute. A job claimed by a worker that died is handed out
  again after 30 minutes.

Install the worker: `worker/install.sh` (a launchd agent in your login
session). Run it by hand against another instance with
`PRINTGARDEN_URL=http://localhost:3099 python3 worker/label_worker.py --once`.

## Outputs

| Button | Single label | Batch |
|---|---|---|
| Download STL | `<name>-<size>.stl`, all selected parts | zip, one STL per label |
| Parts as separate STLs | zip: `label`, `text`, `holder`, `rail` | zip, one folder per label |
| Colored 3MF | one plate, 4 materials | all labels stacked on one plate |

Label blank corner sits at the origin; text is raised on the top face; holder
and bin clip are parked beside it in their native orientation.

## Sizes

Stock footprints live in `SIZES` in `lib/labelgen.js`. Label blanks are
generated (the template `label.stl` files are plain slabs, kept for tests);
holders come from `templates/<size>/holder.stl` and are offered only if that
file exists. **3CU is provisional** (128 × 12 mm, extrapolated) until real
templates land in `templates/3CU/`.

## Develop

Any static server works; through Print Garden: `npm run dev` at the repo root
and open `http://localhost:3000/garden/labels/`.

```bash
node --test garden/labels/tests/*.test.mjs
```

Covers watertight text for every glyph of both bundled fonts, fit/centering,
layout, plate packing, STL round-trip, 3MF structure, and the job queue API.
The queue test needs express and multer, so run it inside the deps image;
elsewhere it skips.
