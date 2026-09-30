// The dispatch candidate predicate, in exactly one place.
//
// The scheduler asks "what would this printer print next?" (server/scheduler.js,
// _reserveJob). The predicate lives here so the eligibility contract has one home.
//
// What is shared is the predicate and the ordering, because those are the eligibility
// contract: open part, active project, matching printer model, group/material/color
// targeting where a per-gcode value overrides the project default, ordered by project
// priority, then project age, then part sort_order, then part age.
//
// The SELECT list is passed in by each caller (the scheduler and the queue's next-up lookup),
// so one caller's columns never widen the other's query.
//
// GET /api/parts/:id/dispatch-status in routes/parts.js mirrors these same rules in JS to
// explain them one part at a time, and GET /api/parts/queue reuses that mirror plus this
// ORDER BY to list the whole queue; if the rules here change, both change with them.

// Bind order for every query built here: printer model, printer group, loaded material,
// loaded color, then one parameter per excluded part id.
function candidateSql(selectColumns, excludeCount = 0) {
  const excludeClause = excludeCount > 0
    ? `AND parts.id NOT IN (${Array.from({ length: excludeCount }, () => '?').join(',')})`
    : '';

  return `
        SELECT
${selectColumns}
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
      `;
}

// Exactly the columns _reserveJob reads.
const SCHEDULER_COLUMNS = `          parts.id          AS part_id,
          parts.target_qty,
          parts.completed_qty,
          parts.project_id,
          gcodes.id         AS gcode_id,
          gcodes.filename,
          gcodes.filepath,
          gcodes.parts_per_plate,
          gcodes.ams_slot`;

// The columns the Print Queue's "next up" lookup (routes/parts.js, nextUpFor) reads: the
// part and project display names alongside the quantities and G-code identity.
const NEXT_UP_COLUMNS = `          parts.id          AS part_id,
          parts.name        AS part_name,
          parts.target_qty,
          parts.completed_qty,
          parts.print_time_seconds,
          parts.project_id,
          projects.name     AS project_name,
          gcodes.id         AS gcode_id,
          gcodes.filename,
          gcodes.parts_per_plate,
          gcodes.est_print_secs`;

module.exports = { candidateSql, SCHEDULER_COLUMNS, NEXT_UP_COLUMNS };
