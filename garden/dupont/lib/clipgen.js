// Dupont clip frame geometry. Pure functions, no DOM, so node:test can drive it.
//
// A board definition (see DEFAULT_BOARD) describes a dev board with two
// header rows. The frame is two clip rails (one per header row, the same
// slot geometry as the old dupont-clip-gen.py) joined by a crossbar at the
// end away from the USB connector, so the frame is a "C" that is open at the
// USB end. Corner posts drop into the board's mounting holes, so the frame
// only fits one way round.
//
// Board coordinates (the pinout diagram is a TOP view, component side up):
//   x  across the board, left header row at -rowSpacing/2
//   y  along the board, USB edge at -length/2, far edge at +length/2
//   z  up, away from the component side
//
// Pin labels are listed top to bottom as drawn: index 0 is at the far end,
// the last index is nearest the USB connector.
//
// Print coordinates: the frame lies flat on the bed (z = 0 is the wire side),
// posts point up. With headers pointing down (frame under the board), print
// XY equals board XY. With headers pointing up (frame on top of the board) the
// part is the board-coordinate layout turned over about the y axis; both are
// rigid moves, never mirrors, so the printed part can not come out transposed.

// Slot and hole sizes are chosen so the fin between a wire slot and an unused
// pin hole is one 0.4 mm nozzle line: (3.04 + 1.2) / 2 = 2.12 = 2.54 - 0.42.
export const DEFAULT_CLIP = {
  pinSize: 2.54,       // Dupont housing, square
  busClearance: 0.5,   // connected pin: housing slot = pinSize + busClearance (3.04 mm)
  blankHole: 1.2,      // unconnected pin: square pass-through for the header pin
  wall: 1.0,           // rail wall outside the slots
  height: 8.8,         // rail height (along the Dupont housings)
  postHeight: 2.0,     // how far a post goes into the mounting hole
  postClearance: 0.3,  // post diameter = hole diameter - postClearance
  standoffWall: 1.0,   // standoff collar radius = post radius + standoffWall, shrunk to clear the header plastic
  headerGap: 0.2,      // collar to header plastic, minimum
};

export const MIN_FIN = 0.42; // thinnest wall a 0.4 mm nozzle reliably prints

export const DEFAULT_BOARD = {
  version: 2,
  name: 'ESP32 DevKit (30 pin)',
  length: 51.5,       // USB edge to far edge
  width: 28.3,
  rowSpacing: 26,     // header row center to center
  pitch: 2.54,
  farEdgeToPin1: 6,   // far (non-USB) edge to the center of pin 1; null = rows centered
  headers: 'down',    // header pins point 'down' (wires under the board) or 'up'
  headerHeight: 2.5,  // black plastic header spacer = gap from frame to board
  holes: { enabled: true, diameter: 2.87, edgeGap: 1.4 }, // edgeGap: board edge to hole edge
  pins: {
    left: ['EN', 'VP 36', 'VN 39', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'D13', 'GND', 'VIN'],
    right: ['D23', 'D22', 'TX0 1', 'RX0 3', 'D21', 'D19', 'D18', 'D5', 'TX2 17', 'RX2 16', 'D4', 'D2', 'D15', 'GND', '3V3'],
  },
  connected: {
    left: Array(15).fill(false),
    right: Array(15).fill(false),
  },
  clip: { ...DEFAULT_CLIP },
};

export const SIDES = ['left', 'right'];

