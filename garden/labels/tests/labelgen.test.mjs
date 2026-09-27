// Run: node --test garden/labels/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import opentype from '../vendor/opentype.module.js';
import { unzipSync, strFromU8 } from '../vendor/fflate.module.js';
import { parseStl, writeBinaryStl, bounds, mergeTriangles } from '../lib/stl.js';
import { fitText, buildTextMesh } from '../lib/text.js';
import {
  SIZES, CUSTOM_SIZE, boxMesh, buildKit, labelFootprint, layoutBatch,
  parseLabels, makeSafeName, uniqueSafeNames,
} from '../lib/labelgen.js';
import { write3mf } from '../lib/threemf.js';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const load = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const font = opentype.parse(load(join(web, 'fonts/Arimo-Regular.woff')));
const rail = parseStl(load(join(web, 'templates/rail.stl')));
const holder2 = parseStl(load(join(web, 'templates/2CU/holder.stl')));

/** Every directed edge must be matched by its reverse exactly once. */
function assertWatertight(tris, what) {
  const key = (i) => `${tris[i].toFixed(4)},${tris[i + 1].toFixed(4)},${tris[i + 2].toFixed(4)}`;
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // zero-area sliver
    for (let k = 0; k < 3; k++) {
      const e = `${v[k]}|${v[(k + 1) % 3]}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    if (n !== 1 || edges.get(`${b}|${a}`) !== 1) bad++;
  }
  assert.equal(bad, 0, `${what}: ${bad} unmatched edges`);
}

/** Signed volume via the divergence theorem; positive = outward normals. */
function volume(tris) {
  let v = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(t, t + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

test('box mesh is a closed, outward-facing slab', () => {
  const b = boxMesh(78, 12, 0.4);
  assert.equal(b.length / 9, 12);
  assertWatertight(b, 'box');
  assert.ok(Math.abs(volume(b) - 78 * 12 * 0.4) < 1e-3);
});

test('text mesh is watertight with outward normals for tricky glyphs', () => {
  for (const s of ['M5 Bolts', 'B8 @%&', '1/4" Wrench', 'Qg0ÆØ°']) {
    const t = buildTextMesh(font, s, { labelLength: 78, labelWidth: 12, fill: 0.75, depth: 0.4 });
    assert.ok(t.length > 0, s);
    assertWatertight(t, s);
    assert.ok(volume(t) > 0, `${s}: inside-out`);
  }
});

test('every glyph of both bundled fonts extrudes watertight', () => {
  // '#' once produced T-junctions (hole edge collinear with the outer edge).
  const chars = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~°±µ×÷ÆØåé';
  for (const file of ['Arimo-Regular.woff', 'Arimo-Bold.woff']) {
    const f = opentype.parse(load(join(web, 'fonts', file)));
    for (const c of chars) {
      assertWatertight(buildTextMesh(f, c, { labelLength: 78, labelWidth: 12, fill: 0.75, depth: 0.4 }), `${file} '${c}'`);
    }
  }
});

test('text fits inside fill fraction of the label', () => {
  for (const s of ['SD Cards', 'Snaps and Misc Connectors and Wires', 'i']) {
    const f = fitText(font, s, 78, 12, 0.75);
    assert.ok(f.width <= 78 * 0.75 + 1e-6, `${s} too wide`);
    assert.ok(f.height <= 12 * 0.75 + 1e-6, `${s} too tall`);
  }
  assert.equal(fitText(font, '   ', 78, 12, 0.75), null);
});

test('short labels share letter height across a batch', () => {
  const a = fitText(font, 'SD', 78, 12, 0.75);
  const b = fitText(font, 'M5', 78, 12, 0.75);
  assert.equal(a.scale, b.scale);
});

test('kit: text sits centred on the label top face', () => {
  const kit = buildKit({ text: 'M5 Bolts', font, size: '2CU' });
  const lb = bounds(kit.label);
  const tb = bounds(kit.text);
  assert.deepEqual(lb.min.map((v) => +v.toFixed(3)), [0, 0, 0]);
  assert.deepEqual(lb.max.map((v) => +v.toFixed(3)), [78, 12, 0.4]);
  assert.ok(Math.abs(tb.min[2] - 0.4) < 1e-5 && Math.abs(tb.max[2] - 0.8) < 1e-5);
  assert.ok(Math.abs((tb.min[0] + tb.max[0]) / 2 - 39) < 1e-3, 'not centred in X');
  assert.ok(tb.min[1] > 0 && tb.max[1] < 12);
  assert.equal(kit.holder, undefined);
});

test('kit: holder and rail are on the bed and clear of the label', () => {
  const kit = buildKit({ text: 'X', font, size: '2CU', holder: holder2, rail });
  const lb = bounds(kit.label), hb = bounds(kit.holder), rb = bounds(kit.rail);
  assert.ok(Math.abs(hb.min[2]) < 1e-4 && Math.abs(rb.min[2]) < 1e-4);
  assert.ok(hb.min[0] >= lb.max[0] + 4.99);
  assert.ok(rb.min[0] >= hb.max[0] + 4.99);
});

test('custom size: reads along the longer side, rejects tiny sizes', () => {
  assert.deepEqual(labelFootprint(CUSTOM_SIZE, { length: 10, width: 50 }), { length: 50, width: 10 });
  assert.throws(() => labelFootprint(CUSTOM_SIZE, { length: 4, width: 50 }));
  assert.throws(() => labelFootprint('9CU'));
  const kit = buildKit({ text: 'Hi', font, size: CUSTOM_SIZE, custom: { length: 40, width: 20 } });
  assert.deepEqual(bounds(kit.label).max.map((v) => +v.toFixed(3)), [40, 20, 0.4]);
});

test('stock sizes match the template label blanks', () => {
  for (const size of ['1CU', '2CU']) {
    const b = bounds(parseStl(load(join(web, `templates/${size}/label.stl`))));
    const dims = [0, 1, 2].map((i) => b.max[i] - b.min[i]).sort((x, y) => y - x);
    assert.ok(Math.abs(dims[0] - SIZES[size].length) < 0.01, size);
    assert.ok(Math.abs(dims[1] - SIZES[size].width) < 0.01, size);
  }
});

test('batch layout stacks kits without overlap', () => {
  const kits = layoutBatch(['A', 'B', 'C'].map((t) => buildKit({ text: t, font, size: '2CU', holder: holder2 })));
  for (let i = 1; i < kits.length; i++) {
    const prev = Math.min(...Object.values(kits[i - 1]).map((t) => bounds(t).min[1]));
    const cur = Math.max(...Object.values(kits[i]).map((t) => bounds(t).max[1]));
    assert.ok(cur <= prev - 4.99);
  }
});

test('binary STL round-trips', () => {
  const kit = buildKit({ text: 'Round trip', font, size: '1CU' });
  const tris = mergeTriangles(kit.label, kit.text);
  const back = parseStl(writeBinaryStl(tris).buffer);
  assert.equal(back.length, tris.length);
  assert.ok(back.every((v, i) => Math.abs(v - tris[i]) < 1e-5));
});

test('ASCII STL parses (1CU label template is ASCII)', () => {
  assert.equal(parseStl(load(join(web, 'templates/1CU/label.stl'))).length, 12 * 9);
});

test('3MF has named flat objects and four materials', () => {
  const texts = ['M5 Bolts', 'M5 Bolts'];
  const names = uniqueSafeNames(texts);
  const kits = layoutBatch(texts.map((t) => buildKit({ text: t, font, size: '2CU', rail })))
    .map((k, i) => ({ ...k, safe: names[i] }));
  const files = unzipSync(write3mf(kits));
  assert.ok(files['[Content_Types].xml'] && files['_rels/.rels']);
  const model = strFromU8(files['3D/3dmodel.model']);
  for (const n of ['body_M5_Bolts', 'rail_M5_Bolts', 'body_M5_Bolts_2', 'rail_M5_Bolts_2']) {
    assert.ok(model.includes(`name="${n}"`), n);
  }
  assert.equal((model.match(/<base /g) || []).length, 4);
  assert.equal((model.match(/<item /g) || []).length, 4);
});

test('label list parsing and safe names match labelgen.py', () => {
  assert.deepEqual(parseLabels('SD Cards\n\n# comment\r\n  M5 Bolts  \n'), ['SD Cards', 'M5 Bolts']);
  assert.equal(makeSafeName('1/4" Drive'), '1-4in_Drive');
  assert.equal(makeSafeName("Bob's"), 'Bobs');
  assert.equal(makeSafeName('°°'), 'label');
  assert.deepEqual(uniqueSafeNames(['a', 'a', 'a']), ['a', 'a_2', 'a_3']);
});

// ─── Plate packing (Send to Print Garden) ───────────────────────────────────
import { packPlates, PLATE } from '../lib/plates.js';


test('plates: every kit placed once, in order, inside the bed margin', () => {
  const texts = Array.from({ length: 50 }, (_, i) => `Bin ${i + 1}`);
  const kits = texts.map((t) => buildKit({ text: t, font, size: '2CU' }));
  const plates = packPlates(kits);
  assert.deepEqual(plates.flatMap((p) => p.kitIndexes), texts.map((_, i) => i));
  assert.ok(plates.length >= 2, 'expected more than one plate for 50 2CU labels');
  for (const b of plates.map((p) => bounds(p.tris))) {
    assert.ok(b.min[0] >= PLATE.margin - 1e-4 && b.min[1] >= PLATE.margin - 1e-4);
    assert.ok(b.max[0] <= PLATE.width - PLATE.margin + 1e-4 && b.max[1] <= PLATE.depth - PLATE.margin + 1e-4);
    assert.ok(Math.abs(b.min[2]) < 1e-5);
  }
});

test('plates: kits on a plate do not overlap', () => {
  const kits = ['A', 'B', 'C', 'D', 'E'].map((t) => buildKit({ text: t, font, size: '2CU', holder: holder2, rail }));
  const [plate] = packPlates(kits);
  // Re-derive each kit's placed box from the plate by splitting on kit order.
  const sizes = kits.map((k) => mergeTriangles(...Object.values(k)).length);
  const boxes = [];
  let off = 0;
  for (const n of sizes) { boxes.push(bounds(plate.tris.subarray(off, off + n))); off += n; }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], c = boxes[j];
    const overlap = a.min[0] < c.max[0] && c.min[0] < a.max[0] && a.min[1] < c.max[1] && c.min[1] < a.max[1];
    assert.ok(!overlap, `kits ${i} and ${j} overlap`);
  }
});

test('plates: oversized label is rejected with a clear message', () => {
  const kit = buildKit({ text: 'Huge', font, size: CUSTOM_SIZE, custom: { length: 300, width: 20 } });
  assert.throws(() => packPlates([kit]), /larger than a 256 mm plate/);
});
