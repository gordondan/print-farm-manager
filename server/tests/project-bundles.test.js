const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildZip, buildSliced3mf } = require('./helpers/build-zip');
const { validateBundle, MAX_IMPORT_ENTRY_BYTES, MAX_IMPORT_TOTAL_BYTES } = require('../project-bundle');
const projectBundleRoute = require('../routes/project-bundles');

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

// Builds a tiny archive whose central directory advertises arbitrary sizes/names.
// These tests exercise importer limits without allocating the advertised payload.
function craftedCentralDirectoryArchive(entries) {
  const centralParts = entries.map(({ name, uncompressedSize = 0 }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt32LE(0, 42);
    nameBuf.copy(central, 46);
    return central;
  });
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

function setCentralDirectorySize(archive, entryName, size) {
  let offset = 0;
  while ((offset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset)) !== -1) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      archive.writeUInt32LE(size, offset + 24);
      return;
    }
    offset += 46 + nameLength;
  }
  throw new Error(`central-directory entry not found: ${entryName}`);
}

function validationDb() {
  return { prepare() { return { all() { return [{ model_id: 'mk4s' }]; } }; } };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      import_failures TEXT,
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
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER,
      gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL,
      status TEXT,
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
  app.use('/api/projects', require('../routes/projects')(db, null, {
    gcodeDir: path.join(tempDir, 'gcode'),
    projectsDir: path.join(tempDir, 'projects'),
  }));
});

afterEach(() => {
  if (db) db.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
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

test('legacy projects remain compatible with nullable import_failures', () => {
  const now = Date.now();
  const project = db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)')
    .run('Legacy project', now, now);

  expect(db.prepare('SELECT import_failures FROM projects WHERE id = ?').get(project.lastInsertRowid))
    .toEqual({ import_failures: null });
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
    'slices/p1s/right-bracket-bbb222.3mf': buildSliced3mf(),
  });

  const res = await request(app)
    .post('/api/project-bundles/import')
    .attach('file', archive, 'brackets.zip');

  expect(res.status).toBe(201);
  expect(res.body.project).toMatchObject({ name: 'Bracket batch', status: 'draft' });
  expect(res.body.parts).toHaveLength(2);
  expect(res.body.failures).toEqual([{ part_id: 'right-bracket-bbb222', profile_key: 'p1s', printer_model: 'p1s', detail: 'slicer exited 1', cancelled: false }]);
  const expectedFailures = JSON.stringify(res.body.failures);
  expect(res.body.project.import_failures).toBe(expectedFailures);
  const detail = await request(app).get(`/api/projects/${res.body.project.id}`);
  const list = await request(app).get('/api/projects');
  expect(detail.body.import_failures).toBe(expectedFailures);
  expect(list.body.find((project) => project.id === res.body.project.id).import_failures).toBe(expectedFailures);

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
  expect(fs.readFileSync(path.join(tempDir, 'gcode', gcodes[0].filepath), 'utf8')).toBe('left slice');
  expect(fs.readFileSync(path.join(tempDir, 'gcode', gcodes[1].filepath)).equals(buildSliced3mf())).toBe(true);
});

test('stores an empty failure array for a complete import', async () => {
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'complete-bracket-123456', name: 'Complete bracket', source_relpath: 'complete.stl', failures: [],
      slices: [{ profile_key: 'mk4s', printer_model: 'mk4s', filename: 'complete.gcode', archive_path: 'slices/mk4s/complete-bracket-123456.gcode', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
    }]),
    'originals/complete.stl': 'solid',
    'slices/mk4s/complete-bracket-123456.gcode': 'G28',
  });

  const res = await request(app).post('/api/project-bundles/import').attach('file', archive, 'complete.zip');

  expect(res.status).toBe(201);
  expect(res.body.failures).toEqual([]);
  expect(db.prepare('SELECT import_failures FROM projects WHERE id = ?').get(res.body.project.id))
    .toEqual({ import_failures: '[]' });
});

test('imports an original larger than the metadata ZIP limit', async () => {
  const largeOriginal = Buffer.alloc(9 * 1024 * 1024, 0x53);
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'large-bracket-123456', name: 'Large bracket', source_relpath: 'large.stl', failures: [],
      slices: [{ profile_key: 'mk4s', printer_model: 'mk4s', filename: 'large.gcode', archive_path: 'slices/mk4s/large-bracket-123456.gcode', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
    }]),
    'originals/large.stl': largeOriginal,
    'slices/mk4s/large-bracket-123456.gcode': 'G28',
  });

  const res = await request(app).post('/api/project-bundles/import').attach('file', archive, 'large.zip');

  expect(res.status).toBe(201);
  const part = db.prepare('SELECT source_path FROM parts').get();
  expect(fs.statSync(part.source_path).size).toBe(largeOriginal.length);
});

