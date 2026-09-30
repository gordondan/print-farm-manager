// Garden plot: GET /garden/api/fleet/next-jobs
//
// Returns { "<printer id>": next_job | null } for every active printer, where next_job
// is previewNextJob's answer (see next-job.js). The Fleet card's "Next:" line reads it.
// Read-only: no rows are written and no notifications fire.
const express = require('express');
const { previewNextJob } = require('./next-job');

module.exports = (db) => {
  const router = express.Router();

  router.get('/next-jobs', (req, res) => {
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 1').all();
    const out = {};
    for (const p of printers) out[p.id] = previewNextJob(db, p);
    res.json(out);
  });

  return router;
};
