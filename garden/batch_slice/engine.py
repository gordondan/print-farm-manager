#!/usr/bin/env python3
"""Batch-slice 3D models with OrcaSlicer.

This module contains the slicing engine used by the Batch Slicer desktop app.
It also keeps a command-line interface for people who still want to automate
the same workflow from a shell.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .project_bundle import BundleFailure, BundlePart, BundleSlice, safe_part_id, write_bundle


MODEL_EXTS = {".stl", ".3mf", ".obj", ".step", ".stp"}
FLATTENED_PRESET_DIR = (
    Path.home() / "Library" / "Application Support" / "Print Garden" / "presets"
)


@dataclass
class Profile:
    """One printer/process/filament preset combination."""

    key: str
    printer_model_id: str
    machine: Path
    process: Path
    filaments: list[Path] = field(default_factory=list)
    extra: list[str] = field(default_factory=list)


@dataclass
class SliceResult:
    """The result of one model/profile slice."""

    profile_key: str
    model: Path
    ok: bool
    detail: str
    command: list[str] = field(default_factory=list)
    cancelled: bool = False
    artifact: Path | None = None


@dataclass
class BatchSummary:
    """Aggregate result returned when a batch finishes."""

    models: list[Path]
    profiles: list[Profile]
    results: list[SliceResult]
    cancelled: bool = False

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def succeeded(self) -> int:
        return sum(1 for result in self.results if result.ok)

    @property
    def failed(self) -> int:
        return sum(1 for result in self.results if not result.ok and not result.cancelled)

    @property
    def cancelled_count(self) -> int:
        return sum(1 for result in self.results if result.cancelled)


class BatchConfigError(ValueError):
    """Raised when a batch cannot be started with the supplied settings."""


ProgressCallback = Callable[[str, object], None]


def default_profiles(presets: Path | None = None) -> list[Profile]:
    """Return the two profiles from the original script."""

    root = (presets or (Path.home() / "orca-presets")).expanduser()
    return [
        Profile(
            key="p1s",
            printer_model_id="p1s",
            machine=root / "machine" / "Bambu Lab P1S 0.4 nozzle.json",
            process=root / "process" / "0.20mm Standard @BBL P1S.json",
            filaments=[root / "filament" / "Bambu PLA Basic @BBL P1S.json"],
        ),
        Profile(
            key="sv08",
            printer_model_id="sv08",
            machine=root / "machine" / "Sovol SV08 0.4 nozzle.json",
            process=root / "process" / "0.20mm Standard @Sovol SV08.json",
            filaments=[root / "filament" / "Generic PLA @Sovol SV08.json"],
        ),
    ]


def _orca_binary(path: Path) -> Path | None:
    """Turn an Orca executable or .app bundle path into an executable path."""

    expanded = path.expanduser()
    if expanded.suffix.lower() == ".app":
        bundled = expanded / "Contents" / "MacOS" / "OrcaSlicer"
        if bundled.exists():
            return bundled
    if expanded.exists():
        return expanded
    return None


def resolve_orca(override: str | None = None) -> str | None:
    """Find OrcaSlicer, honoring an explicit path or command name first."""

    if override and override.strip():
        requested = override.strip()
        binary = _orca_binary(Path(requested))
        if binary:
            return str(binary)
        found = shutil.which(requested)
        return found

    candidates: Iterable[str] = (
        "orca-slicer",
        "orcaslicer",
        "OrcaSlicer",
        "/Applications/OrcaSlicer.app",
        str(Path.home() / "Applications" / "OrcaSlicer.app"),
        "/usr/local/bin/orca-slicer",
        "/opt/homebrew/bin/orca-slicer",
        "/usr/bin/orca-slicer",
    )
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
        binary = _orca_binary(Path(candidate))
        if binary:
            return str(binary)
    return None


def _flatten_machine_preset(machine: Path) -> Path:
    """Make inherited machine settings explicit for OrcaSlicer's CLI.

    The GUI resolves ``inherits`` entries, but the standalone macOS CLI does
    not when a machine preset is loaded by path.  In particular, Bambu P1S
    inherits its 250 mm height from the common machine preset and otherwise
    falls back to the CLI default of 100 mm.
    """

    machine = machine.expanduser()
    try:
        current = json.loads(machine.read_text())
    except (OSError, json.JSONDecodeError):
        return machine
    if not isinstance(current, dict) or not current.get("inherits"):
        return machine

    chain: list[Path] = []
    data = current
    path = machine
    while isinstance(data, dict):
        chain.append(path)
        parent_name = data.get("inherits")
        if not parent_name:
            break
        parent = path.parent / f"{parent_name}.json"
        if parent in chain or not parent.is_file():
            break
        try:
            data = json.loads(parent.read_text())
        except (OSError, json.JSONDecodeError):
            break
        path = parent

    if len(chain) < 2:
        return machine

    cache = FLATTENED_PRESET_DIR / f"{machine.stem} (flattened).json"
    try:
        if cache.is_file() and cache.stat().st_mtime_ns >= max(
            item.stat().st_mtime_ns for item in chain
        ):
            return cache
    except OSError:
        pass

    flattened: dict[str, object] = {}
    for item in reversed(chain):
        values = json.loads(item.read_text())
        if isinstance(values, dict):
            flattened.update(values)
    flattened.pop("inherits", None)
    FLATTENED_PRESET_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(flattened, indent=2) + "\n")
    return cache


def find_models(input_path: Path, recursive: bool = False) -> list[Path]:
    """Return supported model files from a folder, or a selected model file."""

    source = input_path.expanduser()
    if source.is_file():
        return [source] if source.suffix.lower() in MODEL_EXTS else []
    if not source.is_dir():
        return []
    globber = source.rglob if recursive else source.glob
    return sorted(
        item for item in globber("*") if item.is_file() and item.suffix.lower() in MODEL_EXTS
    )


def profile_errors(profiles: list[Profile]) -> list[str]:
    """Return human-readable profile validation errors."""

    errors: list[str] = []
    seen: set[str] = set()
    for profile in profiles:
        key = profile.key.strip()
        if not key:
            errors.append("A selected profile has an empty output-folder name.")
        elif Path(key).name != key or key in {".", ".."}:
            errors.append(f"{profile.key}: output-folder name must be a single folder name.")
        elif key in seen:
            errors.append(f"The profile key '{key}' is used more than once.")
        seen.add(key)
        if not profile.printer_model_id.strip():
            errors.append(f"{profile.key}: select a registered printer model.")
        for label, path in (
            ("machine preset", profile.machine),
            ("process preset", profile.process),
        ):
            if not path.expanduser().is_file():
                errors.append(f"{profile.key}: missing {label}: {path}")
        if not profile.filaments:
            errors.append(f"{profile.key}: add at least one filament preset.")
        for filament in profile.filaments:
            if not filament.expanduser().is_file():
                errors.append(f"{profile.key}: missing filament preset: {filament}")
    return errors


def build_cmd(
    orca: str,
    profile: Profile,
    model: Path,
    outdir: Path,
    arrange: bool,
) -> list[str]:
    """Build the OrcaSlicer command for one model/profile pair."""

    machine = _flatten_machine_preset(profile.machine)
    settings = ";".join(str(path.expanduser()) for path in (machine, profile.process))
    command = [orca, "--load-settings", settings]
    if profile.filaments:
        command += [
            "--load-filaments",
            ";".join(str(path.expanduser()) for path in profile.filaments),
        ]
    if arrange:
        command += ["--arrange", "1"]
    command += [
        "--slice",
        "0",
        "--outputdir",
        str(outdir.expanduser()),
        str(model.expanduser()),
    ]
    command += profile.extra
    return command


def _is_bambu_profile(profile: Profile) -> bool:
    """Return whether a profile targets a Bambu printer."""

    try:
        preset = json.loads(profile.machine.expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        preset = {}
    printer_model = preset.get("printer_model", "") if isinstance(preset, dict) else ""
    return "bambu" in str(printer_model).lower() or "bambu" in profile.machine.name.lower()


def _profile_printer_model(profile: Profile) -> str:
    """Return the configured printer model, falling back to the profile key."""

    try:
        preset = json.loads(profile.machine.expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        preset = {}
    if isinstance(preset, dict) and preset.get("printer_model"):
        return str(preset["printer_model"])
    return profile.key


def _profile_model_id(profile: Profile) -> str:
    """Return the stable printer model ID expected by bundle consumers."""
    return profile.printer_model_id.strip()


class _SliceRunner:
    """Run Orca processes while still allowing the UI's Stop button to work."""

    def __init__(self, stop_event: threading.Event) -> None:
        self.stop_event = stop_event

    def run(
        self,
        orca: str,
        profile: Profile,
        model: Path,
        outroot: Path,
        part_id: str,
        arrange: bool,
        dry_run: bool,
    ) -> SliceResult:
        outdir = outroot.expanduser() / profile.key / part_id
        command = build_cmd(orca, profile, model, outdir, arrange)
        artifact = outdir / ("plate_1.3mf" if _is_bambu_profile(profile) else "plate_1.gcode")
        if _is_bambu_profile(profile):
            model_index = command.index(str(model.expanduser()))
            command[model_index:model_index] = ["--export-3mf", artifact.name]

        if dry_run:
            return SliceResult(profile.key, model, True, format_command(command), command, artifact=artifact)

        if self.stop_event.is_set():
            return SliceResult(profile.key, model, False, "Cancelled", command, cancelled=True)

        try:
            outdir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return SliceResult(profile.key, model, False, f"Could not create output folder: {exc}", command)

        started = time.monotonic()
        process: subprocess.Popen[str] | None = None
        stdout = ""
        stderr = ""
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=0.35)
                    break
                except subprocess.TimeoutExpired:
                    if self.stop_event.is_set():
                        process.terminate()
                        try:
                            stdout, stderr = process.communicate(timeout=2)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            stdout, stderr = process.communicate()
                        return SliceResult(
                            profile.key,
                            model,
                            False,
                            "Cancelled",
                            command,
                            cancelled=True,
                        )
        except OSError as exc:
            return SliceResult(profile.key, model, False, f"Could not start OrcaSlicer: {exc}", command)

        elapsed = time.monotonic() - started
        return_code = process.returncode if process is not None else 1
        if return_code == 0:
            if artifact.is_file():
                return SliceResult(profile.key, model, True, f"{elapsed:.1f}s", command, artifact=artifact)
            return SliceResult(
                profile.key,
                model,
                False,
                f"OrcaSlicer completed but did not produce {artifact.name}.",
                command,
            )

        detail = (stderr or stdout).strip()
        if len(detail) > 400:
            detail = detail[-400:]
        if not detail:
            detail = f"OrcaSlicer exited with code {return_code}."
        return SliceResult(profile.key, model, False, detail, command)


