// Label kit builder — the web replacement for the Fusion-only parts of
// label-holder/labelgen.py. Pure (no DOM): the app and the Node tests both drive it.
//
// A kit is { label, text, holder?, rail? }, each a flat triangle array
// (see stl.js), laid out on the print bed: label blank with its corner at the
// origin, raised text on its top face, holder and bin clip parked beside it.

import { bounds, translate } from './stl.js';
import { buildTextMesh } from './text.js';

// Template meshes ship beside the app (copied from label-holder/templates).
const TEMPLATES = './templates';
export const RAIL_URL = `${TEMPLATES}/rail.stl`;

// Stock label footprints, measured from templates/<size>/label.stl (plain
// 12-triangle slabs, so they are generated here instead of loaded).
// length = text reading direction, width = across the text.
export const SIZES = {
  '1CU': { length: 28.1, width: 13.517, holder: `${TEMPLATES}/1CU/holder.stl` },
  '2CU': { length: 78, width: 12, holder: `${TEMPLATES}/2CU/holder.stl` },
  // Provisional: no 3CU templates exist yet. Footprint extrapolated from
  // 1CU→2CU (+50 mm per CU); holder is offered only once holder.stl exists.
  '3CU': { length: 128, width: 12, holder: `${TEMPLATES}/3CU/holder.stl`, provisional: true },
};
export const DEFAULT_SIZE = '2CU';
export const CUSTOM_SIZE = 'Custom';
export const MIN_CUSTOM_MM = 5;

export const DEFAULTS = {
  labelThickness: 0.4, // mm, matches the stock label blanks
  textDepth: 0.4,      // mm raised above the label face
  fill: 0.75,          // text fills this fraction of label length & width
  partGap: 5,          // mm between parts on the bed
};

/** Label footprint { length, width } for a size key or a custom size. */
export function labelFootprint(size, custom) {
  if (size === CUSTOM_SIZE) {
    const { length, width } = custom ?? {};
    if (!(length >= MIN_CUSTOM_MM && width >= MIN_CUSTOM_MM)) {
      throw new Error(`Custom size must be at least ${MIN_CUSTOM_MM} mm on each side.`);
    }
    // Text always reads along the longer side, like the Fusion version.
    return { length: Math.max(length, width), width: Math.min(length, width) };
  }
  const cfg = SIZES[size];
  if (!cfg) throw new Error(`Unknown label size "${size}".`);
  return { length: cfg.length, width: cfg.width };
}

/** Axis-aligned box from (0,0,0) to (lx,ly,lz), outward-wound. */
export function boxMesh(lx, ly, lz) {
  const v = [
    [0, 0, 0], [lx, 0, 0], [lx, ly, 0], [0, ly, 0],
    [0, 0, lz], [lx, 0, lz], [lx, ly, lz], [0, ly, lz],
  ];
  const quads = [
    [0, 3, 2, 1], // bottom (-Z)
    [4, 5, 6, 7], // top (+Z)
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [1, 2, 6, 5], // +X
    [3, 0, 4, 7], // -X
  ];
  const out = [];
  for (const [a, b, c, d] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  return new Float32Array(out);
}

/**
 * Build one kit.
 * opts: { text, font, size, custom, fill, labelThickness, textDepth,
 *         holder (tris|null), rail (tris|null), partGap }
 */
export function buildKit(opts) {
  const o = { ...DEFAULTS, ...opts };
  const { length, width } = labelFootprint(o.size, o.custom);

  const kit = {
    label: boxMesh(length, width, o.labelThickness),
    text: buildTextMesh(o.font, o.text, {
      labelLength: length, labelWidth: width, fill: o.fill, depth: o.textDepth,
      cx: length / 2, cy: width / 2, z0: o.labelThickness,
    }),
  };

  // Park holder, then rail, off the +X end so nothing intersects in print.
  // Templates keep their native orientation; they are only dropped to the bed.
  let nextX = length + o.partGap;
  for (const part of ['holder', 'rail']) {
    const tris = o[part];
    if (!tris || !tris.length) continue;
    const b = bounds(tris);
    kit[part] = translate(tris, nextX - b.min[0], -b.min[1], -b.min[2]);
    nextX += b.max[0] - b.min[0] + o.partGap;
  }
  return kit;
}

/** Stack kits along -Y (one row per kit) for a shared batch plate. */
export function layoutBatch(kits, gap = DEFAULTS.partGap) {
  let y = 0;
  return kits.map((kit) => {
    const all = Object.values(kit).filter((t) => t.length);
    const minY = Math.min(...all.map((t) => bounds(t).min[1]));
    const maxY = Math.max(...all.map((t) => bounds(t).max[1]));
    const dy = y - maxY;
    y = dy + minY - gap;
    return Object.fromEntries(Object.entries(kit).map(([k, t]) => [k, translate(t, 0, dy, 0)]));
  });
}

/** One label per non-blank line; lines starting with # are comments. */
export function parseLabels(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

/** Filename-safe slug for a label string (same rules as labelgen.py). */
export function makeSafeName(text) {
  const s = text
    .replace(/[/\\]/g, '-').replace(/ /g, '_')
    .replace(/"/g, 'in').replace(/'/g, '')
    .replace(/[^A-Za-z0-9\-_.]/g, '');
  return s || 'label';
}

/** Safe names for a list of texts, de-duplicated with _2, _3, ... */
export function uniqueSafeNames(texts) {
  const used = new Set();
  return texts.map((t) => {
    const base = makeSafeName(t);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  });
}
