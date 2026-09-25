// Text → extruded triangle mesh, via opentype.js glyph outlines, three.js
// curve flattening + earcut, and a small extruder of our own. Pure (no DOM),
// so it runs in the browser and under Node.

import { ShapePath, ShapeUtils } from '../vendor/three.core.js';

const CURVE_SEGMENTS = 8;

/**
 * Lay out `text` in font units (y-up) and return per-glyph ShapePaths plus
 * the ink bounds of the whole string.
 */
function layoutGlyphs(font, text) {
  const glyphs = font.stringToGlyphs(text);
  const paths = [];
  let x = 0;
  let prev = null;
  const ink = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  for (const g of glyphs) {
    if (prev) x += font.getKerningValue(prev, g);
    const cmds = g.path.commands; // font units, y-up
    if (cmds.length) {
      const sp = new ShapePath();
      for (const c of cmds) {
        switch (c.type) {
          case 'M': sp.moveTo(c.x + x, c.y); break;
          case 'L': sp.lineTo(c.x + x, c.y); break;
          case 'Q': sp.quadraticCurveTo(c.x1 + x, c.y1, c.x + x, c.y); break;
          case 'C': sp.bezierCurveTo(c.x1 + x, c.y1, c.x2 + x, c.y2, c.x + x, c.y); break;
          // 'Z': ShapePath closes subpaths implicitly
        }
      }
      paths.push(sp);
      const bb = g.getBoundingBox();
      ink.minX = Math.min(ink.minX, bb.x1 + x);
      ink.maxX = Math.max(ink.maxX, bb.x2 + x);
      ink.minY = Math.min(ink.minY, bb.y1);
      ink.maxY = Math.max(ink.maxY, bb.y2);
    }
    x += g.advanceWidth;
    prev = g;
  }
  return { paths, ink };
}

/** Signed area of a closed point loop (positive = counter-clockwise). */
function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  }
  return a / 2;
}

/**
 * Solid contours are the ones wound like the glyph's largest contour.
 * TrueType outers are clockwise, CFF/OTF outers counter-clockwise; detecting
 * per glyph handles both without caring about the font format.
 */
function glyphShapes(shapePath) {
  let biggest = 0;
  let biggestArea = 0;
  for (const sub of shapePath.subPaths) {
    const a = signedArea(sub.getPoints());
    if (Math.abs(a) > Math.abs(biggestArea)) { biggestArea = a; biggest = sub; }
  }
  if (!biggest) return [];
  return shapePath.toShapes(biggestArea > 0); // isCCW: CCW contours are solid
}

/**
 * Measure how `text` would be sized/placed on a label face, without building
 * geometry. Returns { scale, width, height } in mm, or null for blank text.
 *
 * Sizing mirrors the old Fusion script: the text's line box (font ascender to
 * descender, so every label in a batch gets the same letter height) fills
 * `fill` of the label width; it shrinks if the ink is wider than `fill` of
 * the label length.
 */
export function fitText(font, text, labelLength, labelWidth, fill) {
  const { paths, ink } = layoutGlyphs(font, text);
  if (!paths.length) return null;
  const lineBox = font.ascender - font.descender;
  const inkW = ink.maxX - ink.minX;
  const scale = Math.min((labelWidth * fill) / lineBox, (labelLength * fill) / inkW);
  return { scale, width: inkW * scale, height: (ink.maxY - ink.minY) * scale };
}

/**
 * Build raised text as a flat triangle array: reads along +X, centred on
 * (cx, cy), bottom face at z = z0, extruded `depth` mm upward.
 */