/** Deep copy with every field present, so older or hand-written files load. */
export function normalizeBoard(input = {}) {
  const b = structuredClone(DEFAULT_BOARD);
  const src = input && typeof input === 'object' ? input : {};
  for (const k of ['name', 'headers']) if (typeof src[k] === 'string') b[k] = src[k];
  for (const k of ['length', 'width', 'rowSpacing', 'pitch', 'headerHeight']) {
    if (Number.isFinite(+src[k]) && src[k] !== null && src[k] !== '') b[k] = +src[k];
  }
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
  const version = Number.isFinite(+src.version) ? +src.version : 1;
  if ('farEdgeToPin1' in src) b.farEdgeToPin1 = num(src.farEdgeToPin1);
  if (b.headers !== 'up') b.headers = 'down';
  if (src.holes && typeof src.holes === 'object') {
    b.holes.enabled = src.holes.enabled !== false;
    for (const k of ['diameter', 'edgeGap']) if (Number.isFinite(+src.holes[k])) b.holes[k] = +src.holes[k];
  }
  if (src.clip && typeof src.clip === 'object') {
    for (const k of Object.keys(DEFAULT_CLIP)) if (Number.isFinite(+src.clip[k])) b.clip[k] = +src.clip[k];
    // v1 used 0.4 slot clearance and a 0.7 x pinSize hole; untouched defaults move to the new ones.
    if (version < 2 && +src.clip.busClearance === 0.4) b.clip.busClearance = DEFAULT_CLIP.busClearance;
  }
  if (src.pins && typeof src.pins === 'object') {
    const n = Math.max(1, ...SIDES.map((s) => (Array.isArray(src.pins[s]) ? src.pins[s].length : 0)));
    for (const s of SIDES) {
      const arr = Array.isArray(src.pins[s]) ? src.pins[s] : [];
      b.pins[s] = Array.from({ length: n }, (_, i) => String(arr[i] ?? '').slice(0, 24));
    }
  }
  const n = b.pins.left.length;
  // v1 measured from the USB edge (or centered when blank). Convert, except that
  // the built-in board's dimensions get the measured 6 mm.
  if (Object.keys(src).length && !('farEdgeToPin1' in src)) {
    b.farEdgeToPin1 = null;
    const usb = num(src.usbEdgeToPin);
    if (usb !== null) b.farEdgeToPin1 = b.length - usb - (n - 1) * b.pitch;
    else if (b.length === DEFAULT_BOARD.length && b.width === DEFAULT_BOARD.width) b.farEdgeToPin1 = DEFAULT_BOARD.farEdgeToPin1;
  }
  b.version = 2;
  for (const s of SIDES) {
    const arr = Array.isArray(src.connected?.[s]) ? src.connected[s] : [];
    b.connected[s] = Array.from({ length: n }, (_, i) => arr[i] === true || arr[i] === 1 || arr[i] === '1');
  }
  return b;
}

/** Change pins per row, keeping existing labels and selections from the top. */
export function resizePins(board, n) {
  const b = structuredClone(board);
  n = Math.max(1, Math.min(60, Math.round(n)));
  for (const s of SIDES) {
    b.pins[s] = Array.from({ length: n }, (_, i) => board.pins[s][i] ?? '');
    b.connected[s] = Array.from({ length: n }, (_, i) => board.connected[s][i] ?? false);
  }
  return b;
}

export const pinCount = (board) => board.pins.left.length;

/** Distance from the far (non-USB) edge to the center of pin 1, as used. */
export function farOffset(board) {
  if (board.farEdgeToPin1 !== null) return board.farEdgeToPin1;
  return (board.length - (pinCount(board) - 1) * board.pitch) / 2;
}

/**
 * Pin centers in board coordinates: { left: [{x, y}], right: [...] }, top to bottom.
 * Every pin is placed from the one measured anchor (pin 1) by an integer
 * multiple of the pitch, never by adding to the previous pin, so there is no
 * running error: pin k is exactly anchor - k * pitch.
 */
export function pinPositions(board) {
  const n = pinCount(board);
  const anchor = board.length / 2 - farOffset(board);
  const out = {};
  for (const s of SIDES) {
    const x = (s === 'left' ? -1 : 1) * board.rowSpacing / 2;
    out[s] = Array.from({ length: n }, (_, i) => ({ x, y: anchor - i * board.pitch }));
  }
  return out;
}

