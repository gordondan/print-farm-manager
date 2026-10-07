"""Versioned project-bundle archive writer shared with Print Farm Manager."""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any, Iterable
import zipfile


SCHEMA_VERSION = 1
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True)
class BundleSlice:
    profile_key: str
    printer_model: str
    source: Path
    parts_per_plate: int
    est_print_secs: int | None = None
    material_grams: float | None = None


@dataclass(frozen=True)
class BundleFailure:
    """One unsuccessful slice attempt retained in a project bundle manifest."""

    profile_key: str
    printer_model: str
    detail: str
    cancelled: bool = False


@dataclass(frozen=True)
class BundlePart:
    name: str
    source: Path
    slices: list[BundleSlice] = field(default_factory=list)
    failures: list[BundleFailure] = field(default_factory=list)


def safe_part_id(source_relpath: str) -> str:
    """Return a stable archive-safe ID for a source path."""
    stem = Path(source_relpath).stem.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", stem).strip("-") or "part"
    digest = sha256(source_relpath.encode("utf-8")).hexdigest()[:12]
    return f"{slug[:48]}-{digest}"


def write_bundle(
    path: Path | str,
    project_name: str,
    source_root: Path | str,
    parts: Iterable[BundlePart],
    profiles: Iterable[dict[str, Any]],
) -> None:
    """Write originals, slices, and a deterministic manifest to a ZIP archive."""
    root = Path(source_root).resolve()
    bundle_parts = list(parts)
    records: list[tuple[BundlePart, str, str]] = []
    for part in bundle_parts:
        source = Path(part.source).resolve()
        try:
            relpath = source.relative_to(root).as_posix()
        except ValueError as exc:
            raise ValueError(f"part source must be inside source_root: {part.source}") from exc
        if not source.is_file():
            raise ValueError(f"part source does not exist: {part.source}")
        records.append((part, relpath, safe_part_id(relpath)))

    records.sort(key=lambda item: item[1])
    ids = [part_id for _, _, part_id in records]
    if len(ids) != len(set(ids)):
        raise ValueError("each part source path must be unique")

    manifest_parts = []
    archive_members: list[tuple[Path, str]] = []
    for part, relpath, part_id in records:
        slices = []
        failures = []
        archive_members.append((Path(part.source), f"originals/{relpath}"))
        profile_keys: set[str] = set()
        slice_archive_paths: set[str] = set()
        for slice_ in sorted(part.slices, key=lambda item: (item.profile_key, str(item.source))):
            if not _SAFE_COMPONENT.fullmatch(slice_.profile_key):
                raise ValueError(f"unsafe profile key: {slice_.profile_key}")
            if slice_.profile_key in profile_keys:
                raise ValueError(f"duplicate profile key for part {part_id}: {slice_.profile_key}")
            source = Path(slice_.source)
            if not source.is_file():
                raise ValueError(f"slice source does not exist: {source}")
            extension = source.suffix.lower()
            if not extension:
                raise ValueError(f"slice source needs an extension: {source}")
            archive_path = f"slices/{slice_.profile_key}/{part_id}{extension}"
            if archive_path in slice_archive_paths:
                raise ValueError(f"duplicate slice archive path: {archive_path}")
            profile_keys.add(slice_.profile_key)
            slice_archive_paths.add(archive_path)
            slices.append({
                "profile_key": slice_.profile_key,
                "printer_model": slice_.printer_model,
                "filename": source.name,
                "archive_path": archive_path,
                "parts_per_plate": slice_.parts_per_plate,
                "est_print_secs": slice_.est_print_secs,
                "material_grams": slice_.material_grams,
            })
            archive_members.append((source, archive_path))
        for failure in sorted(part.failures, key=lambda item: item.profile_key):
            if not _SAFE_COMPONENT.fullmatch(failure.profile_key):
                raise ValueError(f"unsafe profile key: {failure.profile_key}")
            if failure.profile_key in profile_keys:
                raise ValueError(f"duplicate profile key for part {part_id}: {failure.profile_key}")
            profile_keys.add(failure.profile_key)
            failures.append({
                "profile_key": failure.profile_key,
                "printer_model": failure.printer_model,
                "detail": failure.detail,
                "cancelled": failure.cancelled,
            })
        manifest_parts.append({
            "id": part_id,
            "name": part.name,
            "source_relpath": relpath,
            "slices": slices,
            "failures": failures,
        })

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "project_name": project_name,
        "source_root": root.name,
        "parts": manifest_parts,
        "profiles": sorted(profiles, key=lambda profile: str(profile.get("key", ""))),
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest_bytes)
        for source, archive_path in archive_members:
            archive.write(source, archive_path)
