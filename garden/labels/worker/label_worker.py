#!/usr/bin/env python3
"""Garden label worker: slices "Send to Print Garden" label jobs on the Mac.

Print Garden runs in a Linux container with no slicer, so the label page only
queues plates (garden/labels/server.cjs). This loop, run on the farm host by
launchd (see install.sh), claims each job and hands every plate to the
add-to-printgarden helper, i.e. the same BatchSlicer + OrcaSlicer presets and
upload path used from the command line. Nothing is re-implemented here.

Per job:
  1. pick a project name that is not taken ("Labels ... (2)" on a clash)
  2. plate 1 creates the project as a draft; later plates join it by id, each
     with its own --parts-per-plate (= labels on that plate)
  3. activate only if every plate loaded, so the scheduler never sees a
     half-loaded batch; otherwise leave the draft and report why

Environment: PRINTGARDEN_URL (default http://localhost:3000),
PRINTGARDEN_HELPER (path to printgarden_add.py), LABEL_WORKER_POLL (seconds).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("PRINTGARDEN_URL", "http://localhost:3000").rstrip("/")
QUEUE = API + "/garden/api/labels"
HELPER = Path(os.environ.get(
    "PRINTGARDEN_HELPER",
    Path.home() / ".claude/skills/add-to-printgarden/helpers/printgarden_add.py"))
POLL = float(os.environ.get("LABEL_WORKER_POLL", "5"))
HELPER_TIMEOUT = 30 * 60  # one plate, all printer profiles


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def call(method, url, body=None):
    """JSON request; returns (status, parsed body or None)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def progress(job, **fields):
    st, _ = call("POST", "%s/jobs/%s/progress" % (QUEUE, job["id"]), fields)
    if st != 200:
        log("job %s: progress update refused: HTTP %s" % (job["id"], st))


def unique_project_name(name):
    st, projects = call("GET", API + "/api/projects")
    taken = {p["name"] for p in projects or []} if st == 200 else set()
    if name not in taken:
        return name
    n = 2
    while "%s (%d)" % (name, n) in taken:
        n += 1
    return "%s (%d)" % (name, n)


def plate_file_name(i, total, labels):
    """Part name the operator sees in Print Garden (the helper uses the stem)."""
    listing = ", ".join(labels)
    if len(listing) > 60:
        listing = listing[:57].rstrip(", ") + "..."
    stem = "Plate %d of %d - %s" % (i, total, listing)
    return re.sub(r'[\\/:*?"<>|]', "-", stem) + ".stl"


def run_helper(args, cwd):
    cmd = [sys.executable, str(HELPER), "add"] + args
    log("  $ " + " ".join(cmd))
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       timeout=HELPER_TIMEOUT)
    return p.returncode, p.stdout + p.stderr


def process(job):
    plates = job["plates"]
    total = len(plates)
    labels = sum(p["count"] for p in plates)
    name = unique_project_name(job["project"])
    log("job %s: %r, %d plate(s), %d label(s)" % (job["id"], name, total, labels))

    work = tempfile.mkdtemp(prefix="garden-labels-")
    transcript = []
    project_id = None
    try:
        for i, plate in enumerate(plates, 1):
            progress(job, message="Slicing plate %d of %d" % (i, total), done=i - 1)
            pdir = Path(work) / ("plate-%d" % i)
            pdir.mkdir()
            stl = pdir / plate_file_name(i, total, plate["labels"])
            with urllib.request.urlopen("%s/jobs/%s/plates/%d" % (QUEUE, job["id"], i),
                                        timeout=120) as r, open(stl, "wb") as f:
                shutil.copyfileobj(r, f)

            dest = ["--project", name] if project_id is None else ["--project-id", str(project_id)]
            code, out = run_helper([str(stl), *dest, "--draft",
                                    "--parts-per-plate", str(plate["count"])], work)
            transcript.append("--- plate %d ---\n%s" % (i, out))
            if project_id is None:
                m = re.search(r"^project (\d+):", out, re.M)
                project_id = int(m.group(1)) if m else None
            if code != 0 or project_id is None:
                where = (" Project %s left in draft." % project_id) if project_id else ""
                progress(job, status="failed", done=i - 1, project_id=project_id,
                         message="Plate %d of %d failed to slice or load.%s" % (i, total, where),
                         log="\n".join(transcript))
                return
            progress(job, message="Plate %d of %d loaded" % (i, total), done=i,
                     project_id=project_id)

        st, _ = call("PUT", "%s/api/projects/%d" % (API, project_id), {"status": "active"})
        state = "active" if st == 200 else "left in draft (activation failed: HTTP %s)" % st
        progress(job, status="done", done=total, project_id=project_id,
                 message="Project #%d “%s”: %d plate(s), %d label(s), %s"
                         % (project_id, name, total, labels, state),
                 log="\n".join(transcript))
        log("job %s: done -> project %d (%s)" % (job["id"], project_id, state))
    except Exception:
        progress(job, status="failed", project_id=project_id,
                 message="Worker error: %s" % traceback.format_exc().strip().splitlines()[-1],
                 log="\n".join(transcript) + "\n" + traceback.format_exc())
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    if not HELPER.exists():
        sys.exit("add-to-printgarden helper not found at %s (set PRINTGARDEN_HELPER)" % HELPER)
    log("label worker polling %s every %ss" % (QUEUE, POLL))
    once = "--once" in sys.argv
    while True:
        try:
            st, job = call("POST", QUEUE + "/jobs/claim", {})
            if st == 200 and job:
                process(job)
                continue  # there may be more waiting
            if st != 204:
                log("claim: HTTP %s %s" % (st, job))
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            log("Print Garden unreachable: %s" % e)
        except Exception:
            log(traceback.format_exc())
        if once:
            return
        time.sleep(POLL)


if __name__ == "__main__":
    main()
