#!/usr/bin/env python3
"""Generate a portable Mol* HTML viewer for docking review."""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


FORMAT_BY_SUFFIX = {
    ".pdb": "pdb",
    ".ent": "pdb",
    ".cif": "mmcif",
    ".mmcif": "mmcif",
    ".sdf": "sdf",
    ".mol2": "mol2",
}

EXT_BY_FORMAT = {
    "pdb": ".pdb",
    "mmcif": ".cif",
    "sdf": ".sdf",
    "mol2": ".mol2",
}


def safe_id(value: str, prefix: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    if not cleaned:
        cleaned = prefix
    if not re.match(r"^[A-Za-z_]", cleaned):
        cleaned = f"{prefix}_{cleaned}"
    return cleaned


def unique_id(base: str, used: set[str]) -> str:
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}_{index}"
        index += 1
    used.add(candidate)
    return candidate


def detect_format(path: Path, explicit: str | None = None) -> str:
    if explicit:
        return explicit.lower()
    suffix = path.suffix.lower()
    try:
        return FORMAT_BY_SUFFIX[suffix]
    except KeyError as exc:
        raise SystemExit(f"Unsupported structure format for {path}") from exc


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def trim_sdf(data: bytes, top_n: int) -> tuple[bytes, int, int]:
    text = decode_text(data)
    records = [record for record in text.split("$$$$") if record.strip()]
    total = len(records)
    if top_n > 0:
        records = records[:top_n]
    trimmed = "".join(record.rstrip() + "\n$$$$\n" for record in records)
    return trimmed.encode("utf-8"), total, len(records)


def trim_mol2(data: bytes, top_n: int) -> tuple[bytes, int, int]:
    text = decode_text(data)
    parts = [part for part in re.split(r"(?=@<TRIPOS>MOLECULE)", text) if part.strip()]
    total = len(parts)
    if top_n > 0:
        parts = parts[:top_n]
    trimmed = "\n".join(part.rstrip() for part in parts) + "\n"
    return trimmed.encode("utf-8"), total, len(parts)


def trim_pose_data(data: bytes, fmt: str, top_n: int) -> tuple[bytes, int | None, int | None]:
    if fmt == "sdf":
        return trim_sdf(data, top_n)
    if fmt == "mol2":
        return trim_mol2(data, top_n)
    return data, None, None


def sdf_records_text(data: bytes, top_n: int) -> tuple[list[str], int]:
    text = decode_text(data)
    records = [record for record in text.split("$$$$") if record.strip()]
    total = len(records)
    if top_n > 0:
        records = records[:top_n]
    return [record.rstrip() for record in records], total


def parse_sdf_record(record: str) -> tuple[list[dict], list[tuple[int, int, int]]]:
    lines = record.splitlines()
    counts_index = next(
        (
            index
            for index, line in enumerate(lines)
            if re.search(r"\bV(2000|3000)\b", line, re.I) and re.match(r"^\s*\d+\s+\d+", line)
        ),
        3 if len(lines) > 3 else -1,
    )
    if counts_index < 0 or counts_index >= len(lines):
        return [], []
    counts = lines[counts_index]
    try:
        atom_count = int(counts[:3])
        bond_count = int(counts[3:6])
    except ValueError:
        parts = counts.split()
        if len(parts) < 2:
            return [], []
        atom_count = int(parts[0])
        bond_count = int(parts[1])

    atoms: list[dict] = []
    atom_start = counts_index + 1
    for line in lines[atom_start : atom_start + atom_count]:
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            x, y, z = float(parts[0]), float(parts[1]), float(parts[2])
        except ValueError:
            continue
        element = re.sub(r"[^A-Za-z]", "", parts[3])[:2].title() or "C"
        atoms.append({"x": x, "y": y, "z": z, "element": element})

    bonds: list[tuple[int, int, int]] = []
    bond_start = atom_start + atom_count
    for line in lines[bond_start : bond_start + bond_count]:
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            a = int(parts[0])
            b = int(parts[1])
            order = int(parts[2])
        except ValueError:
            continue
        if a > 0 and b > 0:
            bonds.append((a, b, max(1, order)))
    return atoms, bonds


def make_pdb_atom_names(atoms: list[dict]) -> list[str]:
    counts: dict[str, int] = {}
    names: list[str] = []
    used: set[str] = set()
    for index, atom in enumerate(atoms, start=1):
        element = str(atom.get("element") or "C").strip().title()[:2] or "C"
        key = element.upper()
        counts[key] = counts.get(key, 0) + 1
        name = f"{key}{counts[key]}"[:4]
        if name in used:
            name = f"X{index:03d}"[-4:]
        used.add(name)
        names.append(name)
    return names