test.each([
  ['no sliced plate', buildZip({ 'Metadata/project_settings.config': '{}' }), /no sliced G-code/],
  ['only a non-first plate', buildZip({ 'Metadata/plate_7.gcode': 'G28' }), /plate_7\.gcode.*plate_1/],
])('rejects a .3mf slice with %s', async (_description, slice, expectedError) => {
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'bambu-bracket-123456', name: 'Bambu bracket', source_relpath: 'bambu.stl', failures: [],
      slices: [{ profile_key: 'p1s', printer_model: 'p1s', filename: 'bambu.3mf', archive_path: 'slices/p1s/bambu-bracket-123456.3mf', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
    }]),
    'originals/bambu.stl': 'solid',
    'slices/p1s/bambu-bracket-123456.3mf': slice,
  });
  const res = await request(app).post('/api/project-bundles/import').attach('file', archive, 'invalid-3mf.zip');

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(expectedError);
  expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(0);
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

test('deleting an imported draft project removes managed originals and G-code', async () => {
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'delete-bracket-123456', name: 'Delete bracket', source_relpath: 'delete.stl', failures: [],
      slices: [{ profile_key: 'mk4s', printer_model: 'mk4s', filename: 'delete.gcode', archive_path: 'slices/mk4s/delete-bracket-123456.gcode', parts_per_plate: 1, est_print_secs: null, material_grams: null }],
    }]),
    'originals/delete.stl': 'solid',
    'slices/mk4s/delete-bracket-123456.gcode': 'G28',
  });
  const imported = await request(app).post('/api/project-bundles/import').attach('file', archive, 'delete.zip');
  const gcode = db.prepare('SELECT filepath FROM gcodes').get();
  const projectDir = path.join(tempDir, 'projects', String(imported.body.project.id));

  const deleted = await request(app).delete(`/api/projects/${imported.body.project.id}`);

  expect(deleted.status).toBe(200);
  expect(fs.existsSync(projectDir)).toBe(false);
  expect(fs.existsSync(path.join(tempDir, 'gcode', gcode.filepath))).toBe(false);
});

test.each([
  ['a wrong schema version', { schema_version: 2 }, /schema_version/],
  ['an empty parts list', { parts: [] }, /at least one part/],
  ['a traversal source path', { source_relpath: '../bracket.stl' }, /safe relative path/],
  ['an unsupported slice extension', { archive_path: 'slices/mk4s/bracket-123456.exe' }, /Unsupported slice extension/],
  ['a traversal slice path', { archive_path: 'slices/mk4s/../bracket-123456.gcode' }, /safe relative path/],
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

test('rejects an unknown printer model in a failure record', async () => {
  const archive = bundle({
    'manifest.json': manifest([{
      id: 'failed-bracket-123456', name: 'Failed bracket', source_relpath: 'failed.stl',
      slices: [], failures: [{ profile_key: 'unknown', printer_model: 'unknown', detail: 'failed', cancelled: false }],
    }]),
    'originals/failed.stl': 'solid',
  });
  const res = await request(app).post('/api/project-bundles/import').attach('file', archive, 'failed.zip');
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Unknown model "unknown"/);
});

test('accepts a central-directory entry exactly at the 512 MiB per-entry import limit', () => {
  const archive = buildZip({
    'manifest.json': manifest([{
      id: 'exact-bracket-123456', name: 'Exact bracket', source_relpath: 'exact.stl', failures: [], slices: [],
    }]),
    'originals/exact.stl': 'solid',
  });
  setCentralDirectorySize(archive, 'originals/exact.stl', MAX_IMPORT_ENTRY_BYTES);

  expect(() => validateBundle(validationDb(), archive)).not.toThrow();
});

test('rejects a central-directory entry one byte over the 512 MiB per-entry import limit', () => {
  const archive = craftedCentralDirectoryArchive([{ name: 'originals/large.stl', uncompressedSize: MAX_IMPORT_ENTRY_BYTES + 1 }]);

  expect(() => validateBundle(validationDb(), archive)).toThrow(/512 MiB/);
});

test('rejects aggregate central-directory size over 4 GiB without allocating payloads', () => {
  const archive = craftedCentralDirectoryArchive(Array.from({ length: 9 }, (_, index) => ({
    name: `originals/part-${index}.stl`, uncompressedSize: 500 * 1024 * 1024,
  })));

  expect(() => validateBundle(validationDb(), archive)).toThrow(/4 GiB/);
});

test('configures the project-bundle upload limit at 2 GiB', () => {
  expect(projectBundleRoute.MAX_PROJECT_BUNDLE_UPLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024);
});

test.each([
  ['an unsafe central-directory name', [{ name: '../escape.stl' }], /unsafe archive entry/],
  ['duplicate central-directory names', [{ name: 'originals/part.stl' }, { name: 'originals/part.stl' }], /duplicate archive entry/],
])('rejects %s before manifest parsing', (_description, entries, expectedError) => {
  expect(() => validateBundle(validationDb(), craftedCentralDirectoryArchive(entries))).toThrow(expectedError);
});
