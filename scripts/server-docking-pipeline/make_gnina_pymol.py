#!/usr/bin/env python3
"""Generate a PyMOL PML file for receptor plus GNINA top poses."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


COLORS = ["yellow", "magenta", "tv_blue", "salmon", "violet", "marine", "lime", "wheat"]


def pymol_path(path: Path) -> str:
    value = str(path.resolve()).replace("\\", "/")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def pymol_id(value: str, prefix: str = "obj") -> str:
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    if not safe or not re.match(r"^[A-Za-z_]", safe):
        safe = f"{prefix}_{safe}".rstrip("_")
    return safe


def add_initial_scene(lines: list[str], receptor: Path, reference: Path | None) -> None:
    lines.extend(
        [
            "reinitialize",
            f"load {pymol_path(receptor)}, receptor",
            "hide everything",
            "show cartoon, receptor and polymer",
            "color gray80, receptor and polymer",
            "show sticks, receptor and organic",
            "show sticks, receptor and inorganic",
            "color orange, receptor and organic",
            "set stick_radius, 0.18",
            "set cartoon_transparency, 0.15",
            "set ray_opaque_background, off",
            "bg_color white",
        ]
    )
    if reference:
        lines.extend(
            [
                f"load {pymol_path(reference)}, reference_ligand",
                "show sticks, reference_ligand",
                "color limegreen, reference_ligand",
                "select pocket, byres (receptor and polymer within 5 of reference_ligand)",
                "show sticks, pocket",
                "color cyan, pocket",
            ]
        )


def add_ligand(lines: list[str], ligand_id: str, sdf: Path, top_n: int, color: str) -> None:
    base = pymol_id(f"{ligand_id}_gnina_all", "lig")
    group = pymol_id(ligand_id, "lig")
    lines.append(f"load {pymol_path(sdf)}, {base}")
    lines.append(f"split_states {base}")
    lines.append(f"delete {base}")
    for index in range(1, 11):
        old = f"{base}_{index:04d}"
        if index <= top_n:
            new = pymol_id(f"{ligand_id}_pose{index}", "lig")
            lines.extend(
                [
                    f"set_name {old}, {new}",
                    f"show sticks, {new}",
                    f"color {color}, {new}",
                ]
            )
        else:
            lines.append(f"delete {old}")
    members = " ".join(pymol_id(f"{ligand_id}_pose{index}", "lig") for index in range(1, top_n + 1))
    lines.append(f"group {group}, {members}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receptor", required=True, type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--gnina", action="append", required=True, help="Format: ligand_id=path/to/file.sdf")
    parser.add_argument("--out-pml", required=True, type=Path)
    parser.add_argument("--out-pse", type=Path)
    parser.add_argument("--out-png", type=Path)
    parser.add_argument("--top-n", type=int, default=3)
    parser.add_argument("--zoom", default="reference_ligand")
    args = parser.parse_args()

    if args.top_n < 1 or args.top_n > 10:
        raise SystemExit("--top-n must be between 1 and 10")

    lines: list[str] = []
    add_initial_scene(lines, args.receptor, args.reference)

    for index, item in enumerate(args.gnina):
        if "=" not in item:
            raise SystemExit(f"Invalid --gnina value, expected ligand_id=path: {item}")
        ligand_id, filename = item.split("=", 1)
        add_ligand(lines, ligand_id, Path(filename), args.top_n, COLORS[index % len(COLORS)])

    if args.reference:
        lines.append(f"zoom {args.zoom}, 12")
    else:
        lines.append("zoom receptor, 20")
    if args.out_pse:
        lines.append(f"save {pymol_path(args.out_pse)}")
    if args.out_png:
        lines.append(f"png {pymol_path(args.out_png)}, width=1600, height=1200, dpi=200, ray=1")

    args.out_pml.parent.mkdir(parents=True, exist_ok=True)
    args.out_pml.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