/** Mounting hole centers in board coordinates (corners), or [] when disabled. */
export function holePositions(board) {
  if (!board.holes.enabled) return [];
  const r = board.holes.diameter / 2;
  const hx = board.width / 2 - board.holes.edgeGap - r;
  const hy = board.length / 2 - board.holes.edgeGap - r;
  return [[-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]].map(([x, y]) => ({ x, y }));
}

/** "1"/"0" pattern for a row, top to bottom (same meaning as the old script). */
export const pattern = (board, side) => board.connected[side].map((c) => (c ? '1' : '0')).join('');

export const slotSize = (clip) => clip.pinSize + clip.busClearance;
export const railDepth = (clip) => Math.max(slotSize(clip), clip.blankHole) + 2 * clip.wall;
export const postRadius = (board) => (board.holes.diameter - board.clip.postClearance) / 2;

/** Thinnest fin between a wire slot and a neighbouring unused pin hole. */
export const finWidth = (clip, pitch) => pitch - (slotSize(clip) + clip.blankHole) / 2;

/** Closest distance from a point to the header plastic strips (pins +- half a pitch). */
function distToHeaders(board, h) {
  const rows = pinPositions(board);
  const n = pinCount(board);
  let best = Infinity;
  for (const s of SIDES) {
    const x0 = rows[s][0].x - board.pitch / 2, x1 = rows[s][0].x + board.pitch / 2;
    const y1 = rows[s][0].y + board.pitch / 2, y0 = rows[s][n - 1].y - board.pitch / 2;
    const dx = Math.max(x0 - h.x, 0, h.x - x1);
    const dy = Math.max(y0 - h.y, 0, h.y - y1);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

/**
 * Standoff collar radius for a hole: post radius + standoffWall, shrunk so the
 * collar never touches the header plastic (pin 1 sits right next to the far
 * corner posts), and never thinner than the post itself.
 */
export function standoffRadius(board, h) {
  const want = postRadius(board) + board.clip.standoffWall;
  if (!h) return want;
  return Math.max(postRadius(board), Math.min(want, distToHeaders(board, h) - board.clip.headerGap));
}

/**
 * Things that would make a frame that does not fit. Errors block export;
 * warnings are shown but do not.
 */
export function validate(board) {
  const errors = [];
  const warnings = [];
  const c = board.clip;
  const n = pinCount(board);
  const pos = (v, name) => { if (!(v > 0)) errors.push(`${name} must be more than 0.`); };
  pos(board.length, 'Board length');
  pos(board.width, 'Board width');
  pos(board.rowSpacing, 'Row spacing');
  pos(board.pitch, 'Pin pitch');
  pos(c.height, 'Clip height');
  pos(c.wall, 'Wall');
  if (board.headerHeight < 0) errors.push('Header plastic height can not be negative.');
  if (errors.length) return { errors, warnings };

  const rows = pinPositions(board);
  const top = rows.left[0].y + board.pitch / 2;
  const bottom = rows.left[n - 1].y - board.pitch / 2;
  if (bottom < -board.length / 2 - 1e-6 || top > board.length / 2 + 1e-6) {
    errors.push(`${n} pins at ${board.pitch} mm pitch do not fit on a ${board.length} mm board starting ${+farOffset(board).toFixed(2)} mm from the far edge.`);
  }
  if (board.rowSpacing >= board.width + railDepth(c)) {
    errors.push('Row spacing is wider than the board.');
  }
  if (railDepth(c) >= board.rowSpacing) errors.push('Rails would overlap: row spacing is too small for the clip.');
  if (!board.connected.left.some(Boolean) && !board.connected.right.some(Boolean)) {
    warnings.push('No pins are selected, so the frame holds no wires. Click pins on the diagram.');
  }
  if (board.holes.enabled) {
    if (!(board.holes.diameter > c.postClearance + 0.5)) errors.push('Mounting hole is too small for a post.');
    // The post itself must clear the header plastic; the collar shrinks to fit.
    for (const h of holePositions(board)) {
      if (distToHeaders(board, h) < postRadius(board)) {
        errors.push('A corner post runs into the header plastic. Check the hole and first-pin measurements.');
        break;
      }
    }
  } else {
    warnings.push('No mounting holes: nothing locks the frame to the board, so check the USB end before plugging in.');
  }
  const fin = finWidth(c, board.pitch);
  if (fin < MIN_FIN - 1e-9) {
    warnings.push(`The wall between a wire slot and an unused pin hole is ${fin.toFixed(2)} mm, thinner than one nozzle line; the slicer may drop it.`);
  }
  if (c.blankHole < 1.0) warnings.push('Unused pin holes under 1.0 mm may not clear a slightly bent header pin.');
  if (board.headers === 'up') {
    warnings.push('Headers up: the crossbar sits over the far end of the top side. Make sure nothing taller than the header plastic is there.');
  }
  return { errors, warnings };
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/**
 * Build the frame in print coordinates.
 * Returns { frame, posts } as flat Float32Array triangle lists (9 floats per
 * triangle, mm). `frame` is one closed, watertight shell. Each post is its own
 * closed shell sunk 0.2 mm into the frame; slicers union them.
 */
export function buildFrame(input) {
  const board = normalizeBoard(input);
  const { errors } = validate(board);
  if (errors.length) throw new Error(errors[0]);
  const c = board.clip;
  const H = c.height;
  const D = railDepth(c);
  const L = board.length;
  // Headers up: turn the part over about y, so x flips in print coordinates.
  const fx = board.headers === 'up' ? -1 : 1;
  const rows = pinPositions(board);
  const holes = holePositions(board).map((h) => ({ x: fx * h.x, y: h.y, rs: standoffRadius(board, h) }));

  const adds = [];
  const subs = [];
  for (const s of SIDES) {
    const x = fx * rows[s][0].x;
    adds.push([x - D / 2, -L / 2, 0, x + D / 2, L / 2, H]);
  }
  // Crossbar at the far end (+y). The USB end stays open.
  const xs = SIDES.map((s) => fx * rows[s][0].x);
  adds.push([Math.min(...xs) - D / 2, L / 2 - D, 0, Math.max(...xs) + D / 2, L / 2, H]);
  // Pads under each standoff, so the collar always sits on solid frame.
  for (const h of holes) adds.push([h.x - h.rs, h.y - h.rs, 0, h.x + h.rs, h.y + h.rs, H]);

  for (const s of SIDES) {
    rows[s].forEach((p, i) => {
      const size = board.connected[s][i] ? slotSize(c) : c.blankHole;
      const x = fx * p.x;
      subs.push([x - size / 2, p.y - size / 2, -1, x + size / 2, p.y + size / 2, H + 1]);
    });
  }

  const frame = boxesToMesh(adds, subs);
  const posts = [];
  if (holes.length) {
    const rp = postRadius(board);
    const zs = H + board.headerHeight;
    const ch = Math.min(0.4, c.postHeight / 3, rp / 2); // lead-in chamfer
    for (const h of holes) {
      // Only the post core is sunk into the frame; the wider collar starts at
      // the frame's top face so it can never poke into a neighbouring slot.
      const profile = [[rp, H - 0.2]];
      if (board.headerHeight > 0 && h.rs > rp + 1e-6) profile.push([rp, H], [h.rs, H], [h.rs, zs]);
      profile.push([rp, zs], [rp, zs + c.postHeight - ch], [rp - ch, zs + c.postHeight]);
      const clean = profile.filter((pt, k) => k === 0 || pt[0] !== profile[k - 1][0] || pt[1] !== profile[k - 1][1]);
      posts.push(lathe(clean, h.x, h.y));
    }
  }
  return { frame, posts, board };
}

/** Everything in one list, ready for STL. */
export function frameTriangles(input) {
  const { frame, posts } = buildFrame(input);
  return concat(frame, ...posts);
}

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Union of `adds` minus union of `subs`, each box [x0,y0,z0,x1,y1,z1].
 * Every box edge becomes a grid line, each grid cell is solid or empty, and a
 * face is emitted wherever a solid cell meets an empty one. All faces share
 * the one grid, so the shell is closed with no T-junctions.
 */
export function boxesToMesh(adds, subs = []) {
  const q = (v) => Math.round(v * 1e5) / 1e5;
  const axis = (k) => [...new Set(adds.flatMap((b) => [q(b[k]), q(b[k + 3])])
    .concat(subs.flatMap((b) => [q(b[k]), q(b[k + 3])])))].sort((a, b) => a - b);
  const X = axis(0), Y = axis(1), Z = axis(2);
  const nx = X.length - 1, ny = Y.length - 1, nz = Z.length - 1;
  const inside = (b, p) => p[0] > b[0] && p[0] < b[3] && p[1] > b[1] && p[1] < b[4] && p[2] > b[2] && p[2] < b[5];
  const solid = new Uint8Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [(X[i] + X[i + 1]) / 2, (Y[j] + Y[j + 1]) / 2, (Z[k] + Z[k + 1]) / 2];
    solid[idx(i, j, k)] = adds.some((b) => inside(b, p)) && !subs.some((b) => inside(b, p)) ? 1 : 0;
  }
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : solid[idx(i, j, k)]);
  const out = [];
  // quad corners a,b,c,d counter-clockwise seen from outside
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid[idx(i, j, k)]) continue;
    const x0 = X[i], x1 = X[i + 1], y0 = Y[j], y1 = Y[j + 1], z0 = Z[k], z1 = Z[k + 1];
    if (!at(i - 1, j, k)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    if (!at(i + 1, j, k)) quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!at(i, j - 1, k)) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!at(i, j + 1, k)) quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    if (!at(i, j, k - 1)) quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    if (!at(i, j, k + 1)) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  }
  return new Float32Array(out);
}

