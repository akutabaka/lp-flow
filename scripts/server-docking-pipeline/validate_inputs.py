#!/usr/bin/env python3
"""Validate a docking task folder and emit JSON metadata.

This script intentionally uses only the Python standard library. It does not
prepare chemistry; it classifies files and creates safe working IDs.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


RECEPTOR_EXTS = {".pdb", ".cif"}
LIGAND_EXTS = {".sdf", ".mol2", ".pdb", ".smi", ".smiles"}
AUX_NAMES = {".mtz"}
GENERATED_DIR_NAMES = {
    "results",
    "prepared",
    "gnina",
    "gnina_top3",
    "smina",
    "boltz",
    "matcha",
    "molstar",
    "pymol",
    "logs",
}


def sanitize_id(value: str, prefix: str, viewer: bool = False) -> str:
    value = value.strip()
    if viewer:
        safe = re.sub(r"[^A-Za-z0-9_]+", "_", value)
        safe = re.sub(r"_+", "_", safe).strip("_")
    else:
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", value)
        safe = re.sub(r"_+", "_", safe).strip("_")
    if not safe or safe[0] in ".-":
        safe = f"{prefix}_{safe}".rstrip("_")
    return safe


def unique_id(base: str, used: set[str]) -> str:
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}_{index}"
        index += 1
    used.add(candidate)
    return candidate


def is_auxiliary(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith("-sf.cif"):
        return True
    if path.suffix.lower() in AUX_NAMES:
        return True
    return False


def classify(task_dir: Path) -> dict:
    if not task_dir.exists() or not task_dir.is_dir():
        raise SystemExit(f"Task folder does not exist or is not a directory: {task_dir}")

    receptor_candidates: list[Path] = []
    ligand_candidates: list[Path] = []
    ignored_auxiliary: list[Path] = []
    ignored_generated: list[Path] = []

    for path in sorted(task_dir.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = {part.lower() for part in path.relative_to(task_dir).parts}
        if rel_parts & GENERATED_DIR_NAMES:
            ignored_generated.append(path)
            continue
        suffix = path.suffix.lower()
        if is_auxiliary(path):
            ignored_auxiliary.append(path)
            continue
        if suffix in RECEPTOR_EXTS:
            receptor_candidates.append(path)
        if suffix in LIGAND_EXTS:
            ligand_candidates.append(path)

    # A PDB can be receptor or ligand. Keep ambiguity explicit.
    receptor_only = [p for p in receptor_candidates if p.suffix.lower() == ".cif" or "lig" not in p.stem.lower()]
    if len(receptor_candidates) == 1:
        receptor = receptor_candidates[0]
    elif len(receptor_only) == 1:
        receptor = receptor_only[0]
    else:
        receptor = None

    ligands = []
    used_working: set[str] = set()
    used_viewer: set[str] = set()
    for path in ligand_candidates:
        if receptor is not None and path.resolve() == receptor.resolve():
            continue
        original = path.stem
        working = unique_id(sanitize_id(original, "lig", viewer=False), used_working)
        viewer = unique_id(sanitize_id(working, "lig", viewer=True), used_viewer)
        item = {
            "input_path": str(path),
            "relative_path": str(path.relative_to(task_dir)),
            "original_id": original,
            "working_id": working,
            "viewer_id": viewer,
            "pymol_id": viewer,
            "format": path.suffix.lower().lstrip("."),
            "size_bytes": path.stat().st_size,
        }
        if item["size_bytes"] == 0:
            item["status"] = "failed"
            item["error"] = "empty ligand file"
        else:
            item["status"] = "ok"
            item["error"] = ""
        ligands.append(item)

    warnings: list[str] = []
    errors: list[str] = []
    if receptor is None:
        errors.append("Expected exactly one unambiguous receptor candidate.")
    if not ligands:
        errors.append("No ligand candidates found.")
    if len(receptor_candidates) > 1:
        warnings.append("Multiple receptor-like files found; receptor selection may require user confirmation.")

    case_original = task_dir.name
    case_working = sanitize_id(case_original, "case", viewer=False)
    case_viewer = sanitize_id(case_working, "case", viewer=True)
    metadata = {
        "task_dir": str(task_dir),
        "case_original": case_original,
        "case_working_id": case_working,
        "case_viewer_id": case_viewer,
        "case_pymol_id": case_viewer,
        "receptor": None
        if receptor is None
        else {
            "input_path": str(receptor),
            "relative_path": str(receptor.relative_to(task_dir)),
            "original_id": receptor.stem,
            "working_id": sanitize_id(receptor.stem, "receptor", viewer=False),
            "viewer_id": sanitize_id(receptor.stem, "receptor", viewer=True),
            "pymol_id": sanitize_id(receptor.stem, "receptor", viewer=True),
            "format": receptor.suffix.lower().lstrip("."),
            "size_bytes": receptor.stat().st_size,
        },
        "ligands": ligands,
        "ignored_auxiliary": [str(p.relative_to(task_dir)) for p in ignored_auxiliary],
        "ignored_generated": [str(p.relative_to(task_dir)) for p in ignored_generated],
        "warnings": warnings,
        "errors": errors,
        "ok": not errors,
    }
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_dir", type=Path)
    parser.add_argument("--out", type=Path, help="Optional JSON output path.")
    args = parser.parse_args()

    metadata = classify(args.task_dir.resolve())
    text = json.dumps(metadata, indent=2, ensure_ascii=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0 if metadata["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
