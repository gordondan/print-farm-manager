// Pack label kits onto print plates for "Send to Print Garden".
//
// Each kit (label+text, plus holder/rail if selected) stays whole on one
// plate, so a plate's parts-per-plate is simply its kit count. Plates are
// sized for the smallest bed on the farm; the slicer's arrange step centres
// each plate's single merged object on whichever printer takes it.

import { bounds, mergeTriangles, translate } from './stl.js';

// P1S bed (256 mm square) less a margin: the smallest bed on the farm, so a
// plate fits every printer. SV08 (350 mm) just has room to spare.
export const PLATE = { width: 256, depth: 256, margin: 8, gap: 4 };

/**
 * kits: array of { label, text, holder?, rail? } as built by buildKit.
 * Returns [{ kitIndexes: number[], tris: Float32Array }], kits in input order
 * (shelf packing: fill a row left to right, then start the next row).
 */
export function packPlates(kits, plate = PLATE) {
  const usableW = plate.width - 2 * plate.margin;
  const usableD = plate.depth - 2 * plate.margin;
  const plates = [];
  let cur = null;
  let x = 0, y = 0, rowDepth = 0;

  const newPlate = () => {
    cur = { kitIndexes: [], parts: [] };
    plates.push(cur);
    x = 0; y = 0; rowDepth = 0;
  };

  kits.forEach((kit, i) => {
    const tris = mergeTriangles(...Object.values(kit).filter((t) => t.length));
    const b = bounds(tris);
    const w = b.max[0] - b.min[0];
    const d = b.max[1] - b.min[1];
    if (w > usableW || d > usableD) {
      throw new Error(`Label ${i + 1} (${w.toFixed(0)} × ${d.toFixed(0)} mm) is larger than a ${plate.width} mm plate.`);
    }
    if (!cur) newPlate();
    if (x > 0 && x + w > usableW) { x = 0; y += rowDepth + plate.gap; rowDepth = 0; } // next row
    if (y + d > usableD) newPlate();                                                  // next plate

    cur.parts.push(translate(tris, plate.margin + x - b.min[0], plate.margin + y - b.min[1], -b.min[2]));
    cur.kitIndexes.push(i);
    x += w + plate.gap;
    rowDepth = Math.max(rowDepth, d);
  });

  return plates.map(({ kitIndexes, parts }) => ({ kitIndexes, tris: mergeTriangles(...parts) }));
}
