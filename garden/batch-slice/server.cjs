// Batch Slice queue and profile API. State and uploads live outside farm.db.
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const MODEL_EXTENSIONS = new Set(['.stl', '.3mf', '.obj', '.step', '.stp']);
const RESERVED_ORCA_ARGS = /^(?:--load-settings|--load-filaments|--outputdir|--slice|--export-3mf|--arrange|--project|--input|--help|--version)(?:$|=)/i;
const MAX_FILES = positiveInt(process.env.GARDEN_BATCH_SLICE_MAX_FILES, 20);
const MAX_FILE_BYTES = positiveInt(process.env.GARDEN_BATCH_SLICE_MAX_FILE_BYTES, 50 * 1024 * 1024);
const MAX_TOTAL_BYTES = positiveInt(process.env.GARDEN_BATCH_SLICE_MAX_TOTAL_BYTES, 1024 * 1024 * 1024);
const UPLOAD_FILE_BYTES = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES);
const UPLOAD_FILE_COUNT = Math.max(1, Math.min(MAX_FILES, Math.floor(MAX_TOTAL_BYTES / UPLOAD_FILE_BYTES)));
const KEEP_FINISHED = 50;
const STALE_CLAIM_MS = 30 * 60 * 1000;
const ID_RE = /^[0-9]{13}-[a-f0-9]{12}$/;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonWrite(file, value) {
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.split('/').some((item) => !item || item === '..' || item === '.')) return null;
  return normalized;
}

function publicJob(job) {
  const { lease_id: _leaseId, claim_expires_at: _expires, claim_attempt: _attempt, ...visible } = job;
  return visible;
}

function workerOnly(req, res, next) {
  const configured = process.env.PRINTGARDEN_WORKER_TOKEN;
  if (!configured) return res.status(503).json({ error: 'Worker token is not configured' });
  const supplied = req.get('authorization') || '';
  const expected = `Bearer ${configured}`;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Worker authentication required' });
  }
  next();
}

