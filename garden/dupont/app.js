import * as THREE from 'three';
import { OrbitControls } from '../labels/vendor/OrbitControls.js';
import { writeBinaryStl, bounds } from '../labels/lib/stl.js';
import {
  DEFAULT_BOARD, DEFAULT_CLIP, SIDES, BOARD_THICKNESS, normalizeBoard, resizePins, pinCount,
  pinPositions, holePositions, railDepth, farOffset, validate, buildFrame, concat, printToBoard, pattern, slug,
} from './lib/clipgen.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const API = new URL('../api/dupont/', location.href).href;
const QUEUE = new URL('../api/labels/', location.href).href;
const DRAFT_KEY = 'garden-dupont-draft';
const BUILTIN_ID = 'builtin:default';

if (new URLSearchParams(location.search).has('embed')) document.documentElement.dataset.theme = 'garden';
const gardenTheme = document.documentElement.dataset.theme === 'garden';

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  board: normalizeBoard(DEFAULT_BOARD),
  sourceId: BUILTIN_ID, // what the board picker shows
  saved: [],            // [{ id, name, updated_at }] from the server
  serverOk: false,
  view: 'use',
};

function storeDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ sourceId: state.sourceId, board: state.board })); } catch { /* private window */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d?.board) { state.board = normalizeBoard(d.board); state.sourceId = d.sourceId || BUILTIN_ID; }
  } catch { /* ignore */ }
}

function setBoard(board, sourceId) {
  state.board = normalizeBoard(board);
  if (sourceId) state.sourceId = sourceId;
  fillForm();
  update({ refit: true });
}

function edit(fn, { refit = false } = {}) {
  fn(state.board);
  state.board = normalizeBoard(state.board);
  update({ refit });
}

// ─── Form ───────────────────────────────────────────────────────────────────
const getPath = (o, k) => k.split('.').reduce((a, p) => a?.[p], o);
function setPath(o, k, v) {
  const parts = k.split('.');
  const last = parts.pop();
  parts.reduce((a, p) => a[p], o)[last] = v;
}

function fillForm() {
  const b = state.board;
  $('name').value = b.name;
  for (const el of document.querySelectorAll('[data-k]')) {
    const v = getPath(b, el.dataset.k);
    el.value = v === null || v === undefined ? '' : String(+(+v).toFixed(4));
  }
  $('holes-on').checked = b.holes.enabled;
  $('pin-count').value = pinCount(b);
  for (const btn of $('headers').children) btn.setAttribute('aria-pressed', String(btn.dataset.v === b.headers));
  renderPinTable();
}

function renderPinTable() {
  const b = state.board;
  const rows = [];
  for (let i = 0; i < pinCount(b); i++) {
    const tr = document.createElement('tr');
    const num = document.createElement('td');
    num.textContent = i + 1;
    tr.append(num);
    for (const s of SIDES) {
      const td = document.createElement('td');
      const input = Object.assign(document.createElement('input'), { type: 'text', value: b.pins[s][i], maxLength: 24 });
      input.dataset.side = s;
      input.dataset.i = i;
      input.spellcheck = false;
      if (b.connected[s][i]) input.classList.add('on');
      td.append(input);
      tr.append(td);
    }
    rows.push(tr);
  }
  $('pin-rows').replaceChildren(...rows);
}

$('pin-rows').addEventListener('input', (e) => {
  const { side, i } = e.target.dataset;
  if (!side) return;
  state.board.pins[side][+i] = e.target.value;
  update({ table: false });
});

$('name').addEventListener('input', () => { state.board.name = $('name').value; update({ geometry: false }); });

for (const el of document.querySelectorAll('[data-k]')) {
  el.addEventListener('input', () => {
    const k = el.dataset.k;
    if (el.value === '') {
      if (k === 'farEdgeToPin1') { state.board.farEdgeToPin1 = null; update({ refit: true }); }
      return; // wait for a number
    }
    const v = +el.value;
    if (!Number.isFinite(v)) return;
    setPath(state.board, k, v);
    update({ refit: true });
  });
}
$('holes-on').addEventListener('change', () => edit((b) => { b.holes.enabled = $('holes-on').checked; }));
$('pin-count').addEventListener('change', () => {
  const n = +$('pin-count').value;
  if (!(n >= 1)) return;
  state.board = resizePins(state.board, n);
  renderPinTable();
  update({ refit: true });
});
for (const btn of $('headers').children) {
  btn.addEventListener('click', () => {
    edit((b) => { b.headers = btn.dataset.v; }, { refit: true });
    for (const x of $('headers').children) x.setAttribute('aria-pressed', String(x === btn));
  });
}
$('reset-clip').addEventListener('click', () => { state.board.clip = { ...DEFAULT_CLIP }; fillForm(); update({ refit: true }); });

