#!/usr/bin/env python3
"""Place an ACPYPE ligand conformer into a validated docked-pose frame.

The topology input and the pose must have the same heavy-atom order and graph.
The transformation is rigid: it preserves the parameterized ligand geometry and
uses the pose only for placement.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def read_sdf(path: Path):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) < 4:
        raise ValueError(f"SDF_PARSE_ERROR too few lines: {path}")
    try:
        atom_count = int(lines[3][0:3])
        bond_count = int(lines[3][3:6])
    except ValueError as exc:
        raise ValueError(f"SDF_PARSE_ERROR invalid counts line: {path}") from exc
    atoms = []
    for line in lines[4 : 4 + atom_count]:
        fields = line.split()
        if len(fields) < 4:
            raise ValueError(f"SDF_PARSE_ERROR invalid atom line: {path}")
        atoms.append((fields[3], tuple(float(value) for value in fields[0:3])))
    bonds = set()
    for line in lines[4 + atom_count : 4 + atom_count + bond_count]:
        fields = line.split()
        if len(fields) < 2:
            raise ValueError(f"SDF_PARSE_ERROR invalid bond line: {path}")
        a, b = sorted((int(fields[0]), int(fields[1])))
        bonds.add((a, b))
    return atoms, bonds


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def scale(a, factor):
    return tuple(x * factor for x in a)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    length = norm(a)
    if length < 1e-8:
        raise ValueError("PLACEMENT_ERROR degenerate heavy-atom anchor")
    return scale(a, 1.0 / length)


def basis(a, b, c):
    first = unit(sub(b, a))
    second_raw = sub(sub(c, a), scale(first, dot(sub(c, a), first)))
    second = unit(second_raw)
    return first, second, cross(first, second)


def choose_anchor(points):
    for i in range(len(points) - 2):
        for j in range(i + 1, len(points) - 1):
            for k in range(j + 1, len(points)):
                try:
                    basis(points[i], points[j], points[k])
                    return i, j, k
                except ValueError:
                    continue
    raise ValueError("PLACEMENT_ERROR no non-collinear heavy-atom anchor")


def rotate(vector, source_basis, target_basis):
    components = [dot(vector, axis) for axis in source_basis]
    return tuple(
        sum(components[column] * target_basis[column][row] for column in range(3))
        for row in range(3)
    )


def element_from_gro_name(name):
    letters = "".join(char for char in name if char.isalpha())
    if not letters:
        return ""
    return letters[0].upper() + letters[1:].lower()


def parse_gro(path: Path):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) < 3:
        raise ValueError(f"GRO_PARSE_ERROR too few lines: {path}")
    try:
        count = int(lines[1].strip())
    except ValueError as exc:
        raise ValueError(f"GRO_PARSE_ERROR invalid atom count: {path}") from exc
    if len(lines) < count + 3:
        raise ValueError(f"GRO_PARSE_ERROR truncated atom block: {path}")
    return lines, count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chemistry", type=Path, required=True)
    parser.add_argument("--pose", type=Path, required=True)
    parser.add_argument("--gro", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    chemistry_atoms, chemistry_bonds = read_sdf(args.chemistry)
    pose_atoms, pose_bonds = read_sdf(args.pose)
    if len(chemistry_atoms) != len(pose_atoms):
        raise SystemExit(
            f"PLACEMENT_INPUT_MISMATCH heavy_atom_count chemistry={len(chemistry_atoms)} pose={len(pose_atoms)}"
        )
    if [atom[0] for atom in chemistry_atoms] != [atom[0] for atom in pose_atoms]:
        raise SystemExit("PLACEMENT_INPUT_MISMATCH heavy_atom_elements_or_order")
    if chemistry_bonds != pose_bonds:
        raise SystemExit("PLACEMENT_INPUT_MISMATCH heavy_atom_connectivity")

    lines, gro_count = parse_gro(args.gro)
    heavy_count = len(chemistry_atoms)
    if gro_count < heavy_count:
        raise SystemExit(f"PLACEMENT_INPUT_MISMATCH gro_atoms={gro_count} heavy_atoms={heavy_count}")

    for index, (element, _) in enumerate(chemistry_atoms):
        gro_name = lines[2 + index][10:15].strip()
        if element_from_gro_name(gro_name) != element:
            raise SystemExit(
                f"PLACEMENT_INPUT_MISMATCH gro_atom_{index + 1}={gro_name} expected_element={element}"
            )

    source_points = [coords for _, coords in chemistry_atoms]
    target_points = [coords for _, coords in pose_atoms]
    anchor = choose_anchor(source_points)
    source_basis = basis(*(source_points[item] for item in anchor))
    target_basis = basis(*(target_points[item] for item in anchor))
    source_origin = source_points[anchor[0]]
    target_origin = target_points[anchor[0]]

    placed_lines = lines[:2]
    for line in lines[2 : 2 + gro_count]:
        coords_a = tuple(float(line[start:end]) * 10.0 for start, end in ((20, 28), (28, 36), (36, 44)))
        placed_a = add(target_origin, rotate(sub(coords_a, source_origin), source_basis, target_basis))
        placed_lines.append(f"{line[:20]}{placed_a[0] / 10:8.3f}{placed_a[1] / 10:8.3f}{placed_a[2] / 10:8.3f}{line[44:]}")
    placed_lines.extend(lines[2 + gro_count :])
    args.out.write_text("\n".join(placed_lines) + "\n", encoding="utf-8")

    placed_heavy = [
        tuple(float(placed_lines[2 + index][start:end]) * 10.0 for start, end in ((20, 28), (28, 36), (36, 44)))
        for index in range(heavy_count)
    ]
    rmsd = math.sqrt(
        sum(dot(sub(actual, target), sub(actual, target)) for actual, target in zip(placed_heavy, target_points))
        / heavy_count
    )
    args.report.write_text(
        json.dumps(
            {
                "status": "ok",
                "method": "rigid_transform_from_validated_heavy_atom_graph",
                "heavy_atoms": heavy_count,
                "anchor_atom_indices": [item + 1 for item in anchor],
                "heavy_atom_rmsd_to_pose_a": round(rmsd, 4),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