def pdb_atom_line(serial: int, atom: dict, atom_name: str) -> str:
    element = str(atom.get("element") or "C").strip().title()[:2]
    safe_name = re.sub(r"[^A-Za-z0-9]", "", atom_name).upper()[:4] or element.upper()
    return (
        f"HETATM{serial:5d} {safe_name:<4s} LIG A   1    "
        f"{atom['x']:8.3f}{atom['y']:8.3f}{atom['z']:8.3f}"
        f"  1.00  0.00          {element:>2s}"
    )


def normalized_bond_pairs(bonds: list[tuple[int, int, int]]) -> set[tuple[int, int]]:
    return {tuple(sorted((a, b))) for a, b, _order in bonds if a > 0 and b > 0 and a != b}


def pdb_conect_lines(bonds: list[tuple[int, int, int]]) -> list[str]:
    neighbors: dict[int, set[int]] = {}
    for a, b, _order in bonds:
        if a <= 0 or b <= 0 or a == b:
            continue
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    lines: list[str] = []
    for atom_id in sorted(neighbors):
        linked = "".join(f"{target:5d}" for target in sorted(neighbors[atom_id]))
        lines.append(f"CONECT{atom_id:5d}{linked}")
    return lines


def sdf_to_multimodel_pdb(data: bytes, top_n: int) -> tuple[bytes, int, int]:
    records, total = sdf_records_text(data, top_n)
    parsed = [parse_sdf_record(record) for record in records]
    parsed = [(atoms, bonds) for atoms, bonds in parsed if atoms]
    if not parsed:
        trimmed, source_records, kept_records = trim_sdf(data, top_n)
        return trimmed, source_records, kept_records

    first_atom_count = len(parsed[0][0])
    compatible = all(len(atoms) == first_atom_count for atoms, _ in parsed)
    if not compatible:
        trimmed, source_records, kept_records = trim_sdf(data, top_n)
        return trimmed, source_records, kept_records

    reference_bonds = parsed[0][1]
    reference_bond_pairs = normalized_bond_pairs(reference_bonds)
    if not all(normalized_bond_pairs(bonds) == reference_bond_pairs for _atoms, bonds in parsed):
        trimmed, source_records, kept_records = trim_sdf(data, top_n)
        return trimmed, source_records, kept_records

    atom_names = make_pdb_atom_names(parsed[0][0])
    out: list[str] = [
        "REMARK LP-Flow generated multi-model PDB from multi-record SDF docking poses.",
        "REMARK Each MODEL is one docking pose; atom order is preserved from the SDF records.",
        "REMARK SDF bond topology is written once as shared PDB CONECT records after all MODEL blocks.",
    ]
    for model_index, (atoms, _) in enumerate(parsed, start=1):
        out.append(f"MODEL     {model_index:4d}")
        for serial, atom in enumerate(atoms, start=1):
            out.append(pdb_atom_line(serial, atom, atom_names[serial - 1]))
        out.append("ENDMDL")
    out.extend(pdb_conect_lines(reference_bonds))
    out.append("END")
    return ("\n".join(out) + "\n").encode("utf-8"), total, len(parsed)


def parse_label_path(spec: str) -> tuple[str, Path]:
    if "=" in spec:
        label, raw_path = spec.split("=", 1)
        label = label.strip()
        path = Path(raw_path.strip())
    else:
        path = Path(spec.strip())
        label = path.stem
    if not label:
        label = path.stem
    return label, path


def existing_file(path: Path, role: str) -> Path:
    resolved = path.expanduser()
    if not resolved.is_file():
        raise SystemExit(f"{role} file does not exist: {path}")
    return resolved


