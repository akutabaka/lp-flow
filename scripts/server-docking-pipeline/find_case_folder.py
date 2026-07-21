#!/usr/bin/env python3
"""Resolve a docking task folder from a folder, receptor path, PDB filename, or PDB ID."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


RECEPTOR_EXTS = {".pdb", ".cif"}
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


def default_search_roots() -> list[Path]:
    explicit = os.environ.get("LP_FLOW_DOCKING_ROOTS") or os.environ.get("LP_FLOW_DOCKING_ROOT")
    if explicit:
        return [Path(item) for item in explicit.split(os.pathsep) if item.strip()]
    return [Path.cwd()]


def is_auxiliary(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith("-sf.cif"):
        return True
    if path.suffix.lower() in {".mtz"}:
        return True
    return False


def has_generated_part(path: Path) -> bool:
    return any(part.lower() in GENERATED_DIR_NAMES for part in path.parts)


def normalize_query(value: str) -> tuple[str, str]:
    raw = value.strip().strip('"')
    path = Path(raw)
    stem = path.stem if path.suffix else raw
    filename = path.name if path.suffix else f"{raw}.pdb"
    return stem.lower(), filename.lower()


def find_matches(query: str, roots: list[Path]) -> list[dict]:
    query_stem, query_filename = normalize_query(query)
    matches: list[dict] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if has_generated_part(path.relative_to(root)) or is_auxiliary(path):
                continue
            if path.suffix.lower() not in RECEPTOR_EXTS:
                continue
            name = path.name.lower()
            stem = path.stem.lower()
            if name != query_filename and stem != query_stem:
                continue
            folder = path.parent.resolve()
            if folder in seen:
                continue
            seen.add(folder)
            matches.append(
                {
                    "task_folder": str(folder),
                    "receptor_file": str(path.resolve()),
                    "matched_name": path.name,
                }
            )
    return matches


def resolve(input_value: str, roots: list[Path]) -> dict:
    candidate = Path(input_value.strip().strip('"'))
    if candidate.exists():
        resolved = candidate.resolve()
        if resolved.is_dir():
            if has_generated_part(resolved):
                return {
                    "ok": False,
                    "mode": "generated_output_folder",
                    "task_folder": "",
                    "matches": [],
                    "errors": [f"Generated output folder cannot be used as a task folder: {resolved}"],
                }
            return {
                "ok": True,
                "mode": "explicit_folder",
                "task_folder": str(resolved),
                "matches": [{"task_folder": str(resolved), "receptor_file": ""}],
                "errors": [],
            }
        if (
            resolved.is_file()
            and resolved.suffix.lower() in RECEPTOR_EXTS
            and not is_auxiliary(resolved)
            and not has_generated_part(resolved)
        ):
            return {
                "ok": True,
                "mode": "receptor_file",
                "task_folder": str(resolved.parent),
                "matches": [{"task_folder": str(resolved.parent), "receptor_file": str(resolved)}],
                "errors": [],
            }
        return {
            "ok": False,
            "mode": "unsupported_existing_path",
            "task_folder": "",
            "matches": [],
            "errors": [f"Existing path is not a supported task folder or receptor file: {resolved}"],
        }

    matches = find_matches(input_value, roots)
    if len(matches) == 1:
        return {
            "ok": True,
            "mode": "pdb_query",
            "task_folder": matches[0]["task_folder"],
            "matches": matches,
            "errors": [],
        }
    if not matches:
        return {
            "ok": False,
            "mode": "pdb_query",
            "task_folder": "",
            "matches": [],
            "errors": ["No matching receptor file found in configured search roots."],
        }
    return {
        "ok": False,
        "mode": "ambiguous_pdb_query",
        "task_folder": "",
        "matches": matches,
        "errors": ["Multiple matching task folders found; user must choose one."],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Folder path, receptor path, PDB filename, or PDB ID.")
    parser.add_argument(
        "--root",
        action="append",
        type=Path,
        help="Search root for PDB filename/ID queries. Can be repeated.",
    )
    parser.add_argument("--out", type=Path, help="Optional JSON output path.")
    args = parser.parse_args()

    roots = args.root or default_search_roots()
    result = resolve(args.input, [root.resolve() for root in roots])
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
