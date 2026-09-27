// Label job queue API. Needs the repo's express + multer, so run it where
// they are installed, e.g. inside the image:
//   docker run --rm -v "$PWD":/app -v /app/node_modules <deps image> \
//     node --test garden/labels/tests/server.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let express;
try { express = require('express'); } catch { /* handled below */ }
const skip = express ? false : 'express/multer not installed here';

let server, base, dir;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'garden-labels-'));
  const app = express();
  app.use(express.json());
  app.use('/q', require('../server.cjs')(dir));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/q`;
});
after(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
function submit(project = 'Labels test', plates = [{ count: 2, labels: ['A', 'B'] }]) {
  const form = new FormData();
  form.append('meta', JSON.stringify({ project, size: '2CU', plates }));
  plates.forEach((_, i) => form.append('plates', new Blob([`solid p${i + 1}\nendsolid`]), `plate-${i + 1}.stl`));
  return fetch(base + '/jobs', { method: 'POST', body: form });
}

test('job lifecycle: submit → claim → plates → progress → done', { skip }, async () => {
  const res = await submit('Pantry', [{ count: 2, labels: ['A', 'B'] }, { count: 1, labels: ['C'] }]);
  assert.equal(res.status, 201);
  const job = await res.json();
  assert.equal(job.status, 'queued');
  assert.deepEqual(job.progress, { done: 0, total: 2 });

  const claimed = await (await post('/jobs/claim')).json();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'slicing');
  assert.equal((await post('/jobs/claim')).status, 204, 'a claimed job is not handed out twice');
  assert.ok((await (await fetch(base + '/health')).json()).worker_seen_at);

  const plate2 = await fetch(`${base}/jobs/${job.id}/plates/2`);
  assert.equal(plate2.status, 200);
  assert.match(await plate2.text(), /solid p2/);

  await post(`/jobs/${job.id}/progress`, { done: 1, message: 'Plate 1 of 2 loaded', project_id: 42 });
  const done = await (await post(`/jobs/${job.id}/progress`, { status: 'done', done: 2, message: 'Loaded' })).json();
  assert.equal(done.status, 'done');
  assert.equal(done.project_id, 42);
  assert.deepEqual(readdirSync(join(dir, job.id)), ['job.json'], 'plate files are dropped when finished');
  assert.equal((await post(`/jobs/${job.id}/progress`, { message: 'late' })).status, 409);
});

test('bad submissions are rejected', { skip }, async () => {
  assert.equal((await submit('   ')).status, 400);
  const form = new FormData();
  form.append('meta', JSON.stringify({ project: 'X', plates: [{ count: 1, labels: [] }, { count: 1, labels: [] }] }));
  form.append('plates', new Blob(['x']), 'plate-1.stl');
  assert.equal((await fetch(base + '/jobs', { method: 'POST', body: form })).status, 400, 'plate/file count mismatch');
  assert.equal((await submit('X', [{ count: 0, labels: [] }])).status, 400);
});

test('ids cannot escape the data directory', { skip }, async () => {
  assert.equal((await fetch(`${base}/jobs/..%2F..%2Fetc`)).status, 404);
  assert.equal((await fetch(`${base}/jobs/1234/plates/1`)).status, 404);
});

test('invalid status is refused; failed also drops plates', { skip }, async () => {
  const job = await (await submit('Fails')).json();
  await post('/jobs/claim');
  assert.equal((await post(`/jobs/${job.id}/progress`, { status: 'weird' })).status, 400);
  const failed = await (await post(`/jobs/${job.id}/progress`, { status: 'failed', message: 'slice failed', log: 'x'.repeat(30000) })).json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.log.length, 20000);
  assert.deepEqual(readdirSync(join(dir, job.id)), ['job.json']);
  const list = await (await fetch(base + '/jobs')).json();
  assert.ok(list.every((j) => !('log' in j)), 'list omits logs');
});