export function buildTextMesh(font, text, { labelLength, labelWidth, fill, depth, cx = 0, cy = 0, z0 = 0 }) {
  const fit = fitText(font, text, labelLength, labelWidth, fill);
  if (!fit) return new Float32Array(0);
  const { paths, ink } = layoutGlyphs(font, text);
  const s = fit.scale;

  // Horizontal: centre the ink. Vertical: centre the font's line box, which
  // keeps caps optically centred and baselines consistent across a batch.
  const midX = (ink.minX + ink.maxX) / 2;
  const midY = (font.ascender + font.descender) / 2;

  const out = [];
  for (const sp of paths) {
    for (const shape of glyphShapes(sp)) {
      extrudeShape(shape, depth / s, out);
    }
  }
  const result = new Float32Array(out.length);
  for (let i = 0; i < out.length; i += 3) {
    result[i] = (out[i] - midX) * s + cx;
    result[i + 1] = (out[i + 1] - midY) * s + cy;
    result[i + 2] = out[i + 2] * s + z0;
  }
  return result;
}

/** Drop the closing duplicate and any repeated consecutive points. */
function cleanLoop(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

/**
 * Extrude one shape (outer contour + holes) from z=0 to z=depth, appending
 * triangles to `out`. Used instead of three's ExtrudeGeometry because earcut
 * leaves T-junctions where a hole edge is collinear with an outer edge (e.g.
 * '#'), which makes the mesh non-manifold; we split those faces here.
 */
function extrudeShape(shape, depth, out) {
  const { shape: rawOuter, holes: rawHoles } = shape.extractPoints(CURVE_SEGMENTS);
  const outer = cleanLoop(rawOuter);
  if (outer.length < 3) return;
  const holes = rawHoles.map(cleanLoop).filter((h) => h.length >= 3);

  // Outer counter-clockwise, holes clockwise: walls then face outward.
  if (ShapeUtils.isClockWise(outer)) outer.reverse();
  for (const h of holes) if (!ShapeUtils.isClockWise(h)) h.reverse();

  const loops = [outer, ...holes];
  const verts = loops.flat();
  const faces = splitTJunctions(
    ShapeUtils.triangulateShape(outer.slice(), holes.map((h) => h.slice())), verts, loops);

  const push = (p, z) => out.push(p.x, p.y, z);
  for (const [a, b, c] of faces) {
    const A = verts[a], B = verts[b], C = verts[c];
    const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
    const [P, Q] = ccw ? [B, C] : [C, B];
    push(A, depth); push(P, depth); push(Q, depth); // top, facing +Z
    push(A, 0); push(Q, 0); push(P, 0);             // bottom, facing -Z
  }
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      push(p, 0); push(q, 0); push(q, depth);
      push(p, 0); push(q, depth); push(p, depth);
    }
  }
}

/**
 * Repair T-junctions: an edge that is neither a contour edge used once nor an
 * interior edge shared by two faces is split at any contour vertex lying on
 * it. Only unmatched edges are touched, so legitimate slivers survive.
 */
function splitTJunctions(faces, verts, loops) {
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const boundary = new Set();
  let base = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) boundary.add(ek(base + i, base + (i + 1) % loop.length));
    base += loop.length;
  }

  for (let pass = 0; pass < 32; pass++) {
    const count = new Map();
    for (const f of faces) for (let k = 0; k < 3; k++) {
      const e = ek(f[k], f[(k + 1) % 3]);
      count.set(e, (count.get(e) ?? 0) + 1);
    }
    const bad = (a, b) => {
      const e = ek(a, b);
      return count.get(e) !== (boundary.has(e) ? 1 : 2);
    };

    let changed = false;
    const next = [];
    for (const f of faces) {
      const v = splitPoint(f, verts, bad);
      if (v) { next.push(...v); changed = true; } else next.push(f);
    }
    faces = next;
    if (!changed) break;
  }
  return faces;
}

/** Two replacement faces if one of f's unmatched edges passes through a vertex. */
function splitPoint(f, verts, bad) {
  for (let k = 0; k < 3; k++) {
    const a = f[k], b = f[(k + 1) % 3], c = f[(k + 2) % 3];
    if (!bad(a, b)) continue;
    const A = verts[a], B = verts[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    for (let v = 0; v < verts.length; v++) {
      if (v === a || v === b || v === c) continue;
      const P = verts[v];
      const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const cross = (P.x - A.x) * dy - (P.y - A.y) * dx;
      if (Math.abs(cross) > 1e-6 * len2) continue;
      return [[a, v, c], [v, b, c]];
    }
  }
  return null;
}
