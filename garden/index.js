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

  // Label generator: static, fully client-side (no API, no DB).
  garden.use('/labels', express.static(path.join(__dirname, 'labels'), {
    index: 'index.html',
    redirect: true, // /garden/labels → /garden/labels/ so relative URLs resolve
  }));

  // Real 404s for missing garden files. Without this they fall through to
  // the SPA catch-all and come back as index.html with a 200 (the label app
  // probes for optional templates like templates/3CU/holder.stl).
  garden.use((_req, res) => res.sendStatus(404));

  app.use('/garden', garden);
};
