const fs = require('fs');
const os = require('os');
const path = require('path');

const zip = require('./zip-reader');
const { validateSliced3mf } = require('./sliced-3mf');

const PROJECTS_DIR = path.join(__dirname, 'projects');
const GCODE_DIR = path.join(__dirname, 'gcode');
const SUPPORTED_SLICE_EXTENSIONS = new Set(['.gcode', '.bgcode', '.3mf']);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_IMPORT_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 1024 * 1024 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_PROJECT_BUNDLE';
  return error;
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\')) {
    throw invalid(`${label} must be a safe relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(value) || normalized !== value || normalized === '.' ||
      normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw invalid(`${label} must be a safe relative path`);
  }
  return value;
}

function readManifest(archive) {
  const contents = zip.readEntry(archive, 'manifest.json');
  if (!contents) throw invalid('Bundle is missing a readable manifest.json');
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch (_) {
    throw invalid('manifest.json is not valid JSON');
  }
}

function validateBundle(db, archive) {
  if (archive.length > MAX_IMPORT_TOTAL_BYTES) throw invalid('Bundle exceeds the 1 GiB import limit');
  const entries = zip.readCentralDirectory(archive);
  if (!entries) throw invalid('Bundle is not a readable ZIP archive');
  let totalBytes = 0;
  const entryNames = new Set();
  for (const entry of entries) {
    if (!zip.isSafeEntryName(entry.name)) throw invalid(`Bundle contains an unsafe archive entry "${entry.name}"`);
    if (entryNames.has(entry.name)) throw invalid(`Bundle contains a duplicate archive entry "${entry.name}"`);
    entryNames.add(entry.name);
    if (entry.uncompressedSize > MAX_IMPORT_ENTRY_BYTES) throw invalid(`Bundle entry "${entry.name}" exceeds the 512 MiB limit`);
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw invalid('Bundle exceeds the 1 GiB uncompressed import limit');
  }
  const manifest = readManifest(archive);
  if (!manifest || manifest.schema_version !== 1) {
    throw invalid('Unsupported project bundle schema_version; expected 1');
  }
  if (typeof manifest.project_name !== 'string' || !manifest.project_name.trim()) {
    throw invalid('manifest.project_name is required');
  }
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw invalid('Bundle must contain at least one part');
  }

  const partIds = new Set();
  const sourceRelpaths = new Set();
  const knownModels = new Set(db.prepare('SELECT model_id FROM printer_models').all().map((row) => row.model_id));
  const failures = [];

  for (const part of manifest.parts) {
    if (!part || typeof part !== 'object' || !SAFE_ID.test(part.id || '')) {
      throw invalid('Each part must have a unique safe id');
    }
    if (partIds.has(part.id)) throw invalid(`Duplicate part id "${part.id}"`);
    partIds.add(part.id);
    if (typeof part.name !== 'string' || !part.name.trim()) throw invalid(`Part ${part.id} requires a name`);

    const sourceRelpath = safeRelativePath(part.source_relpath, `Part ${part.id} source_relpath`);
    if (sourceRelpaths.has(sourceRelpath)) throw invalid(`Duplicate source_relpath "${sourceRelpath}"`);
    sourceRelpaths.add(sourceRelpath);
    const originalEntry = `originals/${sourceRelpath}`;
    if (!entryNames.has(originalEntry)) throw invalid(`Bundle is missing original "${originalEntry}"`);

    if (!Array.isArray(part.slices)) throw invalid(`Part ${part.id} slices must be an array`);
    if (part.failures !== undefined && !Array.isArray(part.failures)) throw invalid(`Part ${part.id} failures must be an array`);
    const profileKeys = new Set();
    const slicePaths = new Set();
    for (const slice of part.slices) {
      if (!slice || !SAFE_PROFILE_KEY.test(slice.profile_key || '')) {
        throw invalid(`Part ${part.id} has an unsafe slice profile_key`);
      }
      if (profileKeys.has(slice.profile_key)) throw invalid(`Duplicate profile key "${slice.profile_key}" for part ${part.id}`);
      profileKeys.add(slice.profile_key);
      if (typeof slice.printer_model !== 'string' || !knownModels.has(slice.printer_model)) {
        throw invalid(`Unknown model "${slice.printer_model}". Add it in Settings → Printer Models first.`);
      }
      if (!Number.isInteger(slice.parts_per_plate) || slice.parts_per_plate < 1) {
        throw invalid(`Part ${part.id} slice ${slice.profile_key} requires a positive integer parts_per_plate`);
      }
      if (slice.est_print_secs !== null && slice.est_print_secs !== undefined &&
          (!Number.isInteger(slice.est_print_secs) || slice.est_print_secs < 0)) {
        throw invalid(`Part ${part.id} slice ${slice.profile_key} has an invalid est_print_secs`);
      }
      if (slice.material_grams !== null && slice.material_grams !== undefined &&
          (typeof slice.material_grams !== 'number' || !Number.isFinite(slice.material_grams) || slice.material_grams < 0)) {
        throw invalid(`Part ${part.id} slice ${slice.profile_key} has an invalid material_grams`);
      }
      if (typeof slice.filename !== 'string' || !slice.filename || path.basename(slice.filename) !== slice.filename) {
        throw invalid(`Part ${part.id} slice ${slice.profile_key} has an invalid filename`);
      }
      const expectedPrefix = `slices/${slice.profile_key}/${part.id}`;
      const archivePath = safeRelativePath(slice.archive_path, `Part ${part.id} slice archive_path`);
      const extension = path.posix.extname(archivePath).toLowerCase();
      if (archivePath !== expectedPrefix + extension) {
        throw invalid(`Part ${part.id} slice ${slice.profile_key} archive_path does not match the bundle contract`);
      }
      if (!SUPPORTED_SLICE_EXTENSIONS.has(extension)) {
        throw invalid(`Unsupported slice extension "${extension || '(none)'}" for ${archivePath}`);
      }
      if (slicePaths.has(archivePath)) throw invalid(`Duplicate slice archive_path "${archivePath}"`);
      slicePaths.add(archivePath);
      if (!entryNames.has(archivePath)) throw invalid(`Bundle is missing slice "${archivePath}"`);
    }
    for (const failure of part.failures || []) {
      if (!failure || !SAFE_PROFILE_KEY.test(failure.profile_key || '') || profileKeys.has(failure.profile_key) ||
          typeof failure.printer_model !== 'string' || typeof failure.detail !== 'string') {
        throw invalid(`Part ${part.id} has an invalid failure record`);
      }
      if (!knownModels.has(failure.printer_model)) {
        throw invalid(`Unknown model "${failure.printer_model}". Add it in Settings → Printer Models first.`);
      }
      profileKeys.add(failure.profile_key);
      failures.push({ part_id: part.id, profile_key: failure.profile_key, printer_model: failure.printer_model,
        detail: failure.detail, cancelled: Boolean(failure.cancelled) });
    }
  }
  return { manifest, failures };
}

function importProjectBundle(db, archivePath, { projectsDir = PROJECTS_DIR, gcodeDir = GCODE_DIR } = {}) {
  let archive;
  try {
    archive = fs.readFileSync(archivePath);
  } catch (_) {
    throw invalid('Uploaded project bundle could not be read');
  }
  const { manifest, failures } = validateBundle(db, archive);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bundle-'));
  const createdFiles = [];
  let managedProjectDir = null;

  try {
    // Fully extract to staging before any database row or managed file exists.
    for (const part of manifest.parts) {
      const originalDestination = path.join(stagingDir, 'originals', ...part.source_relpath.split('/'));
      if (!zip.readEntryToFile(archive, `originals/${part.source_relpath}`, originalDestination, MAX_IMPORT_ENTRY_BYTES)) {
        throw invalid(`Could not extract original "originals/${part.source_relpath}"`);
      }
      for (const slice of part.slices) {
        const destination = path.join(stagingDir, 'slices', `${part.id}-${slice.profile_key}${path.posix.extname(slice.archive_path).toLowerCase()}`);
        if (!zip.readEntryToFile(archive, slice.archive_path, destination, MAX_IMPORT_ENTRY_BYTES)) {
          throw invalid(`Could not extract slice "${slice.archive_path}"`);
        }
        if (path.posix.extname(slice.archive_path).toLowerCase() === '.3mf') {
          const sliceError = validateSliced3mf(destination);
          if (sliceError) throw invalid(sliceError);
        }
        slice._stagedPath = destination;
      }
    }

    let project;
    const importedParts = [];
    db.transaction(() => {
      const now = Date.now();
      const result = db.prepare(`
        INSERT INTO projects (name, import_failures, status, priority, created_at, updated_at)
        VALUES (?, ?, 'draft', 0, ?, ?)
      `).run(manifest.project_name.trim(), JSON.stringify(failures), now, now);
      const projectId = result.lastInsertRowid;
      managedProjectDir = path.join(projectsDir, String(projectId));
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.mkdirSync(managedProjectDir, { recursive: true });
      fs.renameSync(path.join(stagingDir, 'originals'), path.join(managedProjectDir, 'originals'));

      for (const part of manifest.parts) {
        const sourcePath = path.join(managedProjectDir, 'originals', ...part.source_relpath.split('/'));
        const partResult = db.prepare(`
          INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order, source_path, source_relpath, created_at, updated_at)
          VALUES (?, ?, 1, 0, 'open', ?, ?, ?, ?, ?)
        `).run(projectId, part.name.trim(), importedParts.length, sourcePath, part.source_relpath, now, now);
        const partId = partResult.lastInsertRowid;
        importedParts.push(db.prepare('SELECT * FROM parts WHERE id = ?').get(partId));

        for (let index = 0; index < part.slices.length; index++) {
          const slice = part.slices[index];
          const managedName = `${projectId}-${partId}-${index}-${slice.filename}`;
          const managedPath = path.join(gcodeDir, managedName);
          fs.mkdirSync(gcodeDir, { recursive: true });
          fs.renameSync(slice._stagedPath, managedPath);
          createdFiles.push(managedPath);
          db.prepare(`
            INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(partId, slice.printer_model, slice.filename, managedName, slice.parts_per_plate,
            slice.est_print_secs ?? null, slice.material_grams ?? null, now);
        }
      }
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    })();
    return { project, parts: importedParts, failures };
  } catch (error) {
    for (const file of createdFiles) fs.rmSync(file, { force: true });
    if (managedProjectDir) fs.rmSync(managedProjectDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = { importProjectBundle, validateBundle, safeRelativePath, MAX_IMPORT_ENTRY_BYTES, MAX_IMPORT_TOTAL_BYTES };