def format_command(command: list[str]) -> str:
    """Render a command in a copyable shell-safe form."""

    return shlex.join(command)


def run_batch(
    input_path: Path,
    output_root: Path,
    profiles: list[Profile],
    orca: str,
    *,
    jobs: int = 1,
    arrange: bool = False,
    recursive: bool = False,
    dry_run: bool = False,
    stop_event: threading.Event | None = None,
    callback: ProgressCallback | None = None,
) -> BatchSummary:
    """Run every model against every selected profile."""

    stop_event = stop_event or threading.Event()
    models = find_models(input_path, recursive)
    if not models:
        raise BatchConfigError(f"No supported models found in {input_path}.")
    if not profiles:
        raise BatchConfigError("Select at least one printer profile.")
    profile_problems = profile_errors(profiles)
    if profile_problems:
        raise BatchConfigError("Profile setup needs attention:\n" + "\n".join(profile_problems))
    if not orca:
        raise BatchConfigError("Could not find OrcaSlicer. Choose its application or executable first.")

    jobs = max(1, int(jobs))
    source_root = input_path.expanduser().parent if input_path.expanduser().is_file() else input_path.expanduser()
    work: list[tuple[Profile, Path, str]] = [
        (profile, model, safe_part_id(model.relative_to(source_root).as_posix()))
        for model in models
        for profile in profiles
    ]
    if callback:
        callback(
            "plan",
            {
                "models": models,
                "profiles": profiles,
                "total": len(work),
                "jobs": jobs,
            },
        )

    runner = _SliceRunner(stop_event)
    results: list[SliceResult] = []

    def execute(profile: Profile, model: Path, part_id: str) -> SliceResult:
        if callback:
            callback("started", {"profile": profile, "model": model})
        return runner.run(orca, profile, model, output_root, part_id, arrange, dry_run)

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        pending = {
            pool.submit(execute, profile, model, part_id): (profile, model, part_id)
            for profile, model, part_id in work
        }
        for future in concurrent.futures.as_completed(pending):
            profile, model, part_id = pending[future]
            try:
                result = future.result()
            except Exception as exc:  # Keep one unexpected job from hiding the rest of the batch.
                result = SliceResult(
                    profile.key,
                    model,
                    False,
                    f"Unexpected error: {exc}",
                    build_cmd(orca, profile, model, output_root / profile.key / part_id, arrange),
                )
            results.append(result)
            if callback:
                callback("result", result)

    return BatchSummary(models, profiles, results, cancelled=stop_event.is_set())


