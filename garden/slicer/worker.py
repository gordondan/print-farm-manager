#!/usr/bin/env python3
"""Mac worker for the Print Garden Labels and Batch Slice queues."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from garden.batch_slice import BatchConfigError, Profile, export_project_bundle, find_models, resolve_orca, run_batch
from garden.slicer.labels import process_label_job

API = os.environ.get("PRINTGARDEN_URL", "http://localhost:3000").rstrip("/")
BATCH = API + "/garden/api/batch-slice"
LABELS = API + "/garden/api/labels"
TOKEN = os.environ.get("PRINTGARDEN_WORKER_TOKEN", "")
POLL_SECONDS = float(os.environ.get("SLICER_WORKER_POLL", "4"))
HEARTBEAT_SECONDS = 20
MODEL_EXTS = {".stl", ".3mf", ".obj", ".step", ".stp"}


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def headers(json_body: bool = False) -> dict[str, str]:
    values = {"Authorization": "Bearer " + TOKEN}
    if json_body:
        values["Content-Type"] = "application/json"
    for env, header in (("CF_ACCESS_CLIENT_ID", "CF-Access-Client-Id"), ("CF_ACCESS_CLIENT_SECRET", "CF-Access-Client-Secret")):
        if os.environ.get(env):
            values[header] = os.environ[env]
    return values


def api_call(method: str, url: str, body: object | None = None, timeout: int = 30):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers(body is not None))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else None
        except ValueError:
            return error.code, raw.decode("utf-8", "replace")


def preset_kind(path: Path) -> str:
    for parent in path.parents:
        name = parent.name.lower()
        if name in {"machine", "process", "filament", "filaments"}:
            return "filament" if name == "filaments" else name
    return "other"


def inventory_presets(roots: list[Path]) -> dict[str, dict[str, object]]:
    found = {}
    for root in roots:
        try:
            resolved_root = root.expanduser().resolve(strict=True)
        except OSError:
            continue
        for preset in resolved_root.rglob("*.json"):
            try:
                resolved = preset.resolve(strict=True)
                resolved.relative_to(resolved_root)
                if not resolved.is_file():
                    continue
                kind = preset_kind(resolved)
                if kind == "other":
                    continue
                stable_id = hashlib.sha256(str(resolved).encode()).hexdigest()[:20]
                found[stable_id] = {"id": stable_id, "kind": kind, "label": resolved.stem, "path": resolved}
            except (OSError, ValueError):
                continue
    return found


def source_roots() -> list[Path]:
    return [Path(item).expanduser().resolve() for item in os.environ.get("PRINTGARDEN_SOURCE_ROOTS", "").split(os.pathsep) if item.strip()]


def folder_inventory(roots: list[Path]) -> tuple[list[dict[str, str]], dict[str, Path]]:
    public = []
    private: dict[str, Path] = {}
    for root_index, root in enumerate(roots):
        if not root.is_dir():
            continue
        root_label = f"{root.parent.name}/{root.name}"
        candidates = {root}
        try:
            for model in root.rglob("*"):
                if model.is_file() and not model.is_symlink() and model.suffix.lower() in MODEL_EXTS:
                    folder = model.parent
                    while folder == root or root in folder.parents:
                        candidates.add(folder)
                        if folder == root:
                            break
                        folder = folder.parent
        except OSError:
            continue
        for folder in candidates:
            try:
                resolved = folder.resolve(strict=True)
                resolved.relative_to(root.resolve(strict=True))
                stable_id = hashlib.sha256((str(root_index) + ":" + resolved.relative_to(root).as_posix()).encode()).hexdigest()[:20]
            except (OSError, ValueError):
                continue
            relative = resolved.relative_to(root).as_posix()
            name = root_label if relative == "." else f"{root_label}/{relative}"
            public.append({"id": stable_id, "name": name})
            private[stable_id] = resolved
    public.sort(key=lambda item: (item["name"].count("/"), item["name"].casefold()))
    return public, private


class WorkerContext:
    def __init__(self) -> None:
        self.roots = source_roots()
        self.preset_roots = [Path(item).expanduser().resolve() for item in os.environ.get("ORCA_PRESET_ROOTS", "").split(os.pathsep) if item.strip()]
        self.folders, self.folder_paths = folder_inventory(self.roots)
        self.presets = inventory_presets(self.preset_roots)
        self.orca = resolve_orca(os.environ.get("ORCA_PATH"))
        self.stop = threading.Event()

    def refresh_capabilities(self) -> None:
        self.roots = source_roots()
        self.preset_roots = [Path(item).expanduser().resolve() for item in os.environ.get("ORCA_PRESET_ROOTS", "").split(os.pathsep) if item.strip()]
        self.folders, self.folder_paths = folder_inventory(self.roots)
        self.presets = inventory_presets(self.preset_roots)
        self.orca = resolve_orca(os.environ.get("ORCA_PATH"))

    def heartbeat(self) -> None:
        self.refresh_capabilities()
        status, response = api_call("POST", BATCH + "/worker/heartbeat", {
            "orca_available": bool(self.orca), "source_folders": self.folders,
            "presets": [{k: v for k, v in item.items() if k != "path"} for item in self.presets.values()],
        })
        if status != 200:
            log(f"heartbeat refused: HTTP {status} {response}")
        label_status, label_response = api_call("POST", LABELS + "/worker/heartbeat", {})
        if label_status != 200:
            log(f"Labels heartbeat refused: HTTP {label_status} {label_response}")

    def profile_definitions(self) -> dict[str, Profile]:
        status, config = api_call("GET", BATCH + "/worker/config")
        if status != 200:
            raise RuntimeError(f"could not load worker config: HTTP {status} {config}")
        self.refresh_capabilities()
        result = {}
        for item in config.get("profiles", []):
            if not item.get("enabled", True):
                continue
            machine = self.presets.get(item.get("machine"))
            process = self.presets.get(item.get("process"))
            filaments = [self.presets.get(preset_id) for preset_id in item.get("filaments", [])]
            if not machine or machine["kind"] != "machine" or not process or process["kind"] != "process" or not filaments or any(not p or p["kind"] != "filament" for p in filaments):
                raise BatchConfigError(f"{item.get('key', '(profile)')}: a selected preset is unavailable on the worker; refresh the preset inventory and update the profile")
            result[item["key"]] = Profile(
                key=item["key"], printer_model_id=item["printer_model_id"],
                machine=machine["path"], process=process["path"],
                filaments=[preset["path"] for preset in filaments], extra=list(item.get("extra", [])),
            )
        return result


def resolve_source(job: dict, destination: Path, folders: dict[str, Path]) -> Path:
    if job["source_mode"] == "upload":
        root = destination / "input"
        root.mkdir(parents=True, exist_ok=True)
        for index, item in enumerate(job["files"]):
            relative = item["relative_path"]
            if "\\" in relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise ValueError("unsafe uploaded relative path")
            target = root.joinpath(*Path(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            status, response = download_to(BATCH + f"/jobs/{job['id']}/files/{index}", target)
            if status != 200:
                raise RuntimeError(f"could not stage uploaded file {relative}: HTTP {status} {response}")
        return root

    base = folders.get(job.get("input", {}).get("source_folder_id"))
    if base is None:
        raise ValueError("selected Mac folder is no longer available; refresh the folder list")
    relative = job.get("input", {}).get("relative_path", "")
    if "\\" in relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("unsafe Mac folder path")
    selected = (base / relative).resolve(strict=True)
    selected.relative_to(base.resolve(strict=True))
    if not selected.is_dir() and not selected.is_file():
        raise ValueError("selected Mac path is not a file or folder")
    return selected


def download_to(url: str, destination: Path):
    request = urllib.request.Request(url, headers=headers())
    try:
        with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
            return response.status, None
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")[:300]


def public_result(result, source_root: Path, context: WorkerContext | None = None) -> dict:
    try:
        model = result.model.resolve().relative_to(source_root.resolve()).as_posix()
    except (ValueError, OSError):
        model = result.model.name
    detail = result.detail
    if result.command and result.detail == shlex.join(result.command):
        safe = []
        index = 0
        while index < len(result.command):
            value = result.command[index]
            if context and value == context.orca:
                safe.append("OrcaSlicer")
            elif value == "--load-settings" and index + 1 < len(result.command):
                safe.extend([value, "<machine preset>;<process preset>"])
                index += 1
            elif value == "--load-filaments" and index + 1 < len(result.command):
                safe.extend([value, "<filament preset(s)>"])
                index += 1
            elif value == "--outputdir" and index + 1 < len(result.command):
                safe.extend([value, "<temporary output>"])
                index += 1
            else:
                try:
                    safe.append("<model>" if Path(value).is_absolute() else value)
                except (TypeError, ValueError):
                    safe.append(str(value))
            index += 1
        detail = shlex.join(safe)
    detail = redact_text(detail, context)
    return {"profile_key": result.profile_key, "model": model, "ok": result.ok,
            "detail": detail[:500], "cancelled": result.cancelled}


def redact_text(value: str, context: WorkerContext | None = None, extra_paths=()) -> str:
    text = value
    roots = [Path.home(), *extra_paths]
    if context:
        roots.extend([*context.roots, *context.preset_roots])
    for root in roots:
        text = text.replace(str(root), "<worker path>")
    return re.sub(r"(?:/Users/[^\s]+|/Volumes/[^\s]+|/Applications/[^\s]+|/private/tmp/[^\s]+|/tmp/[^\s]+)", "<worker path>", text)


def check_cancel(job_id: str, lease_id: str, stop: threading.Event) -> None:
    while not stop.wait(5):
        status, state = api_call("GET", BATCH + f"/worker/jobs/{job_id}")
        if status != 200 or state.get("lease_id") != lease_id or state.get("cancel_requested"):
            stop.set()
            return


def upload_bundle(bundle: Path, job_id: str) -> dict:
    boundary = "----PrintGarden" + hashlib.sha256((job_id + str(time.time())).encode()).hexdigest()[:24]
    url = urllib.parse.urlsplit(API + "/api/project-bundles/import")
    connection_class = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_class(url.hostname, url.port, timeout=180)
    path = url.path + (("?" + url.query) if url.query else "")
    filename = "batch-slice-project.zip"
    prefix = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
              "Content-Type: application/zip\r\n\r\n").encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    headers_out = {**headers(), "Content-Type": f"multipart/form-data; boundary={boundary}",
                   "Content-Length": str(len(prefix) + bundle.stat().st_size + len(suffix)),
                   "Idempotency-Key": f"batch-slice:{job_id}"}
    connection.putrequest("POST", path)
    for name, value in headers_out.items():
        connection.putheader(name, value)
    connection.endheaders()
    connection.send(prefix)
    with bundle.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            connection.send(chunk)
    connection.send(suffix)
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {"error": raw.decode("utf-8", "replace")[:500]}
    if response.status not in (200, 201):
        raise RuntimeError(f"project import failed: HTTP {response.status} {data}")
    return data


def process_batch_slice(job: dict, context: WorkerContext) -> None:
    temporary = Path(tempfile.mkdtemp(prefix="garden-batch-slice-"))
    stop = threading.Event()
    result_rows = []
    result_lock = threading.Lock()
    lease_id = job["lease_id"]
    monitor = threading.Thread(target=check_cancel, args=(job["id"], lease_id, stop), daemon=True)
    monitor.start()

    def report(event: str, payload: object) -> None:
        if event == "result":
            with result_lock:
                result_rows.append(public_result(payload, source, context))
                current = list(result_rows)
            progress = {"done": len(current), "total": total, "current": None}
            post_progress(job, lease_id, {"progress": progress, "results": current,
                "message": f"Completed {len(current)} of {total} slices"})
        elif event == "started":
            post_progress(job, lease_id, {"progress": {"done": len(result_rows), "total": total,
                "current": {"model": Path(payload["model"]).name, "profile_key": payload["profile"].key}},
                "message": f"Slicing {Path(payload['model']).name} for {payload['profile'].key}"})
        elif event == "plan":
            post_progress(job, lease_id, {"progress": {"done": 0, "total": payload["total"], "current": None},
                "message": "Dry run: prepared slice plan" if job["options"]["dry_run"] else "Slicing batch"})

    try:
        definitions = context.profile_definitions()
        profiles = [definitions[key] for key in job["profile_keys"] if key in definitions]
        if len(profiles) != len(job["profile_keys"]):
            raise BatchConfigError("One or more selected profiles are no longer enabled")
        if not context.orca:
            raise BatchConfigError("OrcaSlicer is not available on the Mac worker")
        source = resolve_source(job, temporary, context.folder_paths)
        models = find_models(source, job["options"]["recursive"])
        if not models:
            raise BatchConfigError("No supported models found in the selected source")
        if job["source_mode"] == "folder":
            allowed_root = context.folder_paths[job["input"]["source_folder_id"]].resolve(strict=True)
            for model in models:
                model.resolve(strict=True).relative_to(allowed_root)
        total = len(models) * len(profiles)
        if job["options"]["dry_run"]:
            summary = run_batch(source, temporary / "output", profiles, context.orca,
                jobs=job["options"]["jobs"], arrange=job["options"]["arrange"],
                recursive=job["options"]["recursive"], dry_run=True, stop_event=stop, callback=report)
            results = [public_result(result, source, context) for result in summary.results]
            cancelled = summary.cancelled or stop.is_set()
            post_progress(job, lease_id, {"status": "cancelled" if cancelled else "completed",
                "progress": {"done": len(results), "total": total, "current": None},
                "results": results,
                "message": (f"Dry run cancelled after {len(results)} planned slices. No project was created."
                    if cancelled else f"Dry run complete: {len(results)} planned slices. No project was created.")})
            return

        bundle = temporary / "batch-slice.zip"
        summary = export_project_bundle(source, bundle, job["project_name"], profiles, context.orca,
            jobs=job["options"]["jobs"], arrange=job["options"]["arrange"],
            recursive=job["options"]["recursive"], stop_event=stop, callback=report)
        imported = upload_bundle(bundle, job["id"])
        project = imported.get("project") or {}
        final_status = "cancelled" if summary.cancelled or stop.is_set() else "completed"
        successes = summary.succeeded
        failures = summary.failed + summary.cancelled_count
        post_progress(job, lease_id, {"status": final_status, "project_id": project.get("id"),
            "progress": {"done": summary.total, "total": summary.total, "current": None},
            "results": [public_result(result, source, context) for result in summary.results],
            "message": f"{'Partial' if failures else 'Complete'} draft project #{project.get('id')} imported: {successes} slice(s) succeeded, {failures} failed or cancelled."})
    except Exception as error:
        log(f"batch job {job['id']} failed: {error}")
        clean_error = redact_text(str(error), context, [temporary])
        clean_trace = redact_text(traceback.format_exc(), context, [temporary])
        post_progress(job, lease_id, {"status": "failed", "message": clean_error[:500],
            "logs": [clean_trace[-5000:]], "results": result_rows})
    finally:
        stop.set()
        shutil.rmtree(temporary, ignore_errors=True)


def post_progress(job: dict, lease_id: str, fields: dict) -> None:
    payload = {**fields, "lease_id": lease_id}
    status, response = api_call("POST", BATCH + f"/jobs/{job['id']}/progress", payload)
    if status != 200:
        log(f"batch job {job['id']}: progress update refused: HTTP {status} {response}")


def claim_batch():
    return api_call("POST", BATCH + "/jobs/claim", {})


def claim_labels():
    return api_call("POST", LABELS + "/jobs/claim", {})


def main() -> int:
    if not TOKEN:
        raise SystemExit("PRINTGARDEN_WORKER_TOKEN is required")
    context = WorkerContext()
    context.heartbeat()
    log(f"slicer worker polling {BATCH} and {LABELS} every {POLL_SECONDS:g}s")
    heartbeat_stop = threading.Event()

    def heartbeat_loop():
        while not heartbeat_stop.wait(HEARTBEAT_SECONDS):
            try:
                context.heartbeat()
            except Exception as error:
                log(f"heartbeat failed: {error}")

    heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    heartbeat_thread.start()
    once = "--once" in sys.argv
    prefer_batch = True
    try:
        while True:
            try:
                order = [(claim_batch, "batch"), (claim_labels, "labels")] if prefer_batch else [(claim_labels, "labels"), (claim_batch, "batch")]
                claimed = False
                for claim, kind in order:
                    status, job = claim()
                    if status == 200 and job:
                        claimed = True
                        prefer_batch = kind != "batch"
                        log(f"claimed {kind} job {job['id']}")
                        if kind == "batch":
                            process_batch_slice(job, context)
                        else:
                            process_label_job(job, API, BATCH, TOKEN)
                        break
                    if status not in (204, 200):
                        log(f"{kind} claim: HTTP {status} {job}")
                if once:
                    return 0
                if not claimed:
                    time.sleep(POLL_SECONDS)
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as error:
                log(f"Print Garden unreachable: {error}")
                if once:
                    return 1
                time.sleep(POLL_SECONDS)
            except Exception:
                log(traceback.format_exc())
                if once:
                    return 1
                time.sleep(POLL_SECONDS)
    finally:
        heartbeat_stop.set()


if __name__ == "__main__":
    sys.exit(main())
