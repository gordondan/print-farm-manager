#!/usr/bin/env python3
"""Slice models with Print Garden's integrated engine and load their G-code.

Subcommands
-----------
  scan <path> [--depth N]      Report what would be processed, as JSON. Run this
                               FIRST: its `has_subdirs` flag is what tells the
                               caller whether to ask the user about recursion.
  models                       List the printer model IDs Print Garden accepts.
  add  <path> --project NAME   Slice, then create project + parts + G-codes.

Profiles are stored by Print Garden. The Mac worker resolves their stable
preset IDs to local OrcaSlicer files; filesystem paths never come from the UI.

Bambu printers need the sliced .gcode.3mf container, everything else takes raw
.gcode. The integrated engine chooses the artifact format for each profile.
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

API = os.environ.get("PRINTGARDEN_URL", "http://localhost:3000").rstrip("/")

# g/cm3, for deriving a weight when the slicer profile reports none. Sovol's
# stock SV08 filament presets carry filament_density 0, so their G-code says
# "total filament used [g] = 0.00"; Print Garden treats a zero as unknown, so
# without this the schedule would have no weight at all for those plates.
DENSITY = {"PLA": 1.24, "PETG": 1.27, "ABS": 1.04, "ASA": 1.07,
           "TPU": 1.21, "PA": 1.14, "PC": 1.20}


# --- discovery --------------------------------------------------------

def discover(root, depth, exts):
    """Model files at or above `depth` below `root`. depth<0 means unlimited.

    depth 0 is the folder itself, 1 adds its immediate subfolders, and so on.
    """
    root = Path(root).expanduser().resolve()
    if root.is_file():
        return [root]
    base = len(root.parts)
    found = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in exts:
            continue
        if depth >= 0 and (len(p.parent.parts) - base) > depth:
            continue
        found.append(p)
    return found


def scan(root, exts):
    """Describe the tree without slicing anything."""
    root = Path(root).expanduser().resolve()
    if not root.exists():
        raise SystemExit("no such path: %s" % root)
    if root.is_file():
        return {"root": str(root), "is_file": True, "has_subdirs": False,
                "subdirs": [], "max_model_depth": 0,
                "counts_by_depth": {"0": 1}, "cumulative_by_depth": {"0": 1},
                "total_unlimited": 1, "files": [root.name]}

    every = discover(root, -1, exts)
    base = len(root.parts)
    by_depth = {}
    for p in every:
        by_depth.setdefault(len(p.parent.parts) - base, []).append(p)

    # Only subdirectories that actually hold models matter for the recursion
    # question - a stray "images/" folder is not worth asking about.
    subdirs = sorted({
        str(p.parent.relative_to(root)).split(os.sep)[0]
        for p in every if p.parent != root
    })
    cumulative, running = {}, 0
    for d in sorted(by_depth):
        running += len(by_depth[d])
        cumulative[str(d)] = running
    return {
        "root": str(root), "is_file": False,
        "has_subdirs": bool(subdirs), "subdirs": subdirs,
        "max_model_depth": max(by_depth) if by_depth else 0,
        "counts_by_depth": {str(d): len(v) for d, v in sorted(by_depth.items())},
        "cumulative_by_depth": cumulative,
        "total_unlimited": len(every),
        "files": [str(p.relative_to(root)) for p in every],
    }


# --- slicing ----------------------------------------------------------

def profile_material(key):
    """The material half of a `printer-material` Batch Slicer profile key.

    Once more than one material is in play at once there is no single
    --material value left to read, so the filename, the weight calculation and
    required_material are all read back off the profile that produced the
    plate. The key is the only place that pairing is recorded.
    """
    return key.split("-", 1)[1].upper() if "-" in key else ""


def material_plan(spec, printers):
    """[(printer, material)] from --material.

    Two forms. A bare material - "PETG" - applies to every printer. The
    per-printer form - "p1s=PLA,sv08=PETG" - gives each its own, and is the
    default.

    Why per printer, and why a bare LIST of materials is refused: Print Garden
    keys a plate by (part, printer model) and nothing else. One plate per
    printer, no more. `--material PLA,PETG` looks like it should leave both
    standing ready for the scheduler to choose between, but the second one is
    a 409 against the first, and which survives comes down to sort order. The
    only way to have both materials ready at once is to stand them on
    different printers, which is what the default does.
    """
    parts = [t.strip() for t in spec.split(",") if t.strip()]
    if not parts:
        raise SystemExit("--material is empty")
    if not any("=" in t for t in parts):
        if len(parts) > 1:
            raise SystemExit(
                "--material %s asks for %d materials on every printer, and "
                "Print Garden allows one plate per part per printer model - "
                "the second upload is a 409 against the first.\nAssign them to "
                "different printers instead, e.g. --material %s"
                % (spec, len(parts),
                   ",".join("%s=%s" % (pr, m) for pr, m
                            in zip(printers, parts))))
        return [(pr, parts[0].upper()) for pr in printers]

    table = {}
    for t in parts:
        k, sep, v = t.partition("=")
        if not sep:
            raise SystemExit("--material mixes forms: %r has no '='" % t)
        table[k.strip().lower()] = v.strip().upper()
    missing = [pr for pr in printers if pr.lower() not in table]
    if missing:
        raise SystemExit("--material does not say what %s prints in"
                         % ", ".join(missing))
    return [(pr, table[pr.lower()]) for pr in printers]


def load_profiles(plan):
    """Load the matching Print Garden profiles and resolve worker preset IDs."""
    status, cfg = _call("GET", "/garden/api/batch-slice/worker/config")
    if status != 200:
        raise SystemExit("could not load Print Garden slicer config: HTTP %s %s" % (status, cfg))
    want = {"%s-%s" % (pr.lower(), m.lower()) for pr, m in plan}
    import hashlib
    import garden.batch_slice.engine as BS

    presets = {}
    preset_roots = [item for item in os.environ.get("ORCA_PRESET_ROOTS", "").split(os.pathsep) if item.strip()]
    for root in preset_roots:
        base = Path(root).resolve()
        if not base.is_dir():
            continue
        for candidate in base.rglob("*.json"):
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(base)
                stable_id = hashlib.sha256(str(resolved).encode()).hexdigest()[:20]
                presets[stable_id] = resolved
            except (OSError, ValueError):
                pass

    chosen = []
    for key in sorted(want):
        for p in cfg.get("profiles", []):
            if p.get("key", "").lower() != key:
                continue
            selected = [p.get("machine"), p.get("process"), *(p.get("filaments") or [])]
            if not p.get("enabled", True) or any(pid not in presets for pid in selected):
                continue
            chosen.append(BS.Profile(
                key=p["key"],
                printer_model_id=p["printer_model_id"],
                machine=presets[p["machine"]],
                process=presets[p["process"]],
                filaments=[presets[f] for f in p.get("filaments", [])],
                extra=list(p.get("extra", [])),
            ))
            break
    missing = want - {c.key.lower() for c in chosen}
    if missing:
        have = ", ".join(sorted(p.get("key", "") for p in cfg.get("profiles", [])))
        raise SystemExit("no Print Garden profile for: %s\navailable: %s"
                         % (", ".join(sorted(missing)), have))
    return chosen, BS, os.environ.get("ORCA_PATH") or None


def slice_all(files, profiles, BS, orca_hint, workdir, arrange=True):
    """Slice every file against every profile. Returns {file: {key: artifact}}."""
    orca = BS.resolve_orca(orca_hint)
    if not orca:
        raise SystemExit("OrcaSlicer not found - configure ORCA_PATH for the worker.")
    out = {}
    # Orca's CLI drops a 00000.log in its working directory; keep that in the
    # temp dir instead of wherever the caller happened to be standing.
    prev = os.getcwd()
    os.chdir(workdir)
    try:
        for f in files:
            summary = BS.run_batch(f, Path(workdir) / "gcode", profiles, orca,
                                   jobs=len(profiles), arrange=arrange)
            out[f] = {}
            for r in summary.results:
                out[f][r.profile_key] = (r.artifact if r.ok else None, r.detail)
    finally:
        os.chdir(prev)
    return out


# --- reading the slicer's own numbers ---------------------------------

def _gcode_text(path):
    if path.suffix.lower() == ".3mf":
        with zipfile.ZipFile(path) as z:
            if "Metadata/plate_1.gcode" not in z.namelist():
                return ""
            return z.read("Metadata/plate_1.gcode").decode("utf-8", "replace")
    return path.read_text("utf-8", "replace")


def _duration(text):
    """'1h 13m 3s' -> seconds."""
    got = re.findall(r"(\d+)\s*([hms])", text)
    if not got:
        return None
    mult = {"h": 3600, "m": 60, "s": 1}
    return sum(int(n) * mult[u] for n, u in got)


def estimates(path, material):
    """(seconds, grams) from the sliced file, or (None, None)."""
    secs = grams = None
    if path.suffix.lower() == ".3mf":
        with zipfile.ZipFile(path) as z:
            if "Metadata/slice_info.config" in z.namelist():
                info = z.read("Metadata/slice_info.config").decode("utf-8", "replace")
                # Only plate 1 - the plate the Bambu driver actually prints.
                plate = info.split('key="index" value="1"', 1)
                if len(plate) > 1:
                    m = re.search(r'key="prediction" value="(\d+)"', plate[1])
                    if m:
                        secs = int(m.group(1))
                    m = re.search(r'key="weight" value="([\d.]+)"', plate[1])
                    if m and float(m.group(1)) > 0:
                        grams = float(m.group(1))

    text = _gcode_text(path)
    if secs is None:
        m = (re.search(r"total estimated time:\s*([0-9hms ]+)", text)
             or re.search(r"estimated printing time \(normal mode\)\s*=\s*([0-9hms ]+)", text))
        if m:
            secs = _duration(m.group(1))
    if grams is None:
        m = re.search(r"total filament used \[g\]\s*=\s*([\d.]+)", text)
        if m and float(m.group(1)) > 0:
            grams = float(m.group(1))
    if grams is None:
        m = re.search(r"filament used \[cm3\]\s*=\s*([\d.]+)", text)
        if m:
            vol = float(m.group(1))
            if vol > 0:
                grams = round(vol * DENSITY.get(material.upper(), 1.24), 2)
    return secs, grams


# --- Print Garden API -------------------------------------------------

def _headers():
    h = {}
    token = os.environ.get("PRINTGARDEN_WORKER_TOKEN")
    if token:
        h["Authorization"] = "Bearer " + token
    cid = os.environ.get("CF_ACCESS_CLIENT_ID")
    sec = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    # Only worth sending to a remote host; localhost sits behind no Access app.
    if cid and sec and "localhost" not in API and "127.0.0.1" not in API:
        h["CF-Access-Client-Id"] = cid
        h["CF-Access-Client-Secret"] = sec
    return h


def _call(method, path, body=None):
    data, hdrs = None, _headers()
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw[:300]}
    except urllib.error.URLError as e:
        raise SystemExit(
            "cannot reach Print Garden at %s (%s).\n"
            "Run this on the farm host, or set PRINTGARDEN_URL. The public "
            "host is behind Cloudflare Access." % (API, e.reason))


def _upload(part_id, model_id, filepath, fields):
    """multipart/form-data POST to /api/gcodes/upload."""
    boundary = "----pg" + uuid.uuid4().hex
    buf = bytearray()

    def part(name, value):
        buf.extend(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                    % (boundary, name, value)).encode())

    part("part_id", part_id)
    part("printer_model", model_id)
    for k, v in fields.items():
        if v not in (None, ""):
            part(k, v)
    ctype = mimetypes.guess_type(filepath.name)[0] or "application/octet-stream"
    buf.extend(("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
                "filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
                % (boundary, filepath.name, ctype)).encode())
    buf.extend(filepath.read_bytes())
    buf.extend(("\r\n--%s--\r\n" % boundary).encode())

    hdrs = _headers()
    hdrs["Content-Type"] = "multipart/form-data; boundary=" + boundary
    req = urllib.request.Request(API + "/api/gcodes/upload", data=bytes(buf),
                                 headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw[:300]}


def resolve_model_id(profile_key, models, overrides, is_bambu):
    """Map a Batch Slicer profile key onto a Print Garden model_id.

    These namespaces are NOT the same: Batch Slicer calls the Sovol "sv08"
    while Print Garden registers it as "sv". Guessing wrong is a 400 at upload,
    so match explicitly and fail loudly rather than picking something plausible.
    """
    base = profile_key.split("-", 1)[0].lower()
    ids = {m["model_id"].lower(): m["model_id"] for m in models}
    if base in overrides:
        want = overrides[base]
        if want.lower() not in ids:
            raise SystemExit("--map %s=%s: %r is not a registered Print Garden "
                             "model.\nregistered: %s"
                             % (base, want, want, ", ".join(sorted(ids.values()))))
        return ids[want.lower()]
    if base in ids:
        return ids[base]
    near = [m["model_id"] for m in models
            if base.startswith(m["model_id"].lower())
            or m["model_id"].lower().startswith(base)]
    if len(near) == 1:
        return near[0]
    conn = "bambu" if is_bambu else "klipper"
    same = [m["model_id"] for m in models if m.get("connector") == conn]
    if len(same) == 1:
        return same[0]
    raise SystemExit(
        "cannot map profile '%s' to a Print Garden model.\nregistered: %s\n"
        "Pass --map %s=<model_id>."
        % (profile_key, ", ".join(sorted(ids.values())), base))


# --- the add command --------------------------------------------------

def cmd_add(args):
    exts = {e if e.startswith(".") else "." + e for e in args.ext.lower().split(",")}
    files = discover(args.path, args.depth, exts)
    if not files:
        raise SystemExit("no %s files found under %s at depth %s"
                         % ("/".join(sorted(exts)), args.path, args.depth))

    root = Path(args.path).expanduser().resolve()
    root = root.parent if root.is_file() else root

    status, models = _call("GET", "/api/models")
    if status != 200:
        raise SystemExit("could not list printer models: HTTP %s" % status)
    overrides = dict(kv.split("=", 1) for kv in args.map.split(",") if "=" in kv)

    printers = [x.strip() for x in args.printers.split(",") if x.strip()]
    plan = material_plan(args.material, printers)
    profiles, BS, orca_hint = load_profiles(plan)
    registered = {m["model_id"] for m in models}
    model_for = {}
    for p in profiles:
        base = p.key.split("-", 1)[0].lower()
        model_id = resolve_model_id(p.key, models, overrides, BS._is_bambu_profile(p)) if base in overrides else p.printer_model_id
        if model_id not in registered:
            raise SystemExit("profile %s refers to unregistered Print Garden model %s" % (p.key, model_id))
        model_for[p.key] = model_id

    # Settle the destination BEFORE slicing. Slicing a folder can take many
    # minutes, and discovering the name collision afterwards throws all of it
    # away. The project is still only *created* once every plate exists.
    target = None
    if args.project_id:
        st, target = _call("GET", "/api/projects/%s" % args.project_id)
        if st != 200:
            raise SystemExit("no project with id %s" % args.project_id)
    else:
        st, existing = _call("GET", "/api/projects")
        dupe = [p for p in (existing or []) if p["name"] == args.project]
        if dupe and not args.reuse_project:
            raise SystemExit(
                "project %r already exists (id %s). Use --reuse-project to add "
                "to it, --project-id %s, or pick another name."
                % (args.project, dupe[0]["id"], dupe[0]["id"]))
        if dupe:
            target = dupe[0]

    print("%d file(s), %d profile(s): %s"
          % (len(files), len(profiles),
             ", ".join("%s->%s" % (k, v) for k, v in sorted(model_for.items()))))
    for f in files:
        print("  %s" % f.relative_to(root))
    print("destination: %s" % ("project %s (%s)" % (target["id"], target["name"])
                               if target else "new project %r" % args.project))
    if args.dry_run:
        print("\n--dry-run: nothing sliced or uploaded")
        return 0

    work = tempfile.mkdtemp(prefix="pg-add-")
    try:
        print("\nslicing...")
        sliced = slice_all(files, profiles, BS, orca_hint, work, not args.no_arrange)

        # Only reach the API once every plate is on disk - a half-loaded
        # project is worse than none, because the scheduler can dispatch the
        # half that made it while the operator assumes the whole part is there.
        failures = [(f, k, d) for f, per in sliced.items()
                    for k, (a, d) in per.items() if a is None]
        if failures and not args.partial:
            for f, k, d in failures:
                print("  FAIL %-10s %s: %s" % (k, f.name, d))
            raise SystemExit("\n%d slice(s) failed; nothing uploaded. "
                             "Re-run with --partial to load the rest anyway."
                             % len(failures))

        proj = target
        if proj is None:
            st, proj = _call("POST", "/api/projects",
                             {"name": args.project, "description": args.description})
            if st != 201:
                raise SystemExit("could not create project: HTTP %s %s" % (st, proj))
        print("\nproject %s: %s" % (proj["id"], proj["name"]))

        # Loading into an existing project is the re-run case: the same folder
        # with a file or two added. Parts are not unique by name, so without
        # this every re-run would quietly double the part list.
        seen = set()
        if target is not None and not args.allow_duplicate_parts:
            st, allparts = _call("GET", "/api/parts")
            seen = {p["name"] for p in (allparts or [])
                    if p.get("project_id") == proj["id"]}

        rows, problems, skipped = [], [], []
        for f in files:
            # Relative path keeps nested files from colliding on name alone.
            part_name = str(f.relative_to(root).with_suffix(""))
            if part_name in seen:
                skipped.append(part_name)
                continue
            st, part = _call("POST", "/api/parts",
                             {"project_id": proj["id"], "name": part_name,
                              "target_qty": args.target_qty})
            if st != 201:
                problems.append("part %s: HTTP %s %s" % (part_name, st, part))
                continue
            for p in profiles:
                artifact, detail = sliced[f][p.key]
                if artifact is None:
                    problems.append("%s / %s: slice failed: %s" % (part_name, p.key, detail))
                    continue
                mat = profile_material(p.key)
                secs, grams = estimates(artifact, mat)
                named = Path(work) / ("%s_%s_%s%s" % (
                    f.stem, mat, p.key.split("-")[0].upper(),
                    ".gcode.3mf" if artifact.suffix.lower() == ".3mf" else ".gcode"))
                shutil.copyfile(artifact, named)
                st, rec = _upload(part["id"], model_for[p.key], named, {
                    "parts_per_plate": str(args.parts_per_plate),
                    "est_print_secs": str(secs) if secs else "",
                    "material_grams": str(grams) if grams else "",
                    "required_material": mat,
                    # Empty unless --color was given: an uncoloured plate can
                    # be dispatched to whatever is loaded, which is the point.
                    "required_color": args.color,
                })
                if st == 201:
                    rows.append((part_name, model_for[p.key], mat, named.name,
                                 secs, grams))
                else:
                    problems.append("%s / %s: HTTP %s %s"
                                    % (part_name, model_for[p.key], st,
                                       (rec or {}).get("error", rec)))

        print("\n%-26s %-6s %-5s %-34s %8s %7s"
              % ("PART", "MODEL", "MAT", "FILE", "TIME", "GRAMS"))
        for n, m, mt, fn, s, g in rows:
            print("%-26s %-6s %-5s %-34s %8s %7s"
                  % (n[:26], m, mt, fn[:34],
                     ("%dm%02ds" % (s // 60, s % 60)) if s else "-",
                     ("%.2f" % g) if g else "-"))
        print("\n%d G-code(s) loaded into project %s" % (len(rows), proj["id"]))

        # Active is the default because dispatch is gated at the printer, not
        # here: this farm's operator marks each printer ready by hand, so an
        # active project is a queue of work offered to printers that are not
        # yet asking for it. A part that failed to load is the one case where
        # that is not safe - the scheduler would dispatch the half that made
        # it while the part list says the whole thing is there.
        if problems:
            print("NOT activated: not every plate loaded (see below). Fix the "
                  "problems and re-run, or activate it by hand once you have "
                  "read them.")
        elif args.draft:
            print("project left in draft on request. To make it dispatchable:\n"
                  "  curl -X PUT %s/api/projects/%s -H 'Content-Type: "
                  "application/json' -d '{\"status\":\"active\"}'"
                  % (API, proj["id"]))
        else:
            st, _ = _call("PUT", "/api/projects/%s" % proj["id"],
                          {"status": "active"})
            print("project %s is active%s" % (
                proj["id"],
                "" if st == 200 else " -- FAILED to activate: HTTP %s" % st))
        if skipped:
            print("skipped %d part(s) already in this project: %s"
                  % (len(skipped), ", ".join(skipped)))
        if problems:
            print("\n%d problem(s):" % len(problems))
            for p in problems:
                print("  %s" % p)
        return 1 if problems else 0
    finally:
        if args.keep:
            print("\nworking files kept in %s" % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


# --- cli --------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="report what would be processed (JSON)")
    s.add_argument("path")
    s.add_argument("--ext", default=".stl")

    sub.add_parser("models", help="list Print Garden printer model IDs")

    a = sub.add_parser("add", help="slice and load into Print Garden")
    a.add_argument("path")
    a.add_argument("--project", help="new project name")
    a.add_argument("--project-id", type=int, help="load into an existing project")
    a.add_argument("--reuse-project", action="store_true",
                   help="add to an existing project of the same name")
    a.add_argument("--description", default="")
    a.add_argument("--depth", type=int, default=0,
                   help="0=this folder only, 1=one level down, -1=unlimited")
    a.add_argument("--ext", default=".stl")
    a.add_argument("--material", default="p1s=PLA,sv08=PETG",
                   help="per printer (p1s=PLA,sv08=PETG) or one material for "
                        "all of them (PETG). Print Garden allows one plate per "
                        "part per printer model, so two materials means two "
                        "printers")
    a.add_argument("--color", default="",
                   help="restrict dispatch to one colour; colour agnostic "
                        "by default, which is nearly always what you want")
    a.add_argument("--draft", action="store_true",
                   help="leave the project in draft instead of activating it")
    a.add_argument("--printers", default="p1s,sv08",
                   help="profile key prefixes, comma separated")
    a.add_argument("--map", default="",
                   help="profile->model overrides, e.g. sv08=sv")
    a.add_argument("--target-qty", type=int, default=1)
    a.add_argument("--parts-per-plate", type=int, default=1)
    a.add_argument("--no-arrange", action="store_true")
    a.add_argument("--allow-duplicate-parts", action="store_true",
                   help="re-add parts whose name is already in the project")
    a.add_argument("--partial", action="store_true",
                   help="upload what sliced even if some files failed")
    a.add_argument("--keep", action="store_true", help="keep the temp workdir")
    a.add_argument("--dry-run", action="store_true")

    args = ap.parse_args()
    if args.cmd == "scan":
        exts = {e if e.startswith(".") else "." + e for e in args.ext.lower().split(",")}
        print(json.dumps(scan(args.path, exts), indent=2))
        return 0
    if args.cmd == "models":
        st, models = _call("GET", "/api/models")
        if st != 200:
            raise SystemExit("HTTP %s from %s/api/models" % (st, API))
        for m in models:
            print("%-8s %-14s %s" % (m["model_id"], m.get("label", ""), m.get("connector", "")))
        return 0
    if not args.project and not args.project_id:
        raise SystemExit("add needs --project NAME (or --project-id N)")
    return cmd_add(args)


if __name__ == "__main__":
    sys.exit(main())
