// previewNextJob (garden/fleet/next-job.js) and GET /garden/api/fleet/next-jobs.
// The preview mirrors JobScheduler._reserveJob, so every scenario also runs the real
// reservation on the same DB and asserts both pick the same G-code. Run this after
// every upstream rebase: it is what catches the mirror drifting from the scheduler.
//
// Needs the repo's better-sqlite3 and express (native module, Node 22), so run it in
// the deps image, e.g.:
//   docker run --rm -v "$PWD":/app -v /app/node_modules <deps image> \
//     node --test garden/fleet/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let Database, express;
try { Database = require('better-sqlite3'); express = require('express'); } catch { /* skip below */ }
const skip = Database && express ? false : 'better-sqlite3/express not installed here';

const here = dirname(fileURLToPath(import.meta.url));
const GCODE_DIR = join(here, '..', '..', '..', 'server', 'gcode');
const stamp = Date.now();
const fileA = `nextjob_a_${stamp}.bgcode`;
const fileB = `nextjob_b_${stamp}.bgcode`;
const fileMissing = `nextjob_missing_${stamp}.bgcode`;

let JobScheduler, previewNextJob, routes;
before(() => {
  if (skip) return;
  mkdirSync(GCODE_DIR, { recursive: true });
  writeFileSync(join(GCODE_DIR, fileA), 'G28');
  writeFileSync(join(GCODE_DIR, fileB), 'G28');
  JobScheduler = require('../../../server/scheduler');
  ({ previewNextJob } = require('../next-job'));
  routes = require('../routes');
});
after(() => {
  for (const f of [fileA, fileB]) { try { unlinkSync(join(GCODE_DIR, f)); } catch {} }
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
      group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT,
      allowed_groups TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, status, created_at) VALUES ('P1', '192.0.2.1', 'k', 'mk4s', 'IDLE', ?)`).run(now);
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, status, created_at) VALUES ('P2', '192.0.2.2', 'k', 'mk4s', 'PRINTING', ?)`).run(now);
  return db;
}

function addProject(db, name, priority, extra = {}) {
  const now = Date.now();
  return db.prepare(`INSERT INTO projects (name, status, priority, required_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(name, extra.status || 'active', priority, extra.color || null, now, now).lastInsertRowid;
}
function addPart(db, projectId, name, { target = 10, completed = 0, sort = 0, file = fileA, ppp = 2 } = {}) {
  const now = Date.now();
  const partId = db.prepare(`INSERT INTO parts (project_id, name, target_qty, completed_qty, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, name, target, completed, sort, now, now).lastInsertRowid;
  db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'mk4s', ?, ?, ?, ?)`)
    .run(partId, file, file, ppp, now);
  return partId;
}

const printer = (db, id = 1) => db.prepare('SELECT * FROM printers WHERE id = ?').get(id);

// Run the real scheduler reservation, then delete its probe job so the DB is unchanged.
function schedulerPick(db, p) {
  const scheduler = new JobScheduler(db, { on() {} });
  const reservation = scheduler._reserveJob(p);
  if (!reservation) return null;
  db.prepare('DELETE FROM jobs WHERE id = ?').run(reservation.jobId);
  return reservation.candidate.gcode_id;
}

function expectAgrees(db, p) {
  const preview = previewNextJob(db, p);
  assert.equal(preview ? preview.gcode_id : null, schedulerPick(db, p), 'preview disagrees with _reserveJob');
  return preview;
}

test('picks the highest-priority project first, with names for the card', { skip }, () => {
  const db = makeDb();
  const low  = addProject(db, 'Low', 5);
  const high = addProject(db, 'High', 1);
  addPart(db, low, 'Bucket');
  addPart(db, high, 'Boom arm');
  const preview = expectAgrees(db, printer(db));
  assert.equal(preview.part_name, 'Boom arm');
  assert.equal(preview.project_name, 'High');
  assert.equal(preview.filename, fileA);
  assert.equal(preview.parts_per_plate, 2);
  assert.equal(preview.remaining_qty, 10);
});

test('falls through a part whose in-flight jobs already cover the remaining qty', { skip }, () => {
  const db = makeDb();
  const proj = addProject(db, 'Loader', 0);
  const covered = addPart(db, proj, 'Covered', { target: 4, sort: 0 });
  addPart(db, proj, 'Wheel', { sort: 1, file: fileB });
  db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, 2, 1, 4, 'printing', ?)`).run(covered, Date.now());
  assert.equal(expectAgrees(db, printer(db)).part_name, 'Wheel');
});

test('skips a part whose G-code file is missing on disk', { skip }, () => {
  const db = makeDb();
  const proj = addProject(db, 'Loader', 0);
  addPart(db, proj, 'Ghost', { sort: 0, file: fileMissing });
  addPart(db, proj, 'Cab', { sort: 1, file: fileB });
  assert.equal(expectAgrees(db, printer(db)).part_name, 'Cab');
});

test('respects project status and color targeting', { skip }, () => {
  const db = makeDb();
  addPart(db, addProject(db, 'Paused', 0, { status: 'paused' }), 'Paused part');
  addPart(db, addProject(db, 'Red only', 1, { color: 'Red' }), 'Red part');
  assert.equal(expectAgrees(db, printer(db)), null);
  db.prepare("UPDATE printers SET loaded_color = 'Red' WHERE id = 1").run();
  assert.equal(expectAgrees(db, printer(db)).part_name, 'Red part');
});

test('is read-only: inserts no jobs', { skip }, () => {
  const db = makeDb();
  addPart(db, addProject(db, 'Loader', 0), 'Bucket');
  previewNextJob(db, printer(db));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
});

test('GET /next-jobs maps every active printer id to its preview', { skip }, async () => {
  const db = makeDb();
  addPart(db, addProject(db, 'Loader', 0), 'Bucket');
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, is_active, created_at) VALUES ('Gone', '192.0.2.3', 'k', 'mk4s', 0, ?)`).run(Date.now());
  const app = express();
  app.use('/garden/api/fleet', routes(db));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/garden/api/fleet/next-jobs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['1', '2']);
    assert.equal(body['1'].part_name, 'Bucket');
    assert.equal(body['2'].part_name, 'Bucket');
  } finally {
    server.close();
  }
});
