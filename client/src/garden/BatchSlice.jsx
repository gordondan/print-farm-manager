import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConfirm } from '../useConfirm';
import { useToast } from '../useToast';

const API = '/garden/api/batch-slice';
const colors = {
  queued: ['#1e293b', '#cbd5e1'], running: ['#1e3a5f', '#60a5fa'],
  completed: ['#14532d', '#86efac'], failed: ['#7f1d1d', '#fca5a5'], cancelled: ['#27272a', '#a1a1aa'],
};
const fieldStyle = { background: '#1e2433', border: '1px solid #2d3748', borderRadius: 5, padding: '8px 10px', color: '#e2e8f0', fontSize: 13, width: '100%', boxSizing: 'border-box' };
const buttonStyle = { border: 0, borderRadius: 5, padding: '8px 12px', color: '#fff', background: '#2563eb', fontWeight: 600, cursor: 'pointer' };
const cardStyle = { background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: 16, marginBottom: 16 };
const emptyProfile = { key: '', printer_model_id: '', machine: '', process: '', filaments: [], extra: [], enabled: true };

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function Field({ label, children }) {
  return <label style={{ display: 'grid', gap: 6, color: '#94a3b8', fontSize: 12 }}>{label}{children}</label>;
}

function Status({ value }) {
  const [background, color] = colors[value] || colors.queued;
  return <span style={{ display: 'inline-block', background, color, borderRadius: 99, padding: '3px 9px', fontSize: 12, fontWeight: 700 }}>{value}</span>;
}

