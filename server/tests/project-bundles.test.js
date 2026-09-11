const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildZip } = require('./helpers/build-zip');

let db;
let app;
let tempDir;

function bundle(entries) {
  return buildZip(entries, { deflate: true });
}

function manifest(parts) {
  return JSON.stringify({
    schema_version: 1,
    project_name: 'Bracket batch',
    source_root: 'brackets',
    profiles: [],
    parts,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      source_path TEXT,
      source_relpath TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      material_grams REAL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_models (
      model_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      connector TEXT NOT NULL
    );
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa');
    INSERT INTO printer_models VALUES ('p1s', 'P1S', 'bambu');
  `);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bundles-test-'));
  app = express();
  app.use('/api/project-bundles', require('../routes/project-bundles')(db, {
    uploadDir: path.join(tempDir, 'uploads'),
    projectsDir: path.join(tempDir, 'projects'),
    gcodeDir: path.join(tempDir, 'gcode'),
  }));
});

afterEach(() => {
  if (db) db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('part source columns remain nullable for existing parts', () => {
  const now = Date.now();
  const project = db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)')
    .run('Existing', now, now);
  const part = db.prepare('INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
    .run(project.lastInsertRowid, 'Legacy part', now, now);

  expect(db.prepare('SELECT source_path, source_relpath FROM parts WHERE id = ?').get(part.lastInsertRowid))
    .toEqual({ source_path: null, source_relpath: null });
});

test('imports two parts, originals, printer-specific slices, and reported failures', async () => {
  const archive = bundle({
    'manifest.json': manifest([
      {
        id: 'left-bracket-aaa111', name: 'Left bracket', source_relpath: 'left/bracket.stl', failures: [],
        slices: [{ profile_key: 'mk4s', printer_model: 'mk4s', filename: 'left.bgcode', archive_path: 'slices/mk4s/left-bracket-aaa111.bgcode', parts_per_plate: 2, est_print_secs: 3600, material_grams: 12.5 }],
      },
      {
        id: 'right-bracket-bbb222', name: 'Right bracket', source_relpath: 'right/bracket.stl',
        failures: [{ profile_key: 'p1s', printer_model: 'p1s', detail: 'slicer exited 1', cancelled: false }],
        slices: [{ profile_key: 'p1s', printer_model: 'p1s', filename: 'right.3mf', archive_path: 'slices/p1s/right-bracket-bbb222.3mf', parts_per_plate: 1, est_print_secs: 1800, material_grams: 8 }],
      },
    ]),
    'originals/left/bracket.stl': 'left original',
    'originals/right/bracket.stl': 'right original',
    'slices/mk4s/left-bracket-aaa111.bgcode': 'left slice',
    'slices/p1s/right-bracket-bbb222.3mf': 'right slice',
  });

  const res = await request(app)
    .post('/api/project-bundles/import')
    .attach('file', archive, 'brackets.zip');

  expect(res.status).toBe(201);
  expect(res.body.project).toMatchObject({ name: 'Bracket batch', status: 'draft' });
  expect(res.body.parts).toHaveLength(2);
  expect(res.body.failures).toEqual([{ part_id: 'right-bracket-bbb222', profile_key: 'p1s', printer_model: 'p1s', detail: 'slicer exited 1', cancelled: false }]);

  const parts = db.prepare('SELECT * FROM parts ORDER BY source_relpath').all();
  expect(parts.map(({ name, target_qty, source_relpath }) => ({ name, target_qty, source_relpath }))).toEqual([
    { name: 'Left bracket', target_qty: 1, source_relpath: 'left/bracket.stl' },
    { name: 'Right bracket', target_qty: 1, source_relpath: 'right/bracket.stl' },
  ]);
  expect(parts.every((part) => fs.readFileSync(part.source_path, 'utf8').endsWith(' original'))).toBe(true);

  const gcodes = db.prepare('SELECT * FROM gcodes ORDER BY printer_model').all();
  expect(gcodes.map(({ printer_model, filename, parts_per_plate, est_print_secs, material_grams }) =>
    ({ printer_model, filename, parts_per_plate, est_print_secs, material_grams }))).toEqual([
    { printer_model: 'mk4s', filename: 'left.bgcode', parts_per_plate: 2, est_print_secs: 3600, material_grams: 12.5 },
    { printer_model: 'p1s', filename: 'right.3mf', parts_per_plate: 1, est_print_secs: 1800, material_grams: 8 },
  ]);
  expect(gcodes.map((gcode) => fs.readFileSync(path.join(tempDir, 'gcode', gcode.filepath), 'utf8')))
    .toEqual(['left slice', 'right slice']);
});

test('rejects an unknown printer model without retaining rows or files', async () => {
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'bracket-unknown', name: 'Bracket', source_relpath: 'bracket.stl', failures: [],
      slices: [{ profile_key: 'unknown', printer_model: 'unknown', filename: 'bracket.gcode', archive_path: 'slices/unknown/bracket-unknown.gcode', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
    }]),
    'originals/bracket.stl': 'original',
    'slices/unknown/bracket-unknown.gcode': 'slice',
  });

  const res = await request(app)
    .post('/api/project-bundles/import')
    .attach('file', archive, 'unknown-model.zip');

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Unknown model "unknown".*Settings → Printer Models/i);
  expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS count FROM parts').get().count).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS count FROM gcodes').get().count).toBe(0);
});

test.each([
  ['a wrong schema version', { schema_version: 2 }, /schema_version/],
  ['an empty parts list', { parts: [] }, /at least one part/],
  ['a traversal source path', { source_relpath: '../bracket.stl' }, /safe relative path/],
  ['an unsupported slice extension', { archive_path: 'slices/mk4s/bracket-123456.exe' }, /Unsupported slice extension/],
])('rejects %s before creating any managed records', async (_description, override, expectedError) => {
  const part = {
    id: 'bracket-123456', name: 'Bracket', source_relpath: 'bracket.stl', failures: [],
    slices: [{ profile_key: 'mk4s', printer_model: 'mk4s', filename: 'bracket.gcode', archive_path: 'slices/mk4s/bracket-123456.gcode', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
  };
  const body = JSON.parse(manifest([part]));
  if (override.parts) body.parts = override.parts;
  else if (override.schema_version) body.schema_version = override.schema_version;
  else Object.assign(body.parts[0].slices[0], override) && Object.assign(body.parts[0], override);
  const archive = bundle({
    'manifest.json': JSON.stringify(body),
    'originals/bracket.stl': 'original',
    'slices/mk4s/bracket-123456.gcode': 'slice',
    'slices/mk4s/bracket-123456.exe': 'slice',
  });

  const res = await request(app).post('/api/project-bundles/import').attach('file', archive, 'invalid.zip');

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(expectedError);
  expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
});