for (const btn of document.querySelectorAll('[data-fill]')) {
  btn.addEventListener('click', () => {
    const [side, v] = btn.dataset.fill.split(':');
    edit((b) => { b.connected[side] = b.connected[side].map(() => v === '1'); });
  });
}

function togglePin(side, i) {
  edit((b) => { b.connected[side][i] = !b.connected[side][i]; });
}

// ─── Pinout diagram (SVG, mm units, board y up = SVG y down negated) ────────
function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.append(el);
  return el;
}

function drawPinout() {
  const b = state.board;
  const root = $('pinout');
  const focused = document.activeElement?.closest?.('#pinout .pin')?.dataset.key;
  const W = b.width, L = b.length;
  const margin = 24;
  root.setAttribute('viewBox', `${-W / 2 - margin} ${-L / 2 - 9} ${W + 2 * margin} ${L + 20}`);
  root.replaceChildren();
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim() || '#888';

  svg('text', { x: 0, y: -L / 2 - 3.5, 'text-anchor': 'middle', 'font-size': 2.4, fill: muted }, root)
    .textContent = `far end, pin 1 is ${+farOffset(b).toFixed(2)} mm in${b.farEdgeToPin1 === null ? ' (centered)' : ''}`;
  // board
  svg('rect', { x: -W / 2, y: -L / 2, width: W, height: L, rx: 1, fill: '#1f5f3f', stroke: '#2f8f5f', 'stroke-width': 0.3 }, root);
  // frame footprint (where the C sits)
  const fx = b.headers === 'up' ? 'on top' : 'underneath';
  const D = railDepth(b.clip);
  const rows = pinPositions(b);
  const frame = svg('g', { fill: 'rgba(91,143,240,.18)', stroke: 'rgba(91,143,240,.7)', 'stroke-width': 0.25, 'stroke-dasharray': b.headers === 'up' ? 'none' : '0.8 0.6' }, root);
  for (const s of SIDES) svg('rect', { x: rows[s][0].x - D / 2, y: -L / 2, width: D, height: L }, frame);
  svg('rect', { x: rows.left[0].x - D / 2, y: -L / 2, width: b.rowSpacing + D, height: D }, frame);
  // USB connector at the bottom edge
  svg('rect', { x: -4, y: L / 2 - 5, width: 8, height: 6, rx: 0.6, fill: '#b8bcc4', stroke: '#6b7280', 'stroke-width': 0.3 }, root);
  svg('text', { x: 0, y: L / 2 + 5.5, 'text-anchor': 'middle', 'font-size': 2.6, 'font-weight': 700 }, root).textContent = 'USB';
  svg('text', { x: 0, y: L / 2 + 8.6, 'text-anchor': 'middle', 'font-size': 1.8, fill: muted }, root)
    .textContent = `frame ${fx}, open at this end`;
  // mounting holes
  for (const h of holePositions(b)) svg('circle', { cx: h.x, cy: -h.y, r: b.holes.diameter / 2, fill: 'var(--bg)', stroke: '#c8a24a', 'stroke-width': 0.4 }, root);
  // header strips and pins
  for (const s of SIDES) {
    const xs = rows[s][0].x;
    const n = pinCount(b);
    svg('rect', { x: xs - b.pitch / 2, y: -rows[s][0].y - b.pitch / 2, width: b.pitch, height: n * b.pitch, fill: '#222' }, root);
    rows[s].forEach((p, i) => {
      const on = b.connected[s][i];
      const g = svg('g', { class: `pin${on ? ' on' : ''}`, tabindex: 0, role: 'button', 'aria-pressed': String(on), 'data-key': `${s}${i}` }, root);
      const label = b.pins[s][i] || `${s === 'left' ? 'L' : 'R'}${i + 1}`;
      g.setAttribute('aria-label', `${s} pin ${i + 1} ${label}`);
      // generous hit area: pad plus its label
      const left = s === 'left';
      svg('rect', { x: left ? -W / 2 - margin + 0.5 : p.x - b.pitch / 2, y: -p.y - b.pitch / 2, width: left ? p.x + W / 2 + margin - 0.5 + b.pitch / 2 : W / 2 + margin - p.x + b.pitch / 2 - 0.5, height: b.pitch, fill: 'transparent' }, g);
      svg('rect', { class: 'pad', x: p.x - 0.9, y: -p.y - 0.9, width: 1.8, height: 1.8, rx: 0.2, fill: on ? '#2f9e5b' : '#c8a24a', stroke: on ? '#9ef0bd' : 'none', 'stroke-width': 0.3 }, g);
      const tx = left ? -W / 2 - 1.8 : W / 2 + 1.8;
      svg('text', { x: tx, y: -p.y + 0.65, 'text-anchor': left ? 'end' : 'start', 'font-size': 1.8 }, g).textContent = label;
      g.addEventListener('click', () => togglePin(s, i));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(s, i); } });
      if (focused === `${s}${i}`) queueMicrotask(() => g.focus());
    });
  }
}

