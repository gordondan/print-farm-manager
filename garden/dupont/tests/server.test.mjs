// Saved board API. Needs the repo's express, so run it where it is installed
// (inside the image); elsewhere it skips.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let express;
try { express = require('express'); } catch { /* handled below */ }
const skip = express ? false : 'express not installed here';

let server, base, dir;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'garden-dupont-'));
  const app = express();
  app.use('/d', require('../server.cjs')(dir));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/d`;
});
after(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const put = (id, body) => fetch(`${base}/boards/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('board lifecycle: create, list, read, replace, delete', { skip }, async () => {
  let r = await put('esp32', { board: { name: 'ESP32', length: 51.5 } });
  assert.equal(r.status, 201);
  r = await put('esp32', { board: { name: 'ESP32', length: 52 } });
  assert.equal(r.status, 200);
  const list = await (await fetch(`${base}/boards`)).json();
  assert.deepEqual(list.map((b) => b.id), ['esp32']);
  const doc = await (await fetch(`${base}/boards/esp32`)).json();
  assert.equal(doc.board.length, 52);
  assert.equal((await fetch(`${base}/boards/esp32`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/boards/esp32`)).status, 404);
});

test('rejects bad ids and missing names', { skip }, async () => {
  assert.equal((await put('Bad_Id', { board: { name: 'x' } })).status, 400);
  assert.equal((await put('ok', { board: { name: '  ' } })).status, 400);
  assert.equal((await put('ok', {})).status, 400);
  assert.equal((await fetch(`${base}/boards/..%2Fetc`)).status, 404);
});