module.exports = function batchSliceApi(db, dataDir = process.env.GARDEN_BATCH_SLICE_DIR || path.join(__dirname, '..', '..', 'server', 'data', 'garden', 'batch-slice')) {
  fs.mkdirSync(dataDir, { recursive: true });
  const incomingDir = path.join(dataDir, '.incoming');
  const jobsDir = path.join(dataDir, 'jobs');
  fs.mkdirSync(incomingDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  const profilesFile = path.join(dataDir, 'profiles.json');
  const router = express.Router();
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, incomingDir),
      filename: (_req, _file, callback) => callback(null, crypto.randomBytes(18).toString('hex')),
    }),
    limits: { files: UPLOAD_FILE_COUNT, fileSize: UPLOAD_FILE_BYTES },
  });
  let worker = { seen_at: null, orca_available: false, source_folders: [], presets: [] };

  const dirFor = (id) => path.join(jobsDir, id);
  const fileFor = (id) => path.join(dirFor(id), 'job.json');
  const read = (id) => JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  const write = (job) => {
    job.updated_at = Date.now();
    jsonWrite(fileFor(job.id), job);
  };
  const allJobs = () => fs.readdirSync(jobsDir)
    .filter((id) => ID_RE.test(id) && fs.existsSync(fileFor(id)))
    .map(read)
    .sort((a, b) => a.created_at - b.created_at);
  const cleanupStaged = (job) => fs.rmSync(path.join(dirFor(job.id), 'files'), { recursive: true, force: true });
  const prune = () => {
    const finished = allJobs().filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status));
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      fs.rmSync(dirFor(job.id), { recursive: true, force: true });
    }
  };
  const getJob = (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id) || !fs.existsSync(fileFor(id))) {
      res.status(404).json({ error: 'Batch Slice job not found' });
      return null;
    }
    return read(id);
  };
  const readProfiles = () => {
    if (!fs.existsSync(profilesFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  };
  const registeredModelIds = () => new Set(db.prepare('SELECT model_id FROM printer_models').all().map((row) => row.model_id));

  // Browser-facing capabilities intentionally contain no local filesystem paths.
  router.get('/status', (_req, res) => {
    const online = worker.seen_at !== null && Date.now() - worker.seen_ms < 45_000;
    res.json({ online, worker_seen_at: worker.seen_at, orca_available: online && worker.orca_available,
      source_folders: online ? worker.source_folders.map(({ id, name }) => ({ id, name })) : [],
      presets: online ? worker.presets : [] });
  });

  router.get('/profiles', (_req, res) => res.json(readProfiles()));
  router.put('/profiles', express.json({ limit: '256kb' }), (req, res) => {
    const profiles = req.body?.profiles;
    if (!Array.isArray(profiles) || profiles.length > 50) return res.status(400).json({ error: 'profiles must be an array of at most 50 entries' });
    const modelIds = registeredModelIds();
    const keys = new Set();
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object' || typeof profile.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.key)) {
        return res.status(400).json({ error: 'Each profile needs a safe output key' });
      }
      if (keys.has(profile.key)) return res.status(400).json({ error: `Duplicate profile key: ${profile.key}` });
      keys.add(profile.key);
      if (!modelIds.has(profile.printer_model_id)) return res.status(400).json({ error: `Unknown printer model: ${profile.printer_model_id || '(empty)'}` });
      if (typeof profile.machine !== 'string' || !profile.machine || typeof profile.process !== 'string' || !profile.process ||
          !Array.isArray(profile.filaments) || !profile.filaments.length || profile.filaments.some((id) => typeof id !== 'string' || !id) ||
          !Array.isArray(profile.extra || []) || (profile.extra || []).some((arg) => typeof arg !== 'string' || arg.length > 200 || /[\\/\u0000-\u001f]/.test(arg) || RESERVED_ORCA_ARGS.test(arg))) {
        return res.status(400).json({ error: `${profile.key}: select machine, process, and filament presets; extra arguments must be a string list` });
      }
      profile.enabled = profile.enabled !== false;
      profile.extra = profile.extra || [];
    }
    jsonWrite(profilesFile, profiles);
    res.json(profiles);
  });

  router.post('/worker/heartbeat', workerOnly, express.json({ limit: '1mb' }), (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.source_folders) || !Array.isArray(body.presets)) return res.status(400).json({ error: 'source_folders and presets arrays are required' });
    worker = {
      seen_at: new Date().toISOString(), seen_ms: Date.now(),
      orca_available: Boolean(body.orca_available),
      source_folders: body.source_folders.filter((folder) => folder && typeof folder.id === 'string' && typeof folder.name === 'string'),
      presets: body.presets.filter((preset) => preset && typeof preset.id === 'string' && typeof preset.kind === 'string' && typeof preset.label === 'string'),
    };
    res.json({ ok: true, seen_at: worker.seen_at });
  });

  router.get('/worker/config', workerOnly, (_req, res) => {
    res.json({ profiles: readProfiles() });
  });

  router.post('/jobs', (req, res) => {
    upload.array('files', MAX_FILES)(req, res, (uploadError) => {
      const temporaryFiles = (req.files || []).map((file) => file.path);
      const reject = (status, error) => {
        for (const file of temporaryFiles) fs.rmSync(file, { force: true });
        return res.status(status).json({ error });
      };
      if (uploadError) return reject(400, uploadError.message);
      let meta;
      try { meta = JSON.parse(req.body.meta || ''); } catch (_) { meta = null; }
      const files = req.files || [];
      const projectName = typeof meta?.project_name === 'string' ? meta.project_name.trim() : '';
      if (!projectName || projectName.length > 100) return reject(400, 'project_name is required (max 100 characters)');
      if (!Array.isArray(meta.profile_keys) || !meta.profile_keys.length) return reject(400, 'Select at least one printer profile');
      const profiles = readProfiles();
      const selectedProfiles = [];
      for (const key of meta.profile_keys) {
        const profile = profiles.find((item) => item.key === key && item.enabled);
        if (!profile) return reject(400, `Profile is missing or disabled: ${key}`);
        if (selectedProfiles.some((item) => item.printer_model_id === profile.printer_model_id)) {
          return reject(400, `Select only one profile per printer model (${profile.printer_model_id})`);
        }
        selectedProfiles.push(profile);
      }
      const options = meta.options || {};
      const jobs = Number(options.jobs);
      if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) return reject(400, 'jobs must be an integer from 1 to 16');
      if (typeof options.arrange !== 'boolean' || typeof options.recursive !== 'boolean' || typeof options.dry_run !== 'boolean') {
        return reject(400, 'arrange, recursive, and dry_run must be booleans');
      }
      if (!['upload', 'folder'].includes(meta.source_mode)) return reject(400, 'source_mode must be upload or folder');
      if (meta.source_mode === 'upload') {
        if (!files.length) return reject(400, 'Choose at least one supported model file');
        let manifest;
        try { manifest = JSON.parse(req.body.file_paths || ''); } catch (_) { manifest = null; }
        if (!Array.isArray(manifest) || manifest.length !== files.length) return reject(400, 'file_paths must contain one relative path for every uploaded file');
        const seen = new Set();
        let totalBytes = 0;
        const normalized = [];
        for (let index = 0; index < files.length; index++) {
          const relativePath = safeRelativePath(manifest[index]);
          if (!relativePath || !MODEL_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) return reject(400, `Unsupported or unsafe model path: ${manifest[index]}`);
          if (path.posix.extname(relativePath).toLowerCase() !== path.extname(files[index].originalname).toLowerCase()) return reject(400, `Uploaded filename does not match its relative path: ${relativePath}`);
          if (seen.has(relativePath.toLowerCase())) return reject(400, `Duplicate model path: ${relativePath}`);
          seen.add(relativePath.toLowerCase());
          totalBytes += files[index].size;
          if (totalBytes > MAX_TOTAL_BYTES) return reject(400, 'Batch exceeds the configured total upload size limit');
          normalized.push(relativePath);
        }
        const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        const directory = dirFor(id);
        fs.mkdirSync(directory, { recursive: true });
        const staged = [];
        try {
          files.forEach((file, index) => {
            const relativePath = normalized[index];
            const destination = path.join(directory, 'files', ...relativePath.split('/'));
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.renameSync(file.path, destination);
            staged.push({ relative_path: relativePath, size: file.size });
          });
        } catch (error) {
          fs.rmSync(directory, { recursive: true, force: true });
          return reject(500, `Could not stage uploaded models: ${error.message}`);
        }
        return createJob(id, { projectName, meta, files: staged, options, res });
      }
      for (const file of files) fs.rmSync(file.path, { force: true });
      if (files.length) return res.status(400).json({ error: 'Do not upload files when using a Mac folder source' });
      if (!worker.seen_at || Date.now() - worker.seen_ms > 45_000 || typeof meta.source_folder_id !== 'string' || !worker.source_folders.some((folder) => folder.id === meta.source_folder_id)) {
        return res.status(400).json({ error: 'Choose a folder advertised by the Mac worker' });
      }
      const relativePath = meta.relative_path === '' ? '' : safeRelativePath(meta.relative_path);
      if (meta.relative_path && !relativePath) return res.status(400).json({ error: 'Folder path must be a safe relative path' });
      const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      fs.mkdirSync(dirFor(id), { recursive: true });
      createJob(id, { projectName, meta, files: [], options, res, input: { source_folder_id: meta.source_folder_id, relative_path: relativePath || '' } });
    });
  });

  function createJob(id, { projectName, meta, files, options, res, input = null }) {
    const job = {
      id, project_name: projectName, source_mode: meta.source_mode,
      input: input || null, files, profile_keys: meta.profile_keys,
      options: { jobs: Number(options.jobs), arrange: options.arrange, recursive: options.recursive, dry_run: options.dry_run },
      status: 'queued', created_at: Date.now(), updated_at: Date.now(), claimed_at: null,
      lease_id: null, claim_expires_at: null, claim_attempt: 0, cancel_requested: false,
      progress: { done: 0, total: 0, current: null }, results: [], logs: [],
      project_id: null, message: 'Waiting for the Mac slicing worker',
    };
    jsonWrite(fileFor(id), job);
    prune();
    res.status(201).json(publicJob(job));
  }

  router.get('/jobs', (_req, res) => res.json(allJobs().reverse().slice(0, 50).map(publicJob)));
  router.get('/jobs/:id', (req, res) => { const job = getJob(req, res); if (job) res.json(publicJob(job)); });

  router.post('/jobs/claim', workerOnly, express.json({ limit: '16kb' }), (_req, res) => {
    const now = Date.now();
    const job = allJobs().find((item) => item.status === 'queued' || (item.status === 'running' && item.claim_expires_at < now));
    if (!job) return res.status(204).end();
    job.status = 'running';
    job.claimed_at = now;
    job.claim_expires_at = now + STALE_CLAIM_MS;
    job.lease_id = crypto.randomBytes(16).toString('hex');
    job.claim_attempt += 1;
    job.message = 'Worker claimed batch';
    write(job);
    res.json(job);
  });

  router.get('/jobs/:id/files/:index', workerOnly, (req, res) => {
    const job = getJob(req, res);
    if (!job) return;
    const index = Number(req.params.index);
    const item = Number.isInteger(index) && index >= 0 ? job.files[index] : null;
    if (!item) return res.status(404).json({ error: 'No such staged model' });
    const file = path.join(dirFor(job.id), 'files', ...item.relative_path.split('/'));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Staged model is no longer available' });
    res.type('application/octet-stream').sendFile(file);
  });

  router.get('/worker/jobs/:id', workerOnly, (req, res) => { const job = getJob(req, res); if (job) res.json({ status: job.status, cancel_requested: job.cancel_requested, lease_id: job.lease_id }); });

  router.post('/jobs/:id/progress', workerOnly, express.json({ limit: '256kb' }), (req, res) => {
    const job = getJob(req, res);
    if (!job) return;
    if (job.status !== 'running' || req.body?.lease_id !== job.lease_id) return res.status(409).json({ error: 'Job claim is stale or no longer active' });
    const allowedStatuses = ['running', 'completed', 'failed', 'cancelled'];
    if (req.body.status !== undefined && !allowedStatuses.includes(req.body.status)) return res.status(400).json({ error: 'Invalid job status' });
    if (req.body.status) job.status = req.body.status;
    if (typeof req.body.message === 'string') job.message = req.body.message.slice(0, 500);
    if (req.body.progress && typeof req.body.progress === 'object') {
      job.progress = { ...job.progress, ...req.body.progress };
      job.progress.done = Math.max(0, Math.min(Number(job.progress.done) || 0, Number(job.progress.total) || 0));
    }
    if (Array.isArray(req.body.results)) job.results = req.body.results.slice(-10000);
    if (Array.isArray(req.body.logs)) job.logs = req.body.logs.slice(-500).map((line) => String(line).slice(0, 2000));
    if (Number.isInteger(req.body.project_id)) job.project_id = req.body.project_id;
    job.claim_expires_at = Date.now() + STALE_CLAIM_MS;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      job.claim_expires_at = null;
      job.lease_id = null;
      cleanupStaged(job);
    }
    write(job);
    prune();
    res.json(publicJob(job));
  });

  router.post('/jobs/:id/cancel', express.json({ limit: '8kb' }), (req, res) => {
    const job = getJob(req, res);
    if (!job) return;
    if (!['queued', 'running'].includes(job.status)) return res.status(409).json({ error: `Job is already ${job.status}` });
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.message = 'Cancelled before slicing started';
      cleanupStaged(job);
    } else {
      job.cancel_requested = true;
      job.message = 'Cancellation requested';
    }
    write(job);
    prune();
    res.json(publicJob(job));
  });

  // Remove abandoned multipart uploads left by a process restart.
  for (const name of fs.readdirSync(incomingDir)) {
    try { if (Date.now() - fs.statSync(path.join(incomingDir, name)).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(path.join(incomingDir, name), { force: true }); } catch (_) {}
  }
  return router;
};

module.exports.safeRelativePath = safeRelativePath;
