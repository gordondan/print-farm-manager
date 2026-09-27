// Label job queue — the server half of "Send to Print Garden".
//
// The browser posts one pre-packed, single-colour STL per plate; the Mac-side
// worker (worker/label_worker.py) claims jobs, slices each plate with the
// add-to-printgarden helper, and reports progress back here. The queue lives
// in plain files under its own data directory: it never touches farm.db, so
// the garden adds no schema to Joel's database.
//
//   <dataDir>/<job id>/job.json      state (see newJob below)
//   <dataDir>/<job id>/plate-N.stl   removed once the job finishes

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const MAX_PLATES = 20;
const MAX_PLATE_BYTES = 50 * 1024 * 1024;
const STALE_CLAIM_MS = 30 * 60 * 1000; // a worker that died mid-job
const KEEP_FINISHED = 50;
const ID_RE = /^[0-9]{13}-[0-9a-f]{6}$/;

module.exports = function labelJobs(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_PLATES, fileSize: MAX_PLATE_BYTES },
  });
  let workerSeenAt = null;

  const jobDir = (id) => path.join(dataDir, id);
  const read = (id) => JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8'));
  const write = (job) => {
    job.updated_at = new Date().toISOString();
    const file = path.join(jobDir(job.id), 'job.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(job, null, 2));
    fs.renameSync(file + '.tmp', file);
  };
  const allJobs = () => fs.readdirSync(dataDir)
    .filter((id) => ID_RE.test(id) && fs.existsSync(path.join(jobDir(id), 'job.json')))
    .sort()
    .map(read);
  const withJob = (req, res) => {
    if (!ID_RE.test(req.params.id) || !fs.existsSync(jobDir(req.params.id))) {
      res.status(404).json({ error: 'No such label job' });
      return null;
    }
    return read(req.params.id);
  };
  const dropPlates = (job) => {
    for (const p of job.plates) fs.rmSync(path.join(jobDir(job.id), p.file), { force: true });
  };
  const prune = () => {
    const finished = allJobs().filter((j) => j.status === 'done' || j.status === 'failed');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      fs.rmSync(jobDir(j.id), { recursive: true, force: true });
    }
  };

  router.get('/health', (_req, res) => {
    res.json({ ok: true, worker_seen_at: workerSeenAt });
  });

  // Browser → queue. Multipart: `meta` (JSON) + one `plates` file per plate.
  router.post('/jobs', upload.array('plates', MAX_PLATES), (req, res) => {
    let meta;
    try { meta = JSON.parse(req.body.meta || ''); } catch { meta = null; }
    const files = req.files || [];
    const project = typeof meta?.project === 'string' ? meta.project.trim() : '';
    const plates = Array.isArray(meta?.plates) ? meta.plates : [];
    if (!project || project.length > 100) return res.status(400).json({ error: 'Project name is required (max 100 characters)' });
    if (!files.length || files.length !== plates.length) return res.status(400).json({ error: 'Expected one STL per plate' });
    if (plates.some((p) => !Number.isInteger(p?.count) || p.count < 1 || !Array.isArray(p.labels))) {
      return res.status(400).json({ error: 'Each plate needs a label count and label list' });
    }

    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(jobDir(id));
    const job = {
      id,
      project,
      status: 'queued',
      created_at: new Date().toISOString(),
      claimed_at: null,
      message: 'Waiting for the slicing worker',
      progress: { done: 0, total: plates.length },
      project_id: null,
      size: typeof meta.size === 'string' ? meta.size : '',
      plates: plates.map((p, i) => ({
        file: `plate-${i + 1}.stl`,
        count: p.count,
        labels: p.labels.map(String).slice(0, 500),
      })),
      log: '',
    };
    files.forEach((f, i) => fs.writeFileSync(path.join(jobDir(id), job.plates[i].file), f.buffer));
    write(job);
    prune();
    res.status(201).json(job);
  });

  router.get('/jobs', (_req, res) => {
    res.json(allJobs().reverse().slice(0, 20).map(({ log, ...summary }) => summary));
  });

  router.get('/jobs/:id', (req, res) => {
    const job = withJob(req, res);
    if (job) res.json(job);
  });

  // Worker → queue: take the oldest queued job (or one whose worker died).
  router.post('/jobs/claim', (_req, res) => {
    workerSeenAt = new Date().toISOString();
    const now = Date.now();
    const job = allJobs().find((j) => j.status === 'queued'
      || (j.status === 'slicing' && now - Date.parse(j.claimed_at) > STALE_CLAIM_MS));
    if (!job) return res.status(204).end();
    job.status = 'slicing';
    job.claimed_at = new Date().toISOString();
    job.message = 'Slicing';
    write(job);
    res.json(job);
  });

  router.get('/jobs/:id/plates/:n', (req, res) => {
    const job = withJob(req, res);
    if (!job) return;
    const plate = job.plates[Number(req.params.n) - 1];
    const file = plate && path.join(jobDir(job.id), plate.file);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No such plate' });
    res.type('model/stl').sendFile(file);
  });

  // Worker → queue: progress, and the final done/failed verdict.
  router.post('/jobs/:id/progress', (req, res) => {
    const job = withJob(req, res);
    if (!job) return;
    if (job.status !== 'slicing') return res.status(409).json({ error: `Job is ${job.status}, not slicing` });
    const { status, message, done, project_id: projectId, log } = req.body || {};
    if (status !== undefined && !['slicing', 'done', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'status must be slicing, done or failed' });
    }
    if (status) job.status = status;
    if (typeof message === 'string') job.message = message.slice(0, 500);
    if (Number.isInteger(done)) job.progress.done = Math.min(done, job.progress.total);
    if (Number.isInteger(projectId)) job.project_id = projectId;
    if (typeof log === 'string') job.log = log.slice(-20000);
    if (job.status === 'done' || job.status === 'failed') dropPlates(job);
    write(job);
    res.json(job);
  });

  return router;
};