def export_project_bundle(
    input_path: Path,
    output_bundle: Path,
    project_name: str,
    profiles: list[Profile],
    orca: str,
    jobs: int,
    arrange: bool,
    recursive: bool,
    *,
    stop_event: threading.Event | None = None,
    callback: ProgressCallback | None = None,
) -> BatchSummary:
    """Slice models and package originals plus every successful slice in a bundle."""

    bundle_path = output_bundle.expanduser()
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    source_root = input_path.expanduser().parent if input_path.expanduser().is_file() else input_path.expanduser()
    with tempfile.TemporaryDirectory(prefix="batch-slicer-", dir=bundle_path.parent) as temp:
        summary = run_batch(
            input_path,
            Path(temp),
            profiles,
            orca,
            jobs=jobs,
            arrange=arrange,
            recursive=recursive,
            stop_event=stop_event,
            callback=callback,
        )
        slices_by_model: dict[Path, list[BundleSlice]] = {model: [] for model in summary.models}
        failures_by_model: dict[Path, list[BundleFailure]] = {model: [] for model in summary.models}
        profiles_by_key = {profile.key: profile for profile in profiles}
        for result in summary.results:
            profile = profiles_by_key[result.profile_key]
            if not result.ok:
                failures_by_model[result.model].append(
                    BundleFailure(
                        result.profile_key,
                        _profile_model_id(profile),
                        result.detail,
                        cancelled=result.cancelled,
                    )
                )
                continue
            if result.artifact is None:
                continue
            slices_by_model[result.model].append(
                BundleSlice(
                    result.profile_key,
                    _profile_model_id(profile),
                    result.artifact,
                    parts_per_plate=1,
                )
            )
        write_bundle(
            bundle_path,
            project_name,
            source_root,
            [
                BundlePart(model.stem, model, slices_by_model[model], failures_by_model[model])
                for model in summary.models
            ],
            [
                {"key": profile.key, "printer_model": _profile_model_id(profile)}
                for profile in profiles
            ],
        )
    return summary


