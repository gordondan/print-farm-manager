// Garden plot (see garden/README.md): the "Next:" line at the bottom of each Fleet card.
//
// This lives under client/src/ rather than garden/ only because Vite (and the Docker
// client-build stage) can only compile files inside client/. The data comes from
// GET /garden/api/fleet/next-jobs (garden/fleet/).
//
// Every card mounts one of these, so the fetch is shared: one module-level poll on the
// same 15 s cadence as the Fleet page, started by the first card and stopped when the
// last one unmounts.
import { useState, useEffect } from 'react';

const POLL_MS = 15000;

let nextJobs = null;          // { [printerId]: next_job | null }, null until first load
const listeners = new Set();
let timer = null;

function load() {
  fetch('/garden/api/fleet/next-jobs')
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(data => { nextJobs = data; listeners.forEach(fn => fn(data)); })
    .catch(() => {}); // background poll: swallow, keep the last good answer
}

function subscribe(fn) {
  listeners.add(fn);
  if (!timer) { load(); timer = setInterval(load, POLL_MS); }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) { clearInterval(timer); timer = null; }
  };
}

export default function NextJobLine({ printerId }) {
  const [jobs, setJobs] = useState(nextJobs);
  useEffect(() => subscribe(setJobs), []);

  if (!jobs || !(printerId in jobs)) return null; // not loaded yet
  const job = jobs[printerId];

  return (
    <div
      title={job
        ? `${job.project_name} / ${job.part_name}\n${job.filename}\n${job.parts_per_plate} per plate, ${job.remaining_qty} still needed`
        : 'No open part in an active project has a G-code this printer can run with its loaded filament'}
      style={{
        marginTop: 'auto', paddingTop: 6, borderTop: '1px solid #2d3748',
        fontSize: 11, color: '#64748b',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      Next:{' '}
      {job
        ? <span style={{ color: '#94a3b8' }}>{job.part_name} <span style={{ color: '#475569' }}>({job.project_name})</span></span>
        : <span style={{ color: '#475569' }}>nothing queued</span>}
    </div>
  );
}