export default function BatchSlice() {
  const [confirm, confirmModal] = useConfirm();
  const [showToast, toastEl] = useToast();
  const [capabilities, setCapabilities] = useState({ online: false, source_folders: [], presets: [] });
  const [profiles, setProfiles] = useState([]);
  const [models, setModels] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [profileDraft, setProfileDraft] = useState(null);
  const [sourceMode, setSourceMode] = useState('upload');
  const [sourceFolderId, setSourceFolderId] = useState('');
  const [files, setFiles] = useState([]);
  const [profileKeys, setProfileKeys] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [jobCount, setJobCount] = useState(1);
  const [arrange, setArrange] = useState(true);
  const [recursive, setRecursive] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [saving, setSaving] = useState(false);

  const presetsByKind = useMemo(() => Object.groupBy
    ? Object.groupBy(capabilities.presets || [], (preset) => preset.kind)
    : (capabilities.presets || []).reduce((groups, preset) => ((groups[preset.kind] ||= []).push(preset), groups), {}), [capabilities.presets]);

  const loadCapabilities = useCallback(async () => {
    try { setCapabilities(await responseJson(await fetch(`${API}/status`))); } catch (_) {}
  }, []);
  const loadJobs = useCallback(async () => {
    try { setJobs(await responseJson(await fetch(`${API}/jobs`))); } catch (_) {}
  }, []);
  const loadProfiles = useCallback(async () => {
    try {
      const configured = await responseJson(await fetch(`${API}/profiles`));
      setProfiles(configured);
      const selectedModels = new Set();
      setProfileKeys(configured.filter((profile) => {
        if (!profile.enabled || selectedModels.has(profile.printer_model_id)) return false;
        selectedModels.add(profile.printer_model_id);
        return true;
      }).map((profile) => profile.key));
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadCapabilities(); loadJobs(); loadProfiles();
    fetch('/api/models').then(responseJson).then(setModels).catch(() => {});
    const timer = setInterval(() => { loadCapabilities(); loadJobs(); }, 5000);
    return () => clearInterval(timer);
  }, [loadCapabilities, loadJobs, loadProfiles]);

  async function saveProfiles(next) {
    setSaving(true);
    try {
      const result = await responseJson(await fetch(`${API}/profiles`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles: next }),
      }));
      setProfiles(result);
      setProfileKeys((keys) => keys.filter((key) => result.some((profile) => profile.key === key && profile.enabled)));
      setProfileDraft(null);
      showToast('Profiles saved', 'success');
    } catch (error) { showToast(`Profile save failed: ${error.message}`, 'error'); }
    finally { setSaving(false); }
  }

  function editProfile(profile = emptyProfile) {
    setProfileDraft({ ...profile, originalKey: profile.key || null, filaments: [...(profile.filaments || [])], extraText: (profile.extra || []).join('\n') });
  }

  async function submitProfile(event) {
    event.preventDefault();
    const profile = { ...profileDraft, extra: profileDraft.extraText.split('\n').map((item) => item.trim()).filter(Boolean) };
    delete profile.extraText;
    const originalKey = profile.originalKey;
    delete profile.originalKey;
    const next = originalKey
      ? profiles.map((item) => item.key === originalKey ? profile : item)
      : [...profiles, profile];
    await saveProfiles(next);
  }

  async function deleteProfile(profile) {
    if (!(await confirm({ title: 'Remove slicer profile', message: `Remove ${profile.key} from Print Garden?`, confirmLabel: 'Remove Profile', danger: true }))) return;
    await saveProfiles(profiles.filter((item) => item.key !== profile.key));
  }

  async function startBatch(event) {
    event.preventDefault();
    if (!capabilities.online || !capabilities.orca_available) return showToast('The Mac slicer worker or OrcaSlicer is unavailable.', 'error');
    if (!projectName.trim()) return showToast('Enter a project name.', 'error');
    if (!profileKeys.length) return showToast('Select at least one enabled profile.', 'error');
    if (sourceMode === 'upload' && !files.length) return showToast('Choose one or more model files.', 'error');
    if (sourceMode === 'folder' && !sourceFolderId) return showToast('Choose a Mac folder.', 'error');
    setSaving(true);
    try {
      const form = new FormData();
      const meta = { project_name: projectName.trim(), source_mode: sourceMode, source_folder_id: sourceFolderId,
        profile_keys: profileKeys, options: { jobs: Number(jobCount), arrange, recursive, dry_run: dryRun } };
      if (sourceMode === 'upload') {
        const paths = files.map(({ file, relativePath }) => relativePath || file.name);
        form.set('file_paths', JSON.stringify(paths));
        for (const { file } of files) form.append('files', file, file.name);
      }
      form.set('meta', JSON.stringify(meta));
      const job = await responseJson(await fetch(`${API}/jobs`, { method: 'POST', body: form }));
      setProjectName(''); setFiles([]); setDryRun(false); loadJobs();
      showToast(`Batch ${job.id} queued`, 'success');
    } catch (error) { showToast(`Could not queue batch: ${error.message}`, 'error'); }
    finally { setSaving(false); }
  }

  async function cancelJob(job) {
    try {
      await responseJson(await fetch(`${API}/jobs/${job.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
      loadJobs();
      showToast('Cancellation requested', 'success');
    } catch (error) { showToast(`Cancel failed: ${error.message}`, 'error'); }
  }

  function fileSelection(fileList) {
    setFiles(Array.from(fileList || []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
  }

  return <div style={{ maxWidth: 1100, margin: '0 auto', color: '#e2e8f0' }}>
    <style>{`@media (max-width: 600px) { .batch-grid { grid-template-columns: 1fr !important; } .batch-two-col { grid-template-columns: 1fr !important; } }`}</style>
    <header style={{ marginBottom: 18 }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 25 }}>Batch Slice</h1>
      <div style={{ color: '#94a3b8', fontSize: 13 }}>Slice model batches on the Mac worker and import the results as a draft project.</div>
    </header>

    <section style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Mac worker</strong>
        <span style={{ color: capabilities.online && capabilities.orca_available ? '#86efac' : '#fbbf24', fontSize: 13 }}>
          {capabilities.online ? (capabilities.orca_available ? 'Online, OrcaSlicer ready' : 'Online, OrcaSlicer unavailable') : 'Offline'}
        </span>
      </div>
      {capabilities.worker_seen_at && <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>Last heartbeat: {new Date(capabilities.worker_seen_at).toLocaleString()}</div>}
      {!capabilities.online && <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>You can configure profiles while the worker is offline. Start and submit batches after it reconnects.</div>}
    </section>

    <section style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Printer profiles</h2>
        <button style={buttonStyle} type="button" onClick={() => editProfile()}>Add profile</button>
      </div>
      {!profiles.length && <p style={{ color: '#94a3b8', fontSize: 13 }}>Add a profile with registered printer model and Orca machine, process, and filament presets.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {profiles.map((profile) => <div key={profile.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 10, border: '1px solid #1e2433', borderRadius: 6, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1 }}>
            <input type="checkbox" checked={profileKeys.includes(profile.key)} disabled={!profile.enabled} onChange={(event) => setProfileKeys((keys) => event.target.checked
              ? [...keys.filter((key) => profiles.find((item) => item.key === key)?.printer_model_id !== profile.printer_model_id), profile.key]
              : keys.filter((key) => key !== profile.key))} />
            <span><strong>{profile.key}</strong><span style={{ display: 'block', color: '#64748b', fontSize: 12 }}>{models.find((model) => model.model_id === profile.printer_model_id)?.label || profile.printer_model_id} · {profile.machine} · {profile.process}</span></span>
          </label>
          <span style={{ color: profile.enabled ? '#86efac' : '#94a3b8', fontSize: 12 }}>{profile.enabled ? 'Enabled' : 'Disabled'}</span>
          <button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={() => editProfile(profile)}>Edit</button>
          <button type="button" style={{ ...buttonStyle, background: '#7f1d1d' }} onClick={() => deleteProfile(profile)}>Remove</button>
        </div>)}
      </div>
      {profileDraft && <form onSubmit={submitProfile} style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #2d3748', display: 'grid', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{profileDraft.originalKey ? 'Edit profile' : 'New profile'}</h3>
        <div className="batch-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="Output key"><input required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" style={fieldStyle} value={profileDraft.key} onChange={(event) => setProfileDraft({ ...profileDraft, key: event.target.value })} /></Field>
          <Field label="Print Garden printer model"><select required style={fieldStyle} value={profileDraft.printer_model_id} onChange={(event) => setProfileDraft({ ...profileDraft, printer_model_id: event.target.value })}><option value="">Select model</option>{models.map((model) => <option key={model.model_id} value={model.model_id}>{model.label} ({model.model_id})</option>)}</select></Field>
          <Field label="Machine preset"><select required style={fieldStyle} value={profileDraft.machine} onChange={(event) => setProfileDraft({ ...profileDraft, machine: event.target.value })}><option value="">Select machine preset</option>{(presetsByKind.machine || []).map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></Field>
          <Field label="Process preset"><select required style={fieldStyle} value={profileDraft.process} onChange={(event) => setProfileDraft({ ...profileDraft, process: event.target.value })}><option value="">Select process preset</option>{(presetsByKind.process || []).map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></Field>
          <Field label="Filament presets (select one or more)"><select multiple required style={{ ...fieldStyle, minHeight: 86 }} value={profileDraft.filaments} onChange={(event) => setProfileDraft({ ...profileDraft, filaments: Array.from(event.target.selectedOptions, (option) => option.value) })}>{(presetsByKind.filament || []).map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></Field>
          <Field label="Optional Orca arguments, one argument per line"><textarea rows={4} style={fieldStyle} value={profileDraft.extraText} onChange={(event) => setProfileDraft({ ...profileDraft, extraText: event.target.value })} /></Field>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><input type="checkbox" checked={profileDraft.enabled} onChange={(event) => setProfileDraft({ ...profileDraft, enabled: event.target.checked })} /> Enabled</label>
        <div style={{ display: 'flex', gap: 8 }}><button style={buttonStyle} disabled={saving}>Save profile</button><button type="button" style={{ ...buttonStyle, background: '#334155' }} onClick={() => setProfileDraft(null)}>Close</button></div>
      </form>}
      {!capabilities.presets?.length && <div style={{ color: '#fbbf24', fontSize: 12, marginTop: 10 }}>Preset choices appear when the Mac worker reports its configured preset roots.</div>}
    </section>

    <form onSubmit={startBatch} style={cardStyle}>
      <h2 style={{ margin: '0 0 14px', fontSize: 17 }}>New batch</h2>
      <div className="batch-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <Field label="Project name"><input required maxLength={100} style={fieldStyle} value={projectName} onChange={(event) => setProjectName(event.target.value)} /></Field>
        <Field label="Input source"><select style={fieldStyle} value={sourceMode} onChange={(event) => setSourceMode(event.target.value)}><option value="upload">Upload files or a folder</option><option value="folder">Mac worker folder</option></select></Field>
        {sourceMode === 'upload' ? <Field label="Model files (STL, 3MF, OBJ, STEP, STP)"><input type="file" multiple accept=".stl,.3mf,.obj,.step,.stp" style={fieldStyle} onChange={(event) => fileSelection(event.target.files)} /><input aria-label="Choose model folder" type="file" multiple webkitdirectory="" directory="" style={{ ...fieldStyle, marginTop: 6 }} onChange={(event) => fileSelection(event.target.files)} /><span style={{ color: '#64748b' }}>{files.length} file(s) selected</span></Field>
          : <Field label="Worker-approved folder"><select style={fieldStyle} value={sourceFolderId} onChange={(event) => setSourceFolderId(event.target.value)}><option value="">Select a Mac folder</option>{capabilities.source_folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>}
        <Field label="Parallel slice jobs"><input type="number" min="1" max="16" style={fieldStyle} value={jobCount} onChange={(event) => setJobCount(event.target.value)} /></Field>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, margin: '14px 0', fontSize: 13 }}>
        <label><input type="checkbox" checked={arrange} onChange={(event) => setArrange(event.target.checked)} /> Orca plate arrangement</label>
        <label><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /> Scan subfolders recursively</label>
        <label><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /> Dry run only</label>
      </div>
      <button style={buttonStyle} disabled={saving || !capabilities.online || !capabilities.orca_available}>{dryRun ? 'Preview batch' : 'Queue batch'}</button>
      {sourceMode === 'folder' && !capabilities.source_folders.length && <span style={{ color: '#fbbf24', fontSize: 12, marginLeft: 10 }}>No approved folders are available.</span>}
    </form>

    <section style={cardStyle}>
      <h2 style={{ margin: '0 0 12px', fontSize: 17 }}>Recent batches</h2>
      {!jobs.length && <p style={{ color: '#64748b', fontSize: 13 }}>No batches yet.</p>}
      <div style={{ display: 'grid', gap: 10 }}>
        {jobs.map((job) => <article key={job.id} style={{ border: '1px solid #1e2433', borderRadius: 6, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <strong>{job.project_name}</strong><Status value={job.status} />
          </div>
          <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>{job.message} · {job.progress?.done || 0}/{job.progress?.total || 0} slices</div>
          {job.progress?.total > 0 && <progress value={job.progress.done} max={job.progress.total} style={{ width: '100%', marginTop: 8 }} />}
          {job.project_id && <div style={{ marginTop: 8 }}><Link to="/projects" style={{ color: '#60a5fa' }}>Open project #{job.project_id}</Link></div>}
          {['queued', 'running'].includes(job.status) && <button type="button" onClick={() => cancelJob(job)} style={{ ...buttonStyle, background: '#7f1d1d', marginTop: 8 }}>Cancel batch</button>}
          {!!job.results?.length && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', color: '#cbd5e1', fontSize: 12 }}>Slice results ({job.results.length})</summary><div style={{ display: 'grid', gap: 5, marginTop: 8 }}>{job.results.map((result, index) => <div key={`${result.profile_key}-${result.model}-${index}`} style={{ color: result.ok ? '#86efac' : result.cancelled ? '#fbbf24' : '#fca5a5', fontSize: 12 }}>{result.ok ? 'OK' : result.cancelled ? 'Cancelled' : 'Failed'} · {result.model} · {result.profile_key}: {result.detail}</div>)}</div></details>}
          {!!job.logs?.length && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', color: '#94a3b8', fontSize: 12 }}>Worker log</summary><pre style={{ whiteSpace: 'pre-wrap', color: '#94a3b8', fontSize: 11 }}>{job.logs.join('\n')}</pre></details>}
        </article>)}
      </div>
    </section>
    {toastEl}{confirmModal}
  </div>;
}