def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Batch-slice a folder of models with OrcaSlicer, once per printer profile.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("input", type=Path, help="folder of models (or a single file)")
    parser.add_argument("-o", "--output", type=Path, default=Path("./gcode"))
    parser.add_argument("--presets", type=Path, default=Path.home() / "orca-presets")
    parser.add_argument("--only", action="append", metavar="KEY")
    parser.add_argument("--jobs", type=int, default=1, help="parallel slices")
    parser.add_argument("--arrange", action="store_true", help="let Orca arrange the plate")
    parser.add_argument("--recursive", action="store_true")
    parser.add_argument("--orca", help="explicit path to the Orca executable or .app")
    parser.add_argument("--dry-run", action="store_true", help="print commands only")
    args = parser.parse_args()

    profiles = default_profiles(args.presets)
    if args.only:
        profiles = [profile for profile in profiles if profile.key in args.only]
    orca = resolve_orca(args.orca)
    if not orca:
        print("Could not find OrcaSlicer. Pass --orca /path/to/OrcaSlicer.app.", file=sys.stderr)
        return 2

    def report(kind: str, payload: object) -> None:
        if kind == "plan":
            data = payload  # type: ignore[assignment]
            print(
                f"{len(data['models'])} model(s) x {len(data['profiles'])} profile(s) = "
                f"{data['total']} slices"
            )
        elif kind == "result":
            result = payload
            mark = "ok " if result.ok else ("STOP" if result.cancelled else "FAIL")  # type: ignore[union-attr]
            print(f"[{mark}] {result.profile_key:<5} {result.model.name}  {result.detail}")  # type: ignore[union-attr]

    try:
        summary = run_batch(
            args.input,
            args.output,
            profiles,
            orca,
            jobs=args.jobs,
            arrange=args.arrange,
            recursive=args.recursive,
            dry_run=args.dry_run,
            callback=report,
        )
    except BatchConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if summary.cancelled:
        print("\nStopped.")
        return 1
    if summary.failed:
        print(f"\n{summary.failed} failed.")
        return 1
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
