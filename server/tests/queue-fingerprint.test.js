// Tests for the queue freshness fingerprint (server/schedule-state.js), served as
// GET /api/parts/queue/version.
//
// It is the Print Queue's staleness signal, so its contract matters: it must move when something structural changes, and it must NOT
// move on live poll progress. A fingerprint that changed every 15 s would pin the UI in a
// permanent "recalculating" state, which is just stale data wearing a spinner.

const Database = require('better-sqlite3');

const { fingerprint } = require('../schedule-state');

let db;

beforeEach(() => {
  jest.resetModules();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT, api_key TEXT, group_name TEXT,
      type TEXT DEFAULT 'prusa', model TEXT NOT NULL,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      job_name TEXT, job_progress REAL, job_time_remaining INTEGER,
      loaded_material TEXT, loaded_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL,
      ams_slot INTEGER, allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );

    INSERT INTO printers (name, model, status, created_at) VALUES ('MK4S-1', 'mk4s', 'IDLE', 1);
    INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Proj', 'active', 1, 1);
    INSERT INTO parts (project_id, name, target_qty, created_at, updated_at)
      VALUES (1, 'Bracket', 4, 1, 1);
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                        est_print_secs, created_at)
      VALUES (1, 'mk4s', 'bracket.gcode', 'bracket.gcode', 1, 3600, 1);
  `);

});

describe('fingerprint', () => {
  test('is stable when nothing changes', () => {
    expect(fingerprint(db)).toBe(fingerprint(db));
  });

  test.each([
    ['a G-code estimate is edited',
      () => db.prepare('UPDATE gcodes SET est_print_secs = 1800 WHERE id = 1').run()],
    ['a part estimate is edited',
      () => db.prepare('UPDATE parts SET print_time_seconds = 5400 WHERE id = 1').run()],
    ['a target quantity changes',
      () => db.prepare('UPDATE parts SET target_qty = 9 WHERE id = 1').run()],
    ['quantity is credited',
      () => db.prepare('UPDATE parts SET completed_qty = 1 WHERE id = 1').run()],
    ['parts are reordered',
      () => db.prepare('UPDATE parts SET sort_order = 3 WHERE id = 1').run()],
    ['project priority changes',
      () => db.prepare('UPDATE projects SET priority = 7 WHERE id = 1').run()],
    ['a printer status changes',
      () => db.prepare("UPDATE printers SET status = 'PRINTING' WHERE id = 1").run()],
    ['a printer is held',
      () => db.prepare('UPDATE printers SET is_held = 1 WHERE id = 1').run()],
    ['a printer is decommissioned',
      () => db.prepare('UPDATE printers SET is_active = 0 WHERE id = 1').run()],
    ['loaded filament changes',
      () => db.prepare("UPDATE printers SET loaded_material = 'PETG' WHERE id = 1").run()],
    ['a job is dispatched',
      () => db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at)
                        VALUES (1, 1, 1, 1, 'uploading', 5)`).run()],
    ['a project is paused',
      () => db.prepare("UPDATE projects SET status = 'paused' WHERE id = 1").run()],
  ])('changes when %s', (_label, mutate) => {
    const before = fingerprint(db);
    mutate();
    expect(fingerprint(db)).not.toBe(before);
  });

  test('does NOT change on live poll progress', () => {
    // job_progress and job_time_remaining are rewritten for every printing printer on
    // every 15 s poll. They are display-only, which the
    // client picks up on its own refresh, and must not be reported as staleness.
    db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
                VALUES (1, 1, 1, 1, 'printing', 10, 5)`).run();
    const before = fingerprint(db);

    db.prepare('UPDATE printers SET job_progress = 42.5, job_time_remaining = 1200 WHERE id = 1').run();
    expect(fingerprint(db)).toBe(before);

    db.prepare("UPDATE printers SET job_name = 'bracket.gcode' WHERE id = 1").run();
    expect(fingerprint(db)).toBe(before);
  });

  test('does NOT change when a finished job is added to history', () => {
    // A finished job's effect on the queue is already carried by parts.completed_qty.
    const before = fingerprint(db);
    db.prepare(`INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status,
                                  started_at, finished_at, created_at)
                VALUES (1, 1, 1, 1, 'finished', 10, 20, 5)`).run();
    expect(fingerprint(db)).toBe(before);
  });
});