def resolve_asset_dir(explicit: Path | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(explicit.expanduser())
    env_value = os.environ.get("MOLSTAR_VIEWER_ASSETS")
    if env_value:
        candidates.append(Path(env_value).expanduser())

    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        candidates.append(Path(userprofile) / ".codex" / "tools" / "molstar-viewer" / "5.9.0")
    candidates.append(Path.home() / ".codex" / "tools" / "molstar-viewer" / "5.9.0")

    for candidate in candidates:
        if (candidate / "molstar.js").is_file() and (candidate / "molstar.css").is_file():
            return candidate
    return None


def copy_assets(asset_dir: Path, out_dir: Path) -> tuple[str, str]:
    assets_out = out_dir / "assets"
    assets_out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(asset_dir / "molstar.js", assets_out / "molstar.js")
    shutil.copy2(asset_dir / "molstar.css", assets_out / "molstar.css")
    return "assets/molstar.css", "assets/molstar.js"


def make_file_entry(
    *,
    label: str,
    path: Path,
    role: str,
    fmt: str,
    file_id: str,
    top_n: int,
    data_dir: Path,
    copy_data: bool,
    pose_trajectory: bool,
) -> dict:
    source = existing_file(path, role)
    raw = source.read_bytes()
    total_records: int | None = None
    kept_records: int | None = None
    data = raw
    output_fmt = fmt
    if role == "pose" and fmt == "sdf" and pose_trajectory:
        data, total_records, kept_records = sdf_to_multimodel_pdb(raw, top_n)
        output_fmt = "pdb" if data.startswith(b"REMARK LP-Flow generated multi-model PDB") else fmt
    elif role == "pose":
        data, total_records, kept_records = trim_pose_data(raw, fmt, top_n)

    suffix = EXT_BY_FORMAT.get(output_fmt, source.suffix.lower() or ".txt")
    data_filename = f"{file_id}{suffix}"
    if copy_data:
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / data_filename).write_bytes(data)

    entry = {
        "id": file_id,
        "label": label,
        "role": role,
        "format": output_fmt,
        "source_format": fmt,
        "source_path": str(source),
        "source_name": source.name,
        "data_file": f"data/{data_filename}" if copy_data else None,
        "bytes": len(data),
        "source_bytes": len(raw),
        "dataBase64": base64.b64encode(data).decode("ascii"),
    }
    if total_records is not None:
        entry["source_records"] = total_records
        entry["kept_records"] = kept_records
    if role == "pose" and fmt == "sdf" and output_fmt == "pdb":
        entry["trajectory_like"] = True
        entry["trajectory_source"] = "multi-record SDF converted to multi-MODEL PDB for Mol* trajectory controls"
    return entry


def public_manifest(config: dict) -> dict:
    clean_files = []
    for item in config["files"]:
        clean = {key: value for key, value in item.items() if key != "dataBase64"}
        clean_files.append(clean)
    manifest = dict(config)
    manifest["files"] = clean_files
    return manifest


def build_html(config: dict, css_href: str, js_src: str) -> str:
    title = config["title"]
    safe_title = html.escape(title, quote=True)
    safe_css_href = html.escape(css_href, quote=True)
    safe_js_src = html.escape(js_src, quote=True)
    config_json = json.dumps(config, ensure_ascii=False, indent=2).replace("</", "<\\/")
    debug_layout_js = "true" if config.get("debug_layout") else "false"
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_title}</title>
  <link rel="stylesheet" href="{safe_css_href}">
  <style>
    html, body {{
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: Arial, sans-serif;
      background: #f6f7f9;
      color: #17191f;
    }}
    .shell {{
      display: grid;
      grid-template-columns: minmax(220px, 300px) 1fr;
      width: 100%;
      height: 100%;
    }}
    .side {{
      border-right: 1px solid #d7dbe3;
      background: #ffffff;
      padding: 16px;
      overflow: auto;
      box-sizing: border-box;
    }}
    .side h1 {{
      margin: 0 0 8px;
      font-size: 18px;
      line-height: 1.25;
    }}
    .meta {{
      margin: 0 0 16px;
      font-size: 12px;
      line-height: 1.4;
      color: #5c6472;
    }}
    .scene-button {{
      display: block;
      width: 100%;
      min-height: 36px;
      margin: 0 0 8px;
      padding: 8px 10px;
      border: 1px solid #cbd1dc;
      border-radius: 6px;
      background: #f9fafc;
      color: #17191f;
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }}
    .scene-button.active {{
      background: #e8f0ff;
      border-color: #7aa2f7;
    }}
    .focus-button {{
      display: block;
      width: 100%;
      min-height: 36px;
      margin: 6px 0 8px;
      padding: 8px 10px;
      border: 1px solid #8fc7b5;
      border-radius: 6px;
      background: #eefaf6;
      color: #143a31;
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }}
    .focus-button:disabled {{
      cursor: not-allowed;
      opacity: 0.55;
    }}
    .status {{
      margin-top: 14px;
      font-size: 12px;
      line-height: 1.4;
      color: #4e5664;
      white-space: pre-wrap;
    }}
    .viewer-wrap {{
      min-width: 0;
      min-height: 0;
      position: relative;
    }}
    #viewer {{
      position: absolute;
      inset: 0;
    }}
    @media (max-width: 760px) {{
      .shell {{
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }}
      .side {{
        max-height: 34vh;
        border-right: none;
        border-bottom: 1px solid #d7dbe3;
      }}
    }}
  </style>
