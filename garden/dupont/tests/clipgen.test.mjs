import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD, normalizeBoard, resizePins, pinPositions, holePositions, buildFrame,
  boxesToMesh, lathe, validate, pattern, railDepth, printToBoard, farOffset, standoffRadius, postRadius, finWidth, slotSize, MIN_FIN,
} from '../lib/clipgen.js';

// Every edge is used exactly twice, once in each direction: a closed,
// consistently wound, manifold shell.
function assertClosed(tris, label) {
  const key = (i) => `${tris[i].toFixed(4)},${tris[i + 1].toFixed(4)},${tris[i + 2].toFixed(4)}`;
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const k = `${v[e]}|${v[(e + 1) % 3]}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    const [a, b] = k.split('|');
    assert.equal(n, 1, `${label}: edge ${k} used ${n} times one way`);
    assert.equal(edges.get(`${b}|${a}`), 1, `${label}: edge ${k} has no partner`);
  }
}

function signedVolume(tris) {
  let v = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(t, t + 9);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

const withPins = (left, right, extra = {}) => normalizeBoard({
  ...DEFAULT_BOARD, ...extra,
  connected: { left: [...left].map((c) => c === '1'), right: [...right].map((c) => c === '1') },
});

test('default board: user measurements', () => {
  const b = normalizeBoard();
  assert.equal(b.width, 28.3);
  assert.equal(b.length, 51.5);
  assert.equal(b.rowSpacing, 26);
  assert.equal(b.pins.left.length, 15);
  assert.equal(b.holes.diameter, 2.87);
  assert.equal(b.holes.edgeGap, 1.4);
});

test('pin positions: rows at +-rowSpacing/2, index 0 at the far end', () => {
  const p = pinPositions(normalizeBoard());
  assert.equal(p.left[0].x, -13);
  assert.equal(p.right[0].x, 13);
  assert.ok(p.left[0].y > p.left[14].y, 'index 0 is the far (non-USB) end');
  assert.ok(Math.abs(p.left[0].y - p.left[1].y - 2.54) < 1e-9);
});

test('pin 1 is measured from the far edge (user measured 6 mm)', () => {
  const b = normalizeBoard();
  assert.equal(farOffset(b), 6);
  assert.ok(Math.abs(pinPositions(b).left[0].y - (51.5 / 2 - 6)) < 1e-12);
  const c = normalizeBoard({ ...DEFAULT_BOARD, farEdgeToPin1: null });
  assert.ok(Math.abs(pinPositions(c).left[0].y + pinPositions(c).left[14].y) < 1e-9, 'blank = centered');
});

test('no running error: every pin is exactly anchor - k * pitch, also in the STL slots', () => {
  const b = normalizeBoard({ ...DEFAULT_BOARD, pins: { left: Array(40).fill(''), right: Array(40).fill('') }, length: 120 });
  const p = pinPositions(b).left;
  for (let k = 0; k < p.length; k++) assert.equal(p[k].y, p[0].y - k * 2.54);
  // Every other pin connected: each slot's lower edge in the mesh is k * pitch below the first.
  const conn = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
  const { frame } = buildFrame({ ...b, connected: { left: conn, right: Array(40).fill(false) } });
  const half = slotSize(b.clip) / 2;
  const ys = new Set();
  for (let i = 0; i < frame.length; i += 3) if (Math.abs(frame[i] - (p[0].x - half)) < 1e-4) ys.add(Math.round(frame[i + 1] * 1e4) / 1e4);
  for (let k = 0; k < 40; k += 2) {
    const want = p[0].y - k * 2.54 - half;
    assert.ok([...ys].some((y) => Math.abs(y - want) < 2e-4), `slot ${k + 1} edge at ${want.toFixed(4)}`);
  }
});

test('clearances: wired slot 3.04, unused hole 1.2, fin is one nozzle line', () => {
  const c = normalizeBoard().clip;
  assert.ok(Math.abs(slotSize(c) - 3.04) < 1e-9);
  assert.equal(c.blankHole, 1.2);
  assert.ok(finWidth(c, 2.54) >= MIN_FIN - 1e-9);
  assert.equal(validate(normalizeBoard()).warnings.filter((w) => /wall between/.test(w)).length, 0);
});

test('standoff collar shrinks to clear the header plastic at pin 1, post untouched', () => {
  const b = normalizeBoard();
  const [far] = holePositions(b).filter((h) => h.y > 0);
  const rs = standoffRadius(b, far);
  assert.ok(rs < postRadius(b) + b.clip.standoffWall, 'shrunk');
  assert.ok(rs >= postRadius(b));
  // collar edge stays headerGap away from the header strip corner
  const corner = { x: Math.sign(far.x) * (13 - 1.27), y: pinPositions(b).left[0].y + 1.27 };
  assert.ok(Math.hypot(far.x - corner.x, far.y - corner.y) - rs >= b.clip.headerGap - 1e-9);
  assert.equal(validate(b).errors.length, 0);
});

test('v1 drafts migrate: USB-edge offset converts, old default clearance updates', () => {
  const v1 = { name: 'old', length: 51.5, width: 28.3, usbEdgeToPin: 9.94, pins: DEFAULT_BOARD.pins, clip: { busClearance: 0.4, blankHoleRatio: 0.7 } };
  const b = normalizeBoard(v1);
  assert.ok(Math.abs(b.farEdgeToPin1 - (51.5 - 9.94 - 14 * 2.54)) < 1e-9);
  assert.equal(b.clip.busClearance, 0.5);
  const centered = normalizeBoard({ name: 'old', length: 51.5, width: 28.3, usbEdgeToPin: null });
  assert.equal(centered.farEdgeToPin1, 6, 'the built-in board gets the measured offset');
  const other = normalizeBoard({ name: 'other', length: 70, width: 28.3 });
  assert.equal(other.farEdgeToPin1, null);
});

test('holes sit edgeGap + radius in from each edge', () => {
  const h = holePositions(normalizeBoard());
  assert.equal(h.length, 4);
  for (const { x, y } of h) {
    assert.ok(Math.abs(Math.abs(x) - (14.15 - 1.4 - 1.435)) < 1e-9);
    assert.ok(Math.abs(Math.abs(y) - (25.75 - 1.4 - 1.435)) < 1e-9);
  }
});

test('box mesher: closed shells with correct outward winding', () => {
  const cube = boxesToMesh([[0, 0, 0, 1, 2, 3]]);
  assertClosed(cube, 'cube');
  assert.ok(Math.abs(signedVolume(cube) - 6) < 1e-6);
  const holed = boxesToMesh([[0, 0, 0, 10, 4, 2]], [[2, 1, -1, 4, 3, 3], [3, 1, -1, 6, 3, 3]]);
  assertClosed(holed, 'merged slots');
  assert.ok(Math.abs(signedVolume(holed) - (80 - 4 * 2 * 2)) < 1e-6);
});

test('lathe: closed, positive volume, stepped profile', () => {
  const m = lathe([[2, 0], [2, 1], [1, 1], [1, 3], [0.6, 3.4]], 5, 5);
  assertClosed(m, 'post');
  assert.ok(signedVolume(m) > 0);
});

test('frame: watertight, C shape open at the USB end, posts up', () => {
  const b = withPins('110010000000011', '000000000000001');
  const { frame, posts } = buildFrame(b);
  assertClosed(frame, 'frame');
  assert.ok(signedVolume(frame) > 0);
  assert.equal(posts.length, 4);
  for (const p of posts) { assertClosed(p, 'post'); assert.ok(signedVolume(p) > 0); }

  const D = railDepth(b.clip);
  // Crossbar: some face spans x = 0 near the far end (+y); nothing does at the USB end.
  const between = (y0, y1) => {
    for (let t = 0; t < frame.length; t += 9) {
      const xs = [frame[t], frame[t + 3], frame[t + 6]];
      const ys = [frame[t + 1], frame[t + 4], frame[t + 7]];
      if (Math.min(...xs) < 0 && Math.max(...xs) > 0 && Math.min(...ys) >= y0 && Math.max(...ys) <= y1) return true;
    }
    return false;
  };
  assert.ok(between(25.75 - D - 0.01, 25.76), 'crossbar at the far end');
  assert.ok(!between(-25.76, -20), 'open at the USB end');

  // Posts top out at clip height + header plastic + post height.
  let zmax = -Infinity;
  for (const p of posts) for (let i = 2; i < p.length; i += 3) zmax = Math.max(zmax, p[i]);
  assert.ok(Math.abs(zmax - (8.8 + 2.5 + 2)) < 1e-4);
});

test('slot sizes follow the selection (1 = housing slot, 0 = pin hole)', () => {
  const b = withPins('100000000000000', '000000000000000');
  const { frame } = buildFrame(b);
  const top = pinPositions(b).left[0];
  // A vertex at the corner of a 2.94 mm slot exists for pin 1; pin 2 only has the small hole.
  const has = (x, y) => {
    for (let i = 0; i < frame.length; i += 3) {
      if (Math.abs(frame[i] - x) < 1e-3 && Math.abs(frame[i + 1] - y) < 1e-3) return true;
    }
    return false;
  };
  assert.ok(has(top.x - 1.52, top.y - 1.52));
  const second = pinPositions(b).left[1];
  assert.ok(has(second.x - 0.6, second.y - 0.6));
  assert.ok(!has(second.x - 1.52, second.y - 1.52));
});

test('headers up turns the part over: the left row prints at +x, preview puts it back at -x', () => {
  const b = withPins('100000000000000', '000000000000000', { headers: 'up' });
  const { frame } = buildFrame(b);
  const top = pinPositions(b).left[0];
  let found = false;
  for (let i = 0; i < frame.length; i += 3) {
    if (Math.abs(frame[i] - (-top.x - 1.52)) < 1e-3 && Math.abs(frame[i + 1] - (top.y - 1.52)) < 1e-3) found = true;
  }
  assert.ok(found, 'connected left pin slot is at +x in print coordinates');
  const inUse = printToBoard(frame, b);
  assertClosed(inUse, 'turned frame keeps its winding');
  assert.ok(signedVolume(inUse) > 0);
  let zmin = Infinity;
  for (let i = 2; i < inUse.length; i += 3) zmin = Math.min(zmin, inUse[i]);
  assert.ok(zmin > 1.6, 'frame sits above the board top');
});

test('validation catches impossible boards', () => {
  assert.match(validate(normalizeBoard({ ...DEFAULT_BOARD, length: 30 })).errors[0], /do not fit/);
  assert.match(validate(normalizeBoard({ ...DEFAULT_BOARD, rowSpacing: 3 })).errors.join(' '), /overlap/);
  assert.equal(validate(withPins('1'.repeat(15), '0'.repeat(15))).errors.length, 0);
  assert.throws(() => buildFrame({ ...DEFAULT_BOARD, length: 30 }), /do not fit/);
});

test('resize keeps labels from the top and pads new rows', () => {
  const b = resizePins(normalizeBoard(), 17);
  assert.equal(b.pins.left.length, 17);
  assert.equal(b.pins.left[0], 'EN');
  assert.equal(b.pins.left[16], '');
  assert.equal(pattern(resizePins(withPins('1' + '0'.repeat(14), '0'.repeat(15)), 3), 'left'), '100');
});

test('normalize tolerates junk and short arrays', () => {
  const b = normalizeBoard({ pins: { left: ['A', 'B'], right: ['C'] }, connected: { left: [true] }, length: 'abc', headers: 'sideways' });
  assert.deepEqual(b.pins.right, ['C', '']);
  assert.deepEqual(b.connected.left, [true, false]);
  assert.deepEqual(b.connected.right, [false, false]);
  assert.equal(b.length, 51.5);
  assert.equal(b.headers, 'down');
});