/** Closed solid of revolution about a vertical axis at (cx, cy). profile: [[r, z], ...] bottom to top. */
export function lathe(profile, cx, cy, segments = 32) {
  const out = [];
  const ring = (r, z) => Array.from({ length: segments }, (_, s) => {
    const a = (s / segments) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
  });
  const rings = profile.map(([r, z]) => ring(r, z));
  for (let p = 0; p + 1 < rings.length; p++) {
    const lo = rings[p], hi = rings[p + 1];
    for (let s = 0; s < segments; s++) {
      const t = (s + 1) % segments;
      if (profile[p][0] > 0 || profile[p + 1][0] > 0) {
        out.push(...lo[s], ...lo[t], ...hi[t], ...lo[s], ...hi[t], ...hi[s]);
      }
    }
  }
  const bottom = profile[0], top = profile[profile.length - 1];
  const cb = [cx, cy, bottom[1]], ct = [cx, cy, top[1]];
  for (let s = 0; s < segments; s++) {
    const t = (s + 1) % segments;
    out.push(...cb, ...rings[0][t], ...rings[0][s]);
    out.push(...ct, ...rings[rings.length - 1][s], ...rings[rings.length - 1][t]);
  }
  return new Float32Array(out);
}

/** Map print-coordinate triangles into board coordinates for the preview. */
export function printToBoard(tris, board) {
  // Board underside at z = 0, top at z = boardThickness.
  const H = board.clip.height;
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (board.headers === 'up') {
      // turned over about y, sitting on the header plastic above the top face
      out[i] = -x; out[i + 1] = y; out[i + 2] = BOARD_THICKNESS + board.headerHeight + H - z;
    } else {
      out[i] = x; out[i + 1] = y; out[i + 2] = z - H - board.headerHeight;
    }
  }
  // Rotating 180 degrees about y keeps handedness, but flipping two axes
  // keeps triangle winding, so no reorder is needed.
  return out;
}

export const BOARD_THICKNESS = 1.6;

/** Filename-safe slug. */
export function slug(s) {
  return String(s || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'board';
}