</head>
<body>
  <div class="shell">
    <aside class="side">
      <h1>{safe_title}</h1>
      <p class="meta">Ordinary Mol* docking viewer. Multi-record GNINA SDF files are exposed as multi-model pose files for Mol* trajectory/model controls.</p>
      <div id="scene-list"></div>
      <button id="focus-ligand" class="focus-button" type="button" disabled>Double-click selected ligand</button>
      <div id="status" class="status">Loading Mol*...</div>
    </aside>
    <main class="viewer-wrap">
      <div id="viewer"></div>
    </main>
  </div>
  <script src="{safe_js_src}"></script>
  <script type="application/json" id="viewer-data">
{config_json}
  </script>
  <script>
    const config = JSON.parse(document.getElementById('viewer-data').textContent);
    const files = new Map(config.files.map(file => [file.id, file]));
    const scenes = new Map(config.scenes.map(scene => [scene.id, scene]));
    let viewer = null;
    let activeSceneId = null;
    let ligandFocusRunId = 0;
    let ligandFocusTimers = [];

    function setStatus(message) {{
      document.getElementById('status').textContent = message;
    }}

    function bytesFromBase64(b64) {{
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }}

    function makeBlobUrl(file) {{
      const bytes = bytesFromBase64(file.dataBase64);
      const blob = new Blob([bytes], {{ type: 'text/plain' }});
      return URL.createObjectURL(blob);
    }}

    async function clearViewer() {{
      if (viewer && viewer.plugin && viewer.plugin.clear) {{
        await viewer.plugin.clear();
      }}
    }}

    function getScenePoseFile(scene) {{
      for (const fileId of scene.fileIds) {{
        const file = files.get(fileId);
        if (file && file.role === 'pose') return file;
      }}
      return null;
    }}

    function parseSdfAtoms(file) {{
      if (!file || file.format !== 'sdf') return null;
      const text = new TextDecoder('utf-8').decode(bytesFromBase64(file.dataBase64));
      const record = (text.split('$$$$')[0] || '').trimEnd();
      const lines = record.split(/\\r?\\n/);
      const atoms = [];
      const counts = lines[3] || '';
      const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
      if (Number.isFinite(atomCount) && atomCount > 0) {{
        for (let i = 4; i < Math.min(lines.length, 4 + atomCount); i += 1) {{
          const parts = lines[i].trim().split(/\\s+/);
          const xyz = parts.slice(0, 3).map(Number);
          if (xyz.every(Number.isFinite)) atoms.push({{ xyz, element: parts[3] || '' }});
        }}
      }}
      if (!atoms.length) {{
        for (const line of lines) {{
          const parts = line.trim().split(/\\s+/);
          if (parts.length < 4 || !/^[A-Za-z]/.test(parts[3])) continue;
          const xyz = parts.slice(0, 3).map(Number);
          if (xyz.every(Number.isFinite)) atoms.push({{ xyz, element: parts[3] || '' }});
        }}
      }}
      return atoms.length ? atoms : null;
    }}

    function parsePdbAtoms(file) {{
      if (!file || file.format !== 'pdb') return null;
      const lines = new TextDecoder('utf-8').decode(bytesFromBase64(file.dataBase64)).split(/\\r?\\n/);
      const atoms = [];
      let insideFirstModel = false;
      let sawModel = false;
      for (const line of lines) {{
        if (/^MODEL\\b/.test(line)) {{
          if (sawModel) break;
          sawModel = true;
          insideFirstModel = true;
          continue;
        }}
        if (/^ENDMDL\\b/.test(line)) {{
          if (insideFirstModel) break;
          continue;
        }}
        if (sawModel && !insideFirstModel) continue;
        if (!/^(ATOM  |HETATM)/.test(line)) continue;
        const xyz = [
          Number.parseFloat(line.slice(30, 38)),
          Number.parseFloat(line.slice(38, 46)),
          Number.parseFloat(line.slice(46, 54)),
        ];
        if (xyz.every(Number.isFinite)) atoms.push({{ xyz, element: line.slice(76, 78).trim() || line.slice(12, 16).trim().replace(/[^A-Za-z]/g, '') }});
      }}
      return atoms.length ? atoms : null;
    }}

    function parsePoseAtoms(file) {{
      if (!file) return null;
      if (file.format === 'sdf') return parseSdfAtoms(file);
      if (file.format === 'pdb') return parsePdbAtoms(file);
      return null;
    }}

    function sphereFromAtoms(atoms) {{
      if (!atoms || !atoms.length) return null;
      const center = [0, 0, 0];
      for (const atom of atoms) {{
        center[0] += atom.xyz[0];
        center[1] += atom.xyz[1];
        center[2] += atom.xyz[2];
      }}
      center[0] /= atoms.length;
      center[1] /= atoms.length;
      center[2] /= atoms.length;
      let maxDistance = 0;
      for (const atom of atoms) {{
        maxDistance = Math.max(maxDistance, Math.hypot(atom.xyz[0] - center[0], atom.xyz[1] - center[1], atom.xyz[2] - center[2]));
      }}
      return {{ center, radius: Math.max(8, maxDistance + 5) }};
    }}

    function getMolstarCanvas() {{
      return document.querySelector('#viewer canvas') || document.querySelector('canvas');
    }}

    function getCanvas3d() {{
      return viewer && viewer.plugin ? viewer.plugin.canvas3d : null;
    }}

    function updateFocusButton(scene) {{
      const button = document.getElementById('focus-ligand');
      if (!button) return;
      const poseFile = scene ? getScenePoseFile(scene) : null;
      button.disabled = !poseFile;
      button.textContent = poseFile ? `Double-click selected ligand: ${{poseFile.label}}` : 'Double-click selected ligand';
    }}

    function focusLigandFallback(scene, notify = false) {{
      const poseFile = scene ? getScenePoseFile(scene) : null;
      const sphere = sphereFromAtoms(parsePoseAtoms(poseFile));
      const camera = viewer && viewer.plugin && viewer.plugin.managers && viewer.plugin.managers.camera;
      if (!sphere || !camera || !camera.focusSphere) {{
        if (notify) setStatus(`Loaded: ${{scene ? scene.label : 'scene'}}\\nLigand focus is unavailable for this pose file.`);
        return false;
      }}
      camera.focusSphere({{ center: sphere.center, radius: sphere.radius }}, {{ durationMs: 450 }});
      if (notify) setStatus(`Loaded: ${{scene.label}}\\nCoordinate fallback focus: ${{poseFile.label}}\\n${{scene.note || ''}}`);
      return true;
    }}

    function projectAtomToCanvas(atom) {{
      const canvas = getMolstarCanvas();
      const canvas3d = getCanvas3d();
      const camera = canvas3d && canvas3d.camera;
      if (!canvas || !camera || !camera.project) return null;
      const rect = canvas.getBoundingClientRect();
      const viewport = camera.viewport || {{ x: 0, y: 0, width: canvas.width || rect.width, height: canvas.height || rect.height }};
      const out = [0, 0, 0, 0];
      camera.project(out, atom.xyz);
      const viewportWidth = viewport.width || canvas.width || rect.width;
      const viewportHeight = viewport.height || canvas.height || rect.height;
      const drawX = out[0] - (viewport.x || 0);
      const drawY = viewportHeight - (out[1] - (viewport.y || 0));
      const x = drawX * rect.width / viewportWidth;
      const y = drawY * rect.height / viewportHeight;
      if (![x, y, drawX, drawY, out[2]].every(Number.isFinite)) return null;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      return {{
        x,
        y,
        drawX,
        drawY,
        clientX: rect.left + x,
        clientY: rect.top + y,
        z: out[2],
      }};
    }}

    function identifyAtPoint(point) {{
      const canvas3d = getCanvas3d();
      if (!canvas3d || !canvas3d.identify) return [];
      const candidates = [
        {{ kind: 'css', coords: [point.x, point.y] }},
        {{ kind: 'draw', coords: [point.drawX, point.drawY] }},
      ];
      const seen = new Set();
      const picks = [];
      for (const candidate of candidates) {{
        if (!candidate.coords.every(Number.isFinite)) continue;
        const key = candidate.coords.map(value => Math.round(value)).join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        try {{
          const pick = canvas3d.identify(candidate.coords);
          if (pick && pick.position) picks.push({{ pick, kind: candidate.kind }});
        }} catch (error) {{
          console.debug('Mol* identify failed', candidate.kind, error);
        }}
      }}
      return picks;
    }}

    function pickDistanceToAtom(pick, atom) {{
      const position = pick && pick.position;
      if (!position || position.length < 3) return Number.POSITIVE_INFINITY;
      return Math.hypot(position[0] - atom.xyz[0], position[1] - atom.xyz[1], position[2] - atom.xyz[2]);
    }}

    function getPickLoci(pick) {{
      const canvas3d = getCanvas3d();
      if (!canvas3d || !canvas3d.getLoci || !pick) return null;
      try {{
        return canvas3d.getLoci(pick.id, pick.position);
      }} catch (error) {{
        console.debug('Mol* getLoci failed', error);
        return null;
      }}
    }}

    function focusPickedLoci(pick) {{
      const camera = viewer && viewer.plugin && viewer.plugin.managers && viewer.plugin.managers.camera;
      const loci = getPickLoci(pick);
      if (!camera || !camera.focusLoci || !loci) return false;
      try {{
        camera.focusLoci(loci);
        return true;
      }} catch (error) {{
        console.debug('Mol* focusLoci failed', error);
        return false;
      }}
    }}

    function findPickableLigandAtom(file) {{
      const atoms = parsePoseAtoms(file);
      if (!atoms) return null;
      let best = null;
      for (const atom of atoms) {{
        const point = projectAtomToCanvas(atom);
        if (!point) continue;
        for (const identified of identifyAtPoint(point)) {{
          const distance = pickDistanceToAtom(identified.pick, atom);
          if (distance <= 1.6 && (!best || distance < best.distance || point.z < best.point.z)) {{
            best = {{ atom, point, pick: identified.pick, identifyKind: identified.kind, distance }};
          }}
        }}
      }}
      return best;
    }}

    function dispatchMolstarDoubleClick(point) {{
      const canvas = getMolstarCanvas();
      if (!canvas) return false;
      const base = {{
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: point.clientX,
        clientY: point.clientY,
        screenX: point.clientX,
        screenY: point.clientY,
        button: 0,
      }};
      canvas.dispatchEvent(new MouseEvent('mousemove', {{ ...base, buttons: 0, detail: 0 }}));
      canvas.dispatchEvent(new MouseEvent('mousedown', {{ ...base, buttons: 1, detail: 1 }}));
      canvas.dispatchEvent(new MouseEvent('mouseup', {{ ...base, buttons: 0, detail: 1 }}));
      canvas.dispatchEvent(new MouseEvent('click', {{ ...base, buttons: 0, detail: 1 }}));
      canvas.dispatchEvent(new MouseEvent('mousedown', {{ ...base, buttons: 1, detail: 2 }}));
      canvas.dispatchEvent(new MouseEvent('mouseup', {{ ...base, buttons: 0, detail: 2 }}));
      canvas.dispatchEvent(new MouseEvent('click', {{ ...base, buttons: 0, detail: 2 }}));
      canvas.dispatchEvent(new MouseEvent('dblclick', {{ ...base, buttons: 0, detail: 2 }}));
      return true;
    }}

    async function doubleClickLigandForScene(scene, notify = false, options = {{}}) {{
      const poseFile = scene ? getScenePoseFile(scene) : null;
      if (!poseFile) {{
        if (notify) setStatus(`Loaded: ${{scene ? scene.label : 'scene'}}\\nNo docking pose file is selected.`);
        return {{ ok: false, verified: false }};
      }}

      let hit = findPickableLigandAtom(poseFile);
      if (!hit) {{
        focusLigandFallback(scene, false);
        await new Promise(resolve => window.setTimeout(resolve, 650));
        hit = findPickableLigandAtom(poseFile);
      }}

      if (!hit) {{
        const allowFallback = Boolean(options.allowFallback);
        if (!allowFallback) return {{ ok: false, verified: false }};
        const fallback = focusLigandFallback(scene, notify);
        if (notify) {{
          if (fallback) {{
            setStatus(`Loaded: ${{scene.label}}\\nNo verified Mol* ligand pick was found after retries; used coordinate fallback for ${{poseFile.label}}.\\n${{scene.note || ''}}`);
          }} else {{
            setStatus(`Loaded: ${{scene.label}}\\nNo verified Mol* ligand pick was found for ${{poseFile.label}}.\\n${{scene.note || ''}}`);
          }}
        }}
        return {{ ok: fallback, verified: false, fallback }};
      }}

      dispatchMolstarDoubleClick(hit.point);
      window.setTimeout(() => focusPickedLoci(hit.pick), 80);
      if (notify) {{
        const distanceText = hit.distance.toFixed(2);
        const prefix = options.auto ? 'Auto double-clicked' : 'Double-clicked';
        setStatus(`Loaded: ${{scene.label}}\\n${{prefix}} verified ligand atom: ${{poseFile.label}} (pick distance ${{distanceText}} A).\\n${{scene.note || ''}}`);
      }}
      return {{ ok: true, verified: true, distance: hit.distance }};
    }}

    function clearLigandFocusTimers() {{
      for (const timer of ligandFocusTimers) window.clearTimeout(timer);
      ligandFocusTimers = [];
    }}

    function scheduleLigandDoubleClick(scene) {{
      clearLigandFocusTimers();
      const poseFile = scene ? getScenePoseFile(scene) : null;
      if (!poseFile) return;
      const runId = ++ligandFocusRunId;
      const delays = [350, 900, 1600, 2600, 4000];
      for (let index = 0; index < delays.length; index += 1) {{
        const timer = window.setTimeout(async () => {{
          if (runId !== ligandFocusRunId || !scene || scene.id !== activeSceneId) return;
          const finalAttempt = index === delays.length - 1;
          const result = await doubleClickLigandForScene(scene, true, {{
            auto: true,
            allowFallback: finalAttempt,
          }});
          if (result && result.verified && runId === ligandFocusRunId) {{
            clearLigandFocusTimers();
          }}
        }}, delays[index]);
        ligandFocusTimers.push(timer);
      }}
    }}

    async function loadFile(file) {{
      const url = makeBlobUrl(file);
      try {{
        await viewer.loadStructureFromUrl(url, file.format, false, {{ label: file.label }});
      }} finally {{
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      }}
    }}

    async function loadScene(sceneId) {{
      const scene = scenes.get(sceneId);
      if (!scene) return;
      activeSceneId = sceneId;
      document.querySelectorAll('.scene-button').forEach(button => {{
        button.classList.toggle('active', button.dataset.sceneId === sceneId);
      }});
      setStatus(`Loading: ${{scene.label}}`);
      clearLigandFocusTimers();
      await clearViewer();
      for (const fileId of scene.fileIds) {{
        const file = files.get(fileId);
        if (file) {{
          await loadFile(file);
        }}
      }}
      setStatus(`Loaded: ${{scene.label}}\\n${{scene.note || ''}}`);
      updateFocusButton(scene);
      scheduleLigandDoubleClick(scene);
    }}

    function buildSceneList() {{
      const root = document.getElementById('scene-list');
      for (const scene of config.scenes) {{
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scene-button';
        button.dataset.sceneId = scene.id;
        button.textContent = scene.label;
        button.addEventListener('click', () => loadScene(scene.id));
        root.appendChild(button);
      }}
      const focusButton = document.getElementById('focus-ligand');
      if (focusButton) {{
        focusButton.addEventListener('click', () => {{
          clearLigandFocusTimers();
          void doubleClickLigandForScene(scenes.get(activeSceneId), true, {{ allowFallback: true }});
        }});
      }}
    }}

    async function init() {{
      buildSceneList();
      const debugLayout = {debug_layout_js};
      viewer = await molstar.Viewer.create('viewer', {{
        layoutIsExpanded: true,
        layoutShowControls: true,
        layoutShowSequence: debugLayout,
        layoutShowLog: debugLayout,
        layoutShowLeftPanel: debugLayout,
        collapseLeftPanel: !debugLayout,
        collapseRightPanel: false,
        viewportShowScreenshotControls: true,
        viewportShowControls: true,
        viewportShowSettings: true,
        viewportShowAnimation: true,
        viewportShowTrajectoryControls: true,
        viewportBackgroundColor: 'white'
      }});
      await loadScene(config.defaultSceneId);
    }}

    window.addEventListener('error', event => {{
      setStatus(`Viewer error: ${{event.message}}`);
    }});

    init().catch(error => {{
      console.error(error);
      setStatus(`Viewer failed: ${{error && error.message ? error.message : error}}`);
    }});
  </script>
