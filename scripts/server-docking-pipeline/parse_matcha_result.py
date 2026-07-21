#!/usr/bin/env python3
"""Parse one Matcha best-pose SDF and timing JSON into build_summary_wide input."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


PROPERTY_ALIASES = {
    "minimizedAffinity": ("minimizedAffinity", "Affinity"),
    "minimizedCNNscore": ("minimizedCNNscore", "CNNscore"),
    "minimizedCNNaffinity": ("minimizedCNNaffinity", "CNNaffinity"),
}


def first_molecule_block(text: str) -> str:
    return text.split("$$$$", 1)[0]


def parse_sdf_properties(path: Path) -> dict[str, str]:
    if not path.exists() or not path.is_file():
        raise SystemExit(f"best_sdf does not exist: {path}")
    block = first_molecule_block(path.read_text(encoding="utf-8", errors="replace"))
    lines = block.splitlines()
    props: dict[str, str] = {}
    index = 0
    while index < len(lines):
        match = re.match(r"^>\s*<([^>]+)>", lines[index])
        if not match:
            index += 1
            continue
        key = match.group(1).strip()
        index += 1
        values: list[str] = []
        while index < len(lines):
            line = lines[index]
            if re.match(r"^>\s*<([^>]+)>", line):
                break
            if not line.strip():
                index += 1
                break
            values.append(line.strip())
            index += 1
        props[key] = " ".join(values).strip()
    return props


def find_key(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for child in value.values():
            found = find_key(child, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_key(child, key)
            if found is not None:
                return found
    return None


def parse_timing(path: Path | None) -> str:
    if not path or not str(path) or not path.exists() or not path.is_file():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    value = find_key(data, "total_sec")
    return "" if value is None else str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ligand-id", required=True)
    parser.add_argument("--best-sdf", required=True, type=Path)
    parser.add_argument("--timing-json", default="", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    props = parse_sdf_properties(args.best_sdf)
    values: dict[str, str] = {}
    for output_key, aliases in PROPERTY_ALIASES.items():
        for source_key in aliases:
            value = props.get(source_key, "").strip()
            if value:
                values[output_key] = value
                break
    timing = parse_timing(args.timing_json)
    if timing:
        values["total_sec"] = timing

    if not values:
        raise SystemExit("No Matcha metrics found in best SDF or timing JSON")

    payload = ",".join(f"{key}={value}" for key, value in values.items())
    line = f"{args.ligand_id}:{payload}"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(line + "\n", encoding="utf-8")
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
