import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import opentype from './vendor/opentype.module.js';
import { zipSync } from './vendor/fflate.module.js';
import { parseStl, writeBinaryStl, mergeTriangles, bounds } from './lib/stl.js';
import {
  SIZES, DEFAULT_SIZE, CUSTOM_SIZE, RAIL_URL, DEFAULTS,
  buildKit, labelFootprint, layoutBatch, parseLabels, uniqueSafeNames,
} from './lib/labelgen.js';
import { write3mf, MATERIAL_COLORS } from './lib/threemf.js';

const $ = (id) => document.getElementById(id);

// Print Garden loads this page in an iframe with ?embed; take on its theme.
if (new URLSearchParams(location.search).has('embed')) {
  document.documentElement.dataset.theme = 'garden';
}
const gardenTheme = document.documentElement.dataset.theme === 'garden';

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  mode: 'single',
  size: DEFAULT_SIZE,
  font: null,
  fontUrl: $('font').value,
};
const templateCache = new Map(); // url → Promise<Float32Array|null>

function loadTemplate(url) {
  if (!templateCache.has(url)) {
    templateCache.set(url, fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? parseStl(b) : null))
      .catch(() => null));
  }
  return templateCache.get(url);
}

const fonts = new Map(); // option value → Promise<Font>
function fontFor(value) {
  if (!fonts.has(value)) fonts.set(value, loadFont(value));
  return fonts.get(value);
}

async function loadFont(source) {
  const buf = typeof source === 'string'
    ? await (await fetch(source)).arrayBuffer()
    : await source.arrayBuffer();
  return opentype.parse(buf);
}

// ─── Inputs → options ───────────────────────────────────────────────────────
function texts() {
  if (state.mode === 'single') {
    const t = $('text').value.trim();
    return t ? [t] : [];
  }
  return parseLabels($('batch').value);
}

function custom() {
  return { length: +$('custom-l').value, width: +$('custom-w').value };
}

async function kitOptions() {
  const isCustom = state.size === CUSTOM_SIZE;
  const holderUrl = isCustom ? null : SIZES[state.size].holder;
  const wantHolder = $('holder').checked && !$('holder').disabled;
  return {
    font: state.font,
    size: state.size,
    custom: isCustom ? custom() : undefined,
    fill: +$('fill').value / 100,
    textDepth: +$('text-depth').value || DEFAULTS.textDepth,
    labelThickness: +$('thickness').value || DEFAULTS.labelThickness,
    holder: wantHolder && holderUrl ? await loadTemplate(holderUrl) : null,
    rail: $('rail').checked ? await loadTemplate(RAIL_URL) : null,
  };
}

// ─── Size picker ────────────────────────────────────────────────────────────
for (const key of [...Object.keys(SIZES), CUSTOM_SIZE]) {
  const b = document.createElement('button');
  b.textContent = key;
  b.dataset.size = key;
  b.setAttribute('aria-pressed', String(key === state.size));
  b.addEventListener('click', () => { state.size = key; onSizeChange(); });
  $('sizes').append(b);
}

async function onSizeChange() {
  for (const b of $('sizes').children) b.setAttribute('aria-pressed', String(b.dataset.size === state.size));
  const isCustom = state.size === CUSTOM_SIZE;
  $('custom').hidden = !isCustom;

  let note = '';
  if (!isCustom) {
    const s = SIZES[state.size];
    note = `${s.length} × ${s.width} mm label`;
    if (s.provisional) note += ' — provisional footprint (no 3CU templates yet)';
  } else {
    note = 'Text reads along the longer side. No holder for custom sizes.';
  }
  $('size-note').textContent = note;

  // Holder only when this size has a holder.stl on disk.
  const holderEl = $('holder');
  const url = isCustom ? null : SIZES[state.size].holder;
  const available = url ? !!(await loadTemplate(url)) : false;
  holderEl.disabled = !available;
  $('holder-note').textContent = available ? '' : isCustom ? '(stock sizes only)' : `(no ${state.size}/holder.stl)`;
  refresh({ refit: true });
}

