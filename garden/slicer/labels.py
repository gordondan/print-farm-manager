"""Compatibility processing for the existing Labels plate queue."""
from __future__ import annotations

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

HELPER = Path(__file__).with_name("printgarden_add.py")
HELPER_TIMEOUT = 30 * 60


def _headers(json_body=False):
    result = {"Authorization": "Bearer " + os.environ.get("PRINTGARDEN_WORKER_TOKEN", "")}
    if json_body:
        result["Content-Type"] = "application/json"
    for env, header in (("CF_ACCESS_CLIENT_ID", "CF-Access-Client-Id"), ("CF_ACCESS_CLIENT_SECRET", "CF-Access-Client-Secret")):
        if os.environ.get(env):
            result[header] = os.environ[env]
    return result


def _call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=_headers(body is not None))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else None
        except ValueError:
            return error.code, raw.decode("utf-8", "replace")


def _progress(queue, job, **fields):
    status, body = _call("POST", f"{queue}/jobs/{job['id']}/progress", fields)
    if status != 200:
        print(f"label job {job['id']}: progress refused: HTTP {status} {body}", flush=True)


def _unique_name(api, project_name):
    status, projects = _call("GET", api + "/api/projects")
    taken = {item["name"] for item in projects or []} if status == 200 else set()
    if project_name not in taken:
        return project_name
    suffix = 2
    while f"{project_name} ({suffix})" in taken:
        suffix += 1
    return f"{project_name} ({suffix})"


def _plate_filename(index, total, labels):
    listing = ", ".join(labels)
    if len(listing) > 60:
        listing = listing[:57].rstrip(", ") + "..."
    name = f"Plate {index} of {total} - {listing}"
    return re.sub(r'[\\/:*?"<>|]', "-", name) + ".stl"


def _sanitize(text, work):
    roots = [Path.home(), work]
    roots.extend(Path(item).expanduser() for item in os.environ.get("ORCA_PRESET_ROOTS", "").split(os.pathsep) if item)
    for root in roots:
        text = text.replace(str(root), "<worker path>")
    return re.sub(r"(?:/Users/[^\s]+|/Volumes/[^\s]+|/Applications/[^\s]+|/private/tmp/[^\s]+|/tmp/[^\s]+)", "<worker path>", text)


def process_label_job(job, api, _batch_queue, token):
    """Slice and load label plates with the integrated engine and web profiles."""
    plates = job["plates"]
    total = len(plates)
    label_count = sum(item["count"] for item in plates)
    project_name = _unique_name(api, job["project"])
    work = Path(tempfile.mkdtemp(prefix="garden-labels-"))
    transcript = []
    project_id = None
    env = os.environ.copy()
    env["PRINTGARDEN_URL"] = api
    env["PRINTGARDEN_WORKER_TOKEN"] = token

    try:
        for index, plate in enumerate(plates, 1):
            _progress(job, _label_queue(api), message=f"Slicing plate {index} of {total}", done=index - 1)
            plate_dir = work / f"plate-{index}"
            plate_dir.mkdir()
            model = plate_dir / _plate_filename(index, total, plate["labels"])
            request = urllib.request.Request(
                f"{api}/garden/api/labels/jobs/{job['id']}/plates/{index}", headers=_headers())
            with urllib.request.urlopen(request, timeout=120) as response, model.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)

            destination = ["--project", project_name] if project_id is None else ["--project-id", str(project_id)]
            command = [sys.executable, str(HELPER), "add", str(model), *destination,
                       "--draft", "--parts-per-plate", str(plate["count"]), "--depth", "0"]
            completed = subprocess.run(command, cwd=work, env=env, capture_output=True,
                                       text=True, timeout=HELPER_TIMEOUT)
            output_text = _sanitize((completed.stdout or "") + (completed.stderr or ""), work)
            transcript.append(f"--- plate {index} ---\n{output_text}")
            if project_id is None:
                match = re.search(r"^project (\d+):", output_text, re.M)
                project_id = int(match.group(1)) if match else None
            if completed.returncode or project_id is None:
                note = f" Project {project_id} remains in draft." if project_id else ""
                _progress(job, _label_queue(api), status="failed", done=index - 1, project_id=project_id,
                          message=f"Plate {index} of {total} failed to slice or load.{note}", log="\n".join(transcript))
                return
            _progress(job, _label_queue(api), message=f"Plate {index} of {total} loaded", done=index,
                      project_id=project_id, log="\n".join(transcript)[-20000:])

        status, response = _call("PUT", f"{api}/api/projects/{project_id}", {"status": "active"})
        state = "active" if status == 200 else f"left in draft (activation failed: HTTP {status})"
        _progress(job, _label_queue(api), status="done", done=total, project_id=project_id,
                  message=f"Project #{project_id} {project_name}: {total} plate(s), {label_count} label(s), {state}.",
                  log="\n".join(transcript)[-20000:])
        print(f"label job {job['id']} done: project {project_id} ({state})", flush=True)
    except Exception as error:
        trace = traceback.format_exc()
        _progress(job, _label_queue(api), status="failed", project_id=project_id,
                  message=f"Worker error: {_sanitize(str(error), work)}",
                  log=("\n".join(transcript) + "\n" + _sanitize(trace, work))[-20000:])
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _label_queue(api):
    return api.rstrip("/") + "/garden/api/labels"