// ─── 3D preview ─────────────────────────────────────────────────────────────
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
const under = new THREE.DirectionalLight(0xffffff, 0.8);
under.position.set(40, 60, -120);
scene.add(under);
const grid = new THREE.GridHelper(200, 20);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.3;
scene.add(grid);

function applyTheme() {
  const dark = gardenTheme || matchMedia('(prefers-color-scheme: dark)').matches;
  scene.background = new THREE.Color(gardenTheme ? 0x0f1420 : dark ? 0x242428 : 0xe9eae6);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); drawPinout(); });

const frameMat = new THREE.MeshStandardMaterial({ color: 0x5b8ff0, roughness: 0.6 });
const boardMat = new THREE.MeshStandardMaterial({ color: 0x1f6f45, roughness: 0.8, transparent: true, opacity: 0.55, depthWrite: false });
const plasticMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 0.6, roughness: 0.4 });
const pinOnMat = new THREE.MeshStandardMaterial({ color: 0x2fce6b, roughness: 0.5 });
const usbMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.7, roughness: 0.3 });
const group = new THREE.Group();
scene.add(group);

function meshOf(tris, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function box(w, d, h, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z);
  return m;
}

function showModel(parts, refit) {
  group.traverse((o) => o.geometry?.dispose());
  group.clear();
  const b = state.board;
  const tris = concat(parts.frame, ...parts.posts);
  if (state.view === 'print') {
    group.add(meshOf(tris, frameMat));
  } else {
    group.add(meshOf(printToBoard(tris, b), frameMat));
    // board, USB, header strips and pins, in board coordinates
    group.add(box(b.width, b.length, BOARD_THICKNESS, 0, 0, BOARD_THICKNESS / 2, boardMat));
    group.add(box(8, 6, 3, 0, -b.length / 2 + 2.5, BOARD_THICKNESS + 1.5, usbMat));
    const up = b.headers === 'up';
    const n = pinCount(b);
    const rows = pinPositions(b);
    const hh = b.headerHeight;
    const plasticZ = up ? BOARD_THICKNESS + hh / 2 : -hh / 2;
    const pinLen = hh + 6;
    const pinZ = up ? BOARD_THICKNESS + pinLen / 2 : -pinLen / 2;
    const midY = (rows.left[0].y + rows.left[n - 1].y) / 2;
    for (const s of SIDES) {
      if (hh > 0) group.add(box(b.pitch, n * b.pitch, hh, rows[s][0].x, midY, plasticZ, plasticMat));
      rows[s].forEach((p, i) => group.add(box(0.64, 0.64, pinLen, p.x, p.y, pinZ, b.connected[s][i] ? pinOnMat : pinMat)));
    }
  }
  const bb = bounds(tris);
  const size = bb.max.map((v, i) => v - bb.min[i]);
  $('dims').textContent = `frame ${size.map((v) => v.toFixed(1)).join(' x ')} mm`;
  if (refit) {
    const box3 = new THREE.Box3().setFromObject(group);
    fitCamera(box3);
  }
}