// ─── Preview ────────────────────────────────────────────────────────────────
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-60, -100, 160);
scene.add(sun);
const grid = new THREE.GridHelper(400, 40);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

const hex = (c) => new THREE.Color(c.slice(0, 7));
const materials = Object.fromEntries(Object.entries(MATERIAL_COLORS).map(([k, c]) => [k,
  new THREE.MeshStandardMaterial({ color: hex(c), roughness: 0.7, metalness: 0 })]));
const kitGroup = new THREE.Group();
scene.add(kitGroup);

function applyTheme() {
  const dark = gardenTheme || matchMedia('(prefers-color-scheme: dark)').matches;
  scene.background = new THREE.Color(gardenTheme ? 0x0f1420 : dark ? 0x242428 : 0xe9eae6);
  grid.material.color = new THREE.Color(gardenTheme ? 0x64748b : dark ? 0x55555c : 0x9a9a94);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function showKit(kit, refit) {
  for (const m of kitGroup.children) m.geometry.dispose();
  kitGroup.clear();
  for (const [part, tris] of Object.entries(kit)) {
    if (!tris.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.computeVertexNormals();
    kitGroup.add(new THREE.Mesh(g, materials[part]));
  }
  const b = bounds(mergeTriangles(...Object.values(kit)));
  const size = b.max.map((v, i) => v - b.min[i]);
  const { length, width } = labelFootprint(state.size, state.size === CUSTOM_SIZE ? custom() : undefined);
  $('dims').textContent = `label ${+length.toFixed(2)} × ${+width.toFixed(2)} mm · plate ${size.map((v) => v.toFixed(1)).join(' × ')} mm`;
  if (refit) fitCamera(b);
}

function fitCamera(b) {
  const c = new THREE.Vector3(...b.min.map((v, i) => (v + b.max[i]) / 2));
  const r = Math.max(...b.max.map((v, i) => v - b.min[i])) * 0.5;
  const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.7;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0, -0.75, 0.9).normalize().multiplyScalar(dist + 10));
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (canvas.width !== Math.floor(w * devicePixelRatio) || canvas.height !== Math.floor(h * devicePixelRatio)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
renderer.setAnimationLoop(() => { resize(); controls.update(); renderer.render(scene, camera); });

// ─── Refresh ────────────────────────────────────────────────────────────────
let timer = 0;
let pendingRefit = false;
function refresh({ refit = false } = {}) {
  pendingRefit ||= refit;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const doRefit = pendingRefit;
    pendingRefit = false;
    updateBatchUi();
    if (!state.font) return;
    const all = texts();
    const pick = state.mode === 'batch' ? all[+$('preview-pick').value] ?? all[0] : all[0];
    try {
      const kit = buildKit({ ...(await kitOptions()), text: pick ?? '' });
      showKit(kit, doRefit || kitGroup.children.length === 0);
      setStatus('');
    } catch (e) {
      setStatus(e.message, true);
    }
    const ok = all.length > 0;
    for (const id of ['dl-stl', 'dl-parts', 'dl-3mf']) $(id).disabled = !ok;
    $('dl-stl').textContent = state.mode === 'batch' && all.length > 1 ? `Download ${all.length} STLs (.zip)` : 'Download STL';
  }, 60);
}

function updateBatchUi() {
  if (state.mode !== 'batch') return;
  const all = parseLabels($('batch').value);
  $('batch-count').textContent = `${all.length} label${all.length === 1 ? '' : 's'}`;
  const sel = $('preview-pick');
  const prev = sel.value;
  const names = all.map((t, i) => `${i}\u0000${t}`).join('\n');
  if (sel.dataset.names !== names) {
    sel.dataset.names = names;
    sel.replaceChildren(...all.map((t, i) => new Option(t, String(i))));
    if (prev && +prev < all.length) sel.value = prev;
  }
}

