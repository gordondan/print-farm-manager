# Multibin Label Generator

Browser replacement for the Fusion 360 `LabelGen` / `LabelGenBatch` scripts in
`~/projects/label-holder` (which keeps the Fusion script and label lists as
history). Pick a size (1CU / 2CU / 3CU / custom), type text or paste a batch,
and download STL, per-part STLs, or a colored 3MF for Bambu Studio.

Served by Print Garden at `/labels` (inside the app shell) and
`/garden/labels/` (standalone). Fully client-side: no build step, no API —
three.js, opentype.js, fflate and the Arimo font are vendored in `vendor/` and
`fonts/`.

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
layout, STL round-trip and 3MF structure.
