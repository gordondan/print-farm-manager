// Garden mount — the single entry point from Print Garden's server into the
// fork-only garden/ plot. server/index.js calls this once, before the SPA
// catch-all, so every garden URL lives under /garden and can never collide
// with an upstream route.
//
// Add a new plot by giving it a folder here and one line below.

const path = require('path');
const express = require('express');

module.exports = function mountGarden(app) {
  const garden = express.Router();

  // Label generator page: static, client-side.
  garden.use('/labels', express.static(path.join(__dirname, 'labels'), {
    index: 'index.html',
    redirect: true, // /garden/labels → /garden/labels/ so relative URLs resolve
  }));

  // Label job queue for "Send to Print Garden" (worker: labels/worker/).
  // Its own files on the data volume, never farm.db.
  garden.use('/api/labels', require('./labels/server.cjs')(
    process.env.GARDEN_LABELS_DIR || path.join(__dirname, '..', 'server', 'data', 'garden', 'labels')));

  // Dupont clip frame page: static, client-side, plus saved board definitions
  // as JSON files on the data volume (never farm.db).
  garden.use('/dupont', express.static(path.join(__dirname, 'dupont'), {
    index: 'index.html',
    redirect: true,
  }));
  garden.use('/api/dupont', require('./dupont/server.cjs')(
    process.env.GARDEN_DUPONT_DIR || path.join(__dirname, '..', 'server', 'data', 'garden', 'dupont')));

  // Batch Slice profiles and staged jobs share the garden data volume, not farm.db.
  garden.use('/api/batch-slice', require('./batch-slice/server.cjs')(
    require('../server/db'),
    process.env.GARDEN_BATCH_SLICE_DIR || path.join(__dirname, '..', 'server', 'data', 'garden', 'batch-slice')));

  // Fleet card "Next:" line: read-only preview of what each printer dispatches next.
  // server/db.js is the process-wide singleton, so this is the same connection
  // server/index.js uses.
  garden.use('/api/fleet', require('./fleet/routes')(require('../server/db')));

  // Real 404s for missing garden files. Without this they fall through to
  // the SPA catch-all and come back as index.html with a 200 (the label app
  // probes for optional templates like templates/3CU/holder.stl).
  garden.use((_req, res) => res.sendStatus(404));

  app.use('/garden', garden);
};