function setStatus(msg, error = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
}

// ─── Downloads ──────────────────────────────────────────────────────────────
function save(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sizeTag() {
  if (state.size !== CUSTOM_SIZE) return state.size;
  const { length, width } = custom();
  return `custom-${length}x${width}mm`;
}

async function buildAll() {
  const list = texts();
  const opts = await kitOptions();
  const names = uniqueSafeNames(list);
  return list.map((text, i) => ({ text, safe: names[i], kit: buildKit({ ...opts, text }) }));
}

async function download(kind) {
  try {
    setStatus('Generating…');
    const items = await buildAll();
    const tag = sizeTag();
    const single = items.length === 1;

    if (kind === 'stl') {
      // One STL per label with every selected part in it.
      const files = Object.fromEntries(items.map(({ safe, kit }) =>
        [`${safe}-${tag}.stl`, writeBinaryStl(mergeTriangles(...Object.values(kit)), safe)]));
      if (single) {
        const [[name, bytes]] = Object.entries(files);
        save(bytes, name, 'model/stl');
      } else {
        save(zipSync(files), `labels-${tag}.zip`, 'application/zip');
      }
    } else if (kind === 'parts') {
      const files = {};
      for (const { safe, kit } of items) {
        for (const [part, tris] of Object.entries(kit)) {
          if (!tris.length) continue;
          const path = single ? `${safe}-${part}.stl` : `${safe}/${safe}-${part}.stl`;
          files[path] = writeBinaryStl(tris, `${safe} ${part}`);
        }
      }
      save(zipSync(files), single ? `${items[0].safe}-${tag}-parts.zip` : `labels-${tag}-parts.zip`, 'application/zip');
    } else {
      const laid = layoutBatch(items.map((it) => it.kit)).map((kit, i) => ({ ...kit, safe: items[i].safe }));
      save(write3mf(laid), single ? `${items[0].safe}-${tag}.3mf` : `labels-${tag}.3mf`, 'model/3mf');
    }
    setStatus(`Saved ${items.length} label${single ? '' : 's'}.`);
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    for (const t of document.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    $('single-input').hidden = state.mode !== 'single';
    $('batch-input').hidden = state.mode !== 'batch';
    refresh();
  });
}

for (const id of ['text', 'batch', 'fill', 'text-depth', 'thickness', 'preview-pick']) {
  $(id).addEventListener('input', () => refresh());
}
for (const id of ['custom-l', 'custom-w', 'holder', 'rail']) {
  $(id).addEventListener('input', () => refresh({ refit: true }));
}
$('fill').addEventListener('input', () => { $('fill-out').textContent = `${$('fill').value}%`; });

$('load-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('batch').value = await f.text();
  $('file').value = '';
  refresh();
});

$('font').addEventListener('change', async () => {
  if ($('font').value === 'upload') {
    $('font-file').click();
    $('font').value = state.fontUrl; // revert until a file is chosen
    return;
  }
  state.fontUrl = $('font').value;
  state.font = await fontFor(state.fontUrl);
  refresh();
});
$('font-file').addEventListener('change', async () => {
  const f = $('font-file').files[0];
  if (!f) return;
  try {
    const font = await loadFont(f);
    const opt = new Option(f.name, `file:${f.name}`);
    fonts.set(opt.value, Promise.resolve(font));
    state.font = font;
    $('font').insertBefore(opt, $('font').lastElementChild);
    $('font').value = state.fontUrl = opt.value;
    refresh();
  } catch (e) {
    setStatus(`Could not read font: ${e.message}`, true);
  }
  $('font-file').value = '';
});

$('dl-stl').addEventListener('click', () => download('stl'));
$('dl-parts').addEventListener('click', () => download('parts'));
$('dl-3mf').addEventListener('click', () => download('3mf'));

// ─── Boot ───────────────────────────────────────────────────────────────────
state.font = await fontFor(state.fontUrl);
onSizeChange();
