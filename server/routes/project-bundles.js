const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { importProjectBundle } = require('../project-bundle');

const MAX_PROJECT_BUNDLE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

module.exports = (db, { uploadDir = path.join(os.tmpdir(), 'print-farm-manager-imports'), projectsDir, gcodeDir } = {}) => {
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, callback) => callback(null, `project-bundle-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`),
    }),
    limits: { fileSize: MAX_PROJECT_BUNDLE_UPLOAD_BYTES },
  });
  const router = express.Router();

  router.post('/import', (req, res) => {
    upload.single('file')(req, res, (uploadError) => {
      if (uploadError) return res.status(400).json({ error: uploadError.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        const imported = importProjectBundle(db, req.file.path, { projectsDir, gcodeDir });
        res.status(201).json(imported);
      } catch (error) {
        res.status(400).json({ error: error.message || 'Could not import project bundle' });
      } finally {
        fs.rmSync(req.file.path, { force: true });
      }
    });
  });

  return router;
};

module.exports.MAX_PROJECT_BUNDLE_UPLOAD_BYTES = MAX_PROJECT_BUNDLE_UPLOAD_BYTES;
