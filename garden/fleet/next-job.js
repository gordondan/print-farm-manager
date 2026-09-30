// Garden plot: read-only preview of what the scheduler would dispatch to a printer next.
//
// The Fleet page shows this at the bottom of each printer card (served by
// garden/fleet/routes.js, rendered by client/src/garden/NextJobLine.jsx). It answers "if this
// printer became dispatchable right now, which part and G-code would it get?" without
// touching anything: no probe job is inserted, no notification fires.
//
// Sync pair: this mirrors JobScheduler._reserveJob in server/scheduler.js (the candidate
// WHERE clause and ORDER BY, the per-part ceiling fall-through, and the missing-file
// fall-through). If the scheduler's eligibility rules change, this changes with them.
// garden/fleet/tests/next-job.test.js asserts the two agree on the same database, so
// run it after every upstream rebase.
//
// Differences from real dispatch, by design:
//   - The scheduler's ceiling check subtracts the probe job it just inserted; the preview
//     inserts no probe, so the same test is simply inProgress >= remaining.
//   - Printer readiness (held, printing, offline) is not considered. A printing printer
//     shows what it would pick up once it is released, given the queue as it stands now.
//   - Every printer of the same model/group/filament sees the same queue, so idle twins
//     can show the same part. Real dispatch serialises them, and the ceiling may push the
//     second one further down the list once the first job exists.
const fs = require('fs');
const path = require('path');

// Same directory the scheduler reads (server/scheduler.js GCODE_DIR).
const GCODE_DIR = path.join(__dirname, '..', '..', 'server', 'gcode');

function previewNextJob(db, printer) {
  const skippedPartIds = [];

  while (true) {
    const excludeClause = skippedPartIds.length > 0
      ? `AND parts.id NOT IN (${skippedPartIds.map(() => '?').join(',')})`
      : '';

    const candidate = db.prepare(`
      SELECT
        parts.id          AS part_id,
        parts.name        AS part_name,
        parts.target_qty,
        parts.completed_qty,
        projects.id       AS project_id,
        projects.name     AS project_name,
        gcodes.id         AS gcode_id,
        gcodes.filename,
        gcodes.filepath,
        gcodes.parts_per_plate
      FROM parts
      JOIN gcodes   ON gcodes.part_id    = parts.id
      JOIN projects ON projects.id       = parts.project_id
      WHERE parts.status    = 'open'
        AND projects.status = 'active'
        AND gcodes.printer_model = ?
        AND (COALESCE(gcodes.allowed_groups, projects.allowed_groups) IS NULL OR EXISTS (
          SELECT 1 FROM json_each(COALESCE(gcodes.allowed_groups, projects.allowed_groups)) WHERE value = ?
        ))
        AND (COALESCE(gcodes.required_material, projects.required_material) IS NULL OR COALESCE(gcodes.required_material, projects.required_material) = ?)
        AND (COALESCE(gcodes.required_color, projects.required_color) IS NULL OR COALESCE(gcodes.required_color, projects.required_color) = ?)
        ${excludeClause}
      ORDER BY projects.priority ASC, projects.created_at ASC, parts.sort_order ASC, parts.created_at ASC
      LIMIT 1
    `).get(printer.model, printer.group_name, printer.loaded_material, printer.loaded_color, ...skippedPartIds);

    if (!candidate) return null;

    const remainingParts = Math.max(0, candidate.target_qty - candidate.completed_qty);
    const inProgressParts = db.prepare(`
      SELECT COALESCE(SUM(parts_per_plate), 0) AS total FROM jobs
      WHERE part_id = ? AND status IN ('uploading', 'printing')
    `).get(candidate.part_id).total;
    if (inProgressParts >= remainingParts) {
      skippedPartIds.push(candidate.part_id);
      continue;
    }

    const gcodeFilename = candidate.filepath.split(/[\\/]/).pop();
    if (!fs.existsSync(path.join(GCODE_DIR, gcodeFilename))) {
      skippedPartIds.push(candidate.part_id);
      continue;
    }

    return {
      part_id: candidate.part_id,
      part_name: candidate.part_name,
      project_id: candidate.project_id,
      project_name: candidate.project_name,
      gcode_id: candidate.gcode_id,
      filename: candidate.filename,
      parts_per_plate: candidate.parts_per_plate,
      remaining_qty: remainingParts,
    };
  }
}

module.exports = { previewNextJob };