</body>
</html>
"""


def build_config(args: argparse.Namespace, css_href: str, js_src: str, asset_source: str) -> dict:
    out_dir = args.out_dir
    data_dir = out_dir / "data"
    used_ids: set[str] = set()
    files: list[dict] = []

    receptor_format = detect_format(args.receptor, args.receptor_format)
    receptor_id = unique_id("receptor", used_ids)
    files.append(
        make_file_entry(
            label="Receptor",
            path=args.receptor,
            role="receptor",
            fmt=receptor_format,
            file_id=receptor_id,
            top_n=args.top_n,
            data_dir=data_dir,
            copy_data=not args.no_copy_data,
            pose_trajectory=False,
        )
    )

    reference_ids: list[str] = []
    for index, path in enumerate(args.reference_ligand or [], start=1):
        fmt = detect_format(path, args.reference_format)
        file_id = unique_id(safe_id(f"reference_{index}", "ref"), used_ids)
        label = "Reference ligand" if index == 1 else f"Reference ligand {index}"
        files.append(
            make_file_entry(
                label=label,
                path=path,
                role="reference",
                fmt=fmt,
                file_id=file_id,
                top_n=args.top_n,
                data_dir=data_dir,
                copy_data=not args.no_copy_data,
                pose_trajectory=False,
            )
        )
        reference_ids.append(file_id)

    pose_ids: list[tuple[str, str]] = []
    for spec in args.pose or []:
        label, path = parse_label_path(spec)
        fmt = detect_format(path, args.pose_format)
        file_id = unique_id(safe_id(label, "pose"), used_ids)
        files.append(
            make_file_entry(
                label=label,
                path=path,
                role="pose",
                fmt=fmt,
                file_id=file_id,
                top_n=args.top_n,
                data_dir=data_dir,
                copy_data=not args.no_copy_data,
                pose_trajectory=not args.no_pose_trajectory,
            )
        )
        pose_ids.append((file_id, label))

    scenes = [
        {
            "id": "initial",
            "label": "Initial receptor/reference",
            "fileIds": [receptor_id, *reference_ids],
            "note": args.active_site_note or "No generated docking poses are shown in this scene.",
        }
    ]

    for file_id, label in pose_ids:
        scenes.append(
            {
                "id": unique_id(safe_id(f"scene_{label}", "scene"), set(scene["id"] for scene in scenes)),
                "label": f"GNINA top {args.top_n}: {label}",
                "fileIds": [receptor_id, *reference_ids, file_id],
                "note": (
                    f"Pose file trimmed to top {args.top_n} records when applicable. "
                    "For multi-record SDF, the viewer emits a multi-MODEL trajectory-like ligand for Mol* frame/animation controls."
                ),
            }
        )

    title = args.title or f"Mol* docking viewer: {args.case or args.out_dir.name}"
    return {
        "title": title,
        "case": args.case,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "asset_source": asset_source,
        "css_href": css_href,
        "js_src": js_src,
        "top_n": args.top_n,
        "active_site_note": args.active_site_note,
        "debug_layout": bool(args.debug_layout),
        "defaultSceneId": scenes[1]["id"] if len(scenes) > 1 else "initial",
        "files": files,
        "scenes": scenes,
    }


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be >= 1")
    return parsed


def validate_cdn_version(value: str) -> str:
    if not re.fullmatch(r"[0-9A-Za-z._-]+", value):
        raise argparse.ArgumentTypeError("cdn-version must match [0-9A-Za-z._-]+")
    return value


def add_common_format_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--receptor-format", choices=sorted(set(FORMAT_BY_SUFFIX.values())))
    parser.add_argument("--reference-format", choices=sorted(set(FORMAT_BY_SUFFIX.values())))
    parser.add_argument("--pose-format", choices=sorted(set(FORMAT_BY_SUFFIX.values())))


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--case", default="")
    parser.add_argument("--title")
    parser.add_argument("--receptor", required=True, type=Path)
    parser.add_argument("--reference-ligand", action="append", type=Path, default=[])
    parser.add_argument("--pose", action="append", default=[], help="Use label=path or just path.")
    parser.add_argument("--top-n", type=positive_int, default=3)
    parser.add_argument(
        "--no-pose-trajectory",
        action="store_true",
        help="Keep multi-record SDF poses as SDF instead of converting to multi-MODEL PDB trajectory-like ensembles.",
    )
    parser.add_argument("--asset-dir", type=Path)
    parser.add_argument("--cdn-version", type=validate_cdn_version, default="5.9.0")
    parser.add_argument("--active-site-note", default="")
    parser.add_argument("--no-copy-data", action="store_true")
    parser.add_argument(
        "--debug-layout",
        action="store_true",
        help="Show Mol* debug UI panels, including the left panel/object tree, sequence, and log. Useful for inspecting loaded docking objects.",
    )
    add_common_format_options(parser)
    args = parser.parse_args(list(argv) if argv is not None else None)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    asset_dir = resolve_asset_dir(args.asset_dir)
    if asset_dir:
        css_href, js_src = copy_assets(asset_dir, args.out_dir)
        asset_source = str(asset_dir)
    else:
        version = args.cdn_version
        base = f"https://cdn.jsdelivr.net/npm/molstar@{version}/build/viewer"
        css_href = f"{base}/molstar.css"
        js_src = f"{base}/molstar.js"
        asset_source = f"cdn:molstar@{version}"

    config = build_config(args, css_href, js_src, asset_source)
    html_text = build_html(config, css_href, js_src)
    (args.out_dir / "index.html").write_text(html_text, encoding="utf-8", newline="\n")
    (args.out_dir / "manifest.json").write_text(
        json.dumps(public_manifest(config), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(args.out_dir / "index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