function fitCamera(box3) {
  const c = box3.getCenter(new THREE.Vector3());
  const r = box3.getSize(new THREE.Vector3()).length() * 0.5;
  const dist = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  controls.target.copy(c);
  const below = state.view === 'use' && state.board.headers === 'down';
  camera.position.copy(c).add(new THREE.Vector3(0.35, -0.8, below ? -0.55 : 0.75).normalize().multiplyScalar(dist));
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (!w || !h) return;
  if (canvas.width !== Math.floor(w * devicePixelRatio) || canvas.height !== Math.floor(h * devicePixelRatio)) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
renderer.setAnimationLoop(() => { resize(); controls.update(); renderer.render(scene, camera); });

for (const btn of $('view-mode').children) {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.v;
    for (const x of $('view-mode').children) x.setAttribute('aria-pressed', String(x === btn));
    update({ refit: true, table: false });
  });
}

// ─── Update cycle ───────────────────────────────────────────────────────────
let timer = 0;
let pendingRefit = false;
let firstModel = true;
function update({ refit = false, geometry = true, table = true } = {}) {
  const b = state.board;
  $('pat-left').textContent = pattern(b, 'left');
  $('pat-right').textContent = pattern(b, 'right');
  if (table) {
    for (const input of $('pin-rows').querySelectorAll('input')) {
      input.classList.toggle('on', b.connected[input.dataset.side][+input.dataset.i]);
    }
  }
  drawPinout();
  updateBoardUi();
  storeDraft();
  const { errors, warnings } = validate(b);
  $('problems').replaceChildren(
    ...errors.map((m) => Object.assign(document.createElement('li'), { className: 'error', textContent: m })),
    ...warnings.map((m) => Object.assign(document.createElement('li'), { className: 'warning', textContent: m })),
  );
  $('dl-stl').disabled = errors.length > 0;
  $('send-btn').disabled = errors.length > 0;
  if (!geometry) return;
  pendingRefit ||= refit;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const doRefit = pendingRefit || firstModel;
    pendingRefit = false;
    if (errors.length) return;
    try {
      showModel(buildFrame(state.board), doRefit);
      firstModel = false;
    } catch (e) {
      setStatus(e.message, true);
    }
  }, 40);
}

function setStatus(msg, error = false, el = $('status')) {
  el.textContent = msg;
  el.classList.toggle('error', error);
}

// ─── Saved boards ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(API + path, opts);
  if (r.status === 204) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function refreshSaved() {
  try {
    state.saved = await api('boards');
    state.serverOk = true;
  } catch {
    state.serverOk = false;
    state.saved = [];
  }
  renderPicker();
  updateBoardUi();
}

function renderPicker() {
  const opts = [new Option(`${DEFAULT_BOARD.name} (built in)`, BUILTIN_ID)];
  for (const s of state.saved) opts.push(new Option(s.name, s.id));
  if (state.sourceId === 'file') opts.push(new Option('Opened from file', 'file'));
  $('board-pick').replaceChildren(...opts);
  $('board-pick').value = state.sourceId;
  if ($('board-pick').value !== state.sourceId) $('board-pick').value = BUILTIN_ID;
}

let pendingConfirm = null; // { button, until }
function confirmClick(button, label) {
  if (pendingConfirm?.button === button && Date.now() < pendingConfirm.until) {
    pendingConfirm = null;
    return true;
  }
  pendingConfirm = { button, until: Date.now() + 4000, text: button.textContent };
  button.textContent = label;
  setTimeout(() => { if (pendingConfirm?.button === button) { button.textContent = pendingConfirm.text; pendingConfirm = null; } updateBoardUi(); }, 4000);
  return false;
}

function updateBoardUi() {
  const id = slug(state.board.name);
  const exists = state.saved.some((s) => s.id === id);
  const isSource = state.sourceId === id;
  if (pendingConfirm?.button !== $('save')) {
    $('save').textContent = !exists ? 'Save' : isSource ? 'Save' : 'Save (replace)';
  }
  $('save').disabled = !state.serverOk || !state.board.name.trim();
  $('delete').disabled = !state.serverOk || !state.saved.some((s) => s.id === state.sourceId);
  $('board-note').textContent = !state.serverOk
    ? 'Saving needs Print Garden. Use Export / Open .json instead.'
    : exists && !isSource ? `A saved board is already called "${state.board.name}".` : 'Change the name to save a copy.';
}

$('board-pick').addEventListener('change', async () => {
  const id = $('board-pick').value;
  if (id === BUILTIN_ID) { setBoard(DEFAULT_BOARD, BUILTIN_ID); return; }
  if (id === 'file') return;
  try {
    const doc = await api(`boards/${id}`);
    setBoard(doc.board, id);
    setStatus(`Loaded ${doc.name}.`);
  } catch (e) {
    setStatus(`Could not load: ${e.message}`, true);
  }
});

$('save').addEventListener('click', async () => {
  const name = state.board.name.trim();
  const id = slug(name);
  const exists = state.saved.some((s) => s.id === id);
  if (exists && state.sourceId !== id && !confirmClick($('save'), `Replace "${name}"?`)) return;
  try {
    await api(`boards/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: state.board }) });
    state.sourceId = id;
    await refreshSaved();
    setStatus(`Saved "${name}".`);
  } catch (e) {
    setStatus(`Save failed: ${e.message}`, true);
  }
});

$('delete').addEventListener('click', async () => {
  const entry = state.saved.find((s) => s.id === state.sourceId);
  if (!entry || !confirmClick($('delete'), `Delete "${entry.name}"?`)) return;
  try {
    await api(`boards/${entry.id}`, { method: 'DELETE' });
    state.sourceId = BUILTIN_ID;
    await refreshSaved();
    setStatus(`Deleted "${entry.name}". The page still shows it until you pick another board.`);
  } catch (e) {
    setStatus(`Delete failed: ${e.message}`, true);
  }
});

$('export').addEventListener('click', () => {
  const bytes = new TextEncoder().encode(JSON.stringify(state.board, null, 2));
  saveFile(bytes, `${slug(state.board.name)}.dupont.json`, 'application/json');
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const f = $('import-file').files[0];
  $('import-file').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    state.sourceId = 'file';
    renderPicker();
    setBoard(data.board ?? data, 'file'); // accepts an export or a saved-board document
    setStatus(`Opened ${f.name}.`);
  } catch (e) {
    setStatus(`Could not read ${f.name}: ${e.message}`, true);
  }
});

// ─── Output ─────────────────────────────────────────────────────────────────
let lastUrl;
function saveFile(bytes, filename, type) {
  const blob = new Blob([bytes], { type });
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: lastUrl, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

function stlName() {
  const b = state.board;
  return `dupont-frame-${slug(b.name)}-L${pattern(b, 'left')}-R${pattern(b, 'right')}.stl`;
}

function stlBytes() {
  const { frame, posts } = buildFrame(state.board);
  return writeBinaryStl(concat(frame, ...posts), 'dupont frame');
}

$('dl-stl').addEventListener('click', () => {
  try {
    saveFile(stlBytes(), stlName(), 'model/stl');
    setStatus(`Saved ${stlName()}. Print it flat as it comes: wire side down, posts up.`);
  } catch (e) {
    setStatus(e.message, true);
  }
});

// Send to Print Garden reuses the Labels slicing queue: one plate, one part.
async function initSend() {
  try {
    const r = await fetch(QUEUE + 'health');
    if (!r.ok) return;
  } catch { return; }
  $('send').hidden = false;
  $('project').value = `Dupont frame ${state.board.name}`.slice(0, 100);
}

async function pollJob(id) {
  try {
    const j = await (await fetch(QUEUE + `jobs/${id}`)).json();
    setStatus(`${j.status}: ${j.message}`, j.status === 'failed', $('send-status'));
    if (j.status === 'queued' || j.status === 'slicing') setTimeout(() => pollJob(id), 3000);
  } catch { /* stop polling */ }
}

$('send-btn').addEventListener('click', async () => {
  const project = $('project').value.trim();
  if (!project) { setStatus('Give the project a name first.', true, $('send-status')); return; }
  $('send-btn').disabled = true;
  try {
    const b = state.board;
    const form = new FormData();
    form.append('meta', JSON.stringify({
      project,
      size: 'dupont-frame',
      plates: [{ count: 1, labels: [`${b.name} L${pattern(b, 'left')} R${pattern(b, 'right')}`] }],
    }));
    form.append('plates', new Blob([stlBytes()], { type: 'model/stl' }), 'plate-1.stl');
    const r = await fetch(QUEUE + 'jobs', { method: 'POST', body: form });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    setStatus('Queued for slicing.', false, $('send-status'));
    pollJob(body.id);
  } catch (e) {
    setStatus(`Send failed: ${e.message}`, true, $('send-status'));
  } finally {
    $('send-btn').disabled = false;
  }
});

// ─── Boot ───────────────────────────────────────────────────────────────────
loadDraft();
fillForm();
renderPicker();
update({ refit: true });
refreshSaved();
initSend();
