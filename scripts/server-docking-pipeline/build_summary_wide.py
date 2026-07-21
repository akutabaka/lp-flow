#!/usr/bin/env python3
"""Build summary_wide.csv from GNINA/SMINA logs and Boltz JSON outputs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path


COLUMNS = [
    "case",
    "input_receptor",
    "input_ligand",
    "gnina_score_only_affinity",
    "gnina_score_only_cnnscore",
    "gnina_score_only_cnnaffinity",
    "gnina_minimized_affinity",
    "gnina_minimized_cnnscore",
    "gnina_minimized_cnnaffinity",
    "gnina_docking_pose",
    "smina_score_only_affinity",
    "smina_minimized_affinity",
    "smina_docking_pose",
    "matcha_best_minimizedAffinity",
    "matcha_best_minimizedCNNscore",
    "matcha_best_minimizedCNNaffinity",
    "matcha_total_sec",
    "matcha_best_pose",
    "boltz_confidence_score",
    "boltz_ptm",
    "boltz_iptm",
    "boltz_ligand_iptm",
    "boltz_complex_plddt",
    "boltz_complex_iplddt",
    "boltz_affinity_pred_value",
    "boltz_affinity_probability_binary",
    "boltz_ic50_uM",
    "boltz_pIC50",
    "boltz_deltaG_kcal_mol_approx",
    "boltz_receptor_includes_cofactors",
    "boltz_status",
    "gnina_status",
    "gnina_error",
    "smina_status",
    "smina_error",
    "matcha_status",
    "matcha_error",
    "boltz_error",
]

METHODS = {"gnina", "smina", "matcha", "boltz"}
STATUSES = {"ok", "not_run", "skipped", "unavailable", "failed"}
MATCHA_RESULT_KEYS = {
    "minimizedAffinity": "matcha_best_minimizedAffinity",
    "matcha_best_minimizedAffinity": "matcha_best_minimizedAffinity",
    "minimizedCNNscore": "matcha_best_minimizedCNNscore",
    "matcha_best_minimizedCNNscore": "matcha_best_minimizedCNNscore",
    "minimizedCNNaffinity": "matcha_best_minimizedCNNaffinity",
    "matcha_best_minimizedCNNaffinity": "matcha_best_minimizedCNNaffinity",
    "total_sec": "matcha_total_sec",
    "matcha_total_sec": "matcha_total_sec",
}
BOLTZ_SCORE_KEYS = {
    "confidence_score": "boltz_confidence_score",
    "ptm": "boltz_ptm",
    "iptm": "boltz_iptm",
    "ligand_iptm": "boltz_ligand_iptm",
    "complex_plddt": "boltz_complex_plddt",
    "complex_iplddt": "boltz_complex_iplddt",
    "affinity_pred_value": "boltz_affinity_pred_value",
    "affinity_probability_binary": "boltz_affinity_probability_binary",
}
BOLTZ_ID_COLUMNS = (
    "ligand_id",
    "record_id",
    "input_ligand",
    "ligand",
    "name",
    "id",
    "sample",
    "file",
)


def fmt(value: object) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return ""
        return f"{value:.6f}".rstrip("0").rstrip(".")
    return str(value)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def parse_gnina(log: Path) -> tuple[float | None, float | None, float | None, str]:
    if not log.exists():
        return None, None, None, "missing log"
    text = read_text(log)
    for line in text.splitlines():
        match = re.match(
            r"\s*1\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)",
            line,
        )
        if match:
            return float(match.group(1)), float(match.group(3)), float(match.group(4)), ""
    affinity = re.search(r"\bAffinity:\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    cnnscore = re.search(r"\bCNNscore:\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    cnnaffinity = re.search(r"\bCNNaffinity:\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if affinity or cnnscore or cnnaffinity:
        return (
            float(affinity.group(1)) if affinity else None,
            float(cnnscore.group(1)) if cnnscore else None,
            float(cnnaffinity.group(1)) if cnnaffinity else None,
            "",
        )
    return None, None, None, "mode 1 table row not found"


def parse_smina(log: Path) -> tuple[float | None, str]:
    if not log.exists():
        return None, "missing log"
    text = read_text(log)
    for line in text.splitlines():
        match = re.match(r"\s*1\s+(-?\d+(?:\.\d+)?)\s+", line)
        if match:
            return float(match.group(1)), ""
    affinity = re.search(r"\bAffinity:\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if affinity:
        return float(affinity.group(1)), ""
    return None, "mode 1 table row not found"


def load_json(path: Path) -> tuple[dict, str]:
    if not path.exists():
        return {}, "missing json"
    try:
        return json.loads(path.read_text(encoding="utf-8")), ""
    except Exception as exc:  # noqa: BLE001 - keep failure explicit in CSV
        return {}, f"json parse failed: {exc}"


def row_matches_ligand(row: dict[str, str], ligand_id: str) -> bool:
    ligand_id_lower = ligand_id.lower()
    for key in BOLTZ_ID_COLUMNS:
        value = (row.get(key) or "").strip().lower()
        if value == ligand_id_lower or Path(value).stem.lower() == ligand_id_lower:
            return True
    return False


def find_boltz_scores_row(run_dir: Path, ligand_id: str) -> tuple[dict[str, str], str]:
    roots = [run_dir / "boltz" / "out", run_dir / "boltz"]
    seen: set[Path] = set()
    candidates: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("scores.csv"):
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                candidates.append(path)

    if not candidates:
        return {}, "scores.csv not found"

    errors: list[str] = []
    for path in sorted(candidates):
        try:
            with path.open(newline="", encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
        except Exception as exc:  # noqa: BLE001 - keep failure explicit in CSV
            errors.append(f"{path}: csv parse failed: {exc}")
            continue
        if not rows:
            errors.append(f"{path}: no rows")
            continue
        matches = [row for row in rows if row_matches_ligand(row, ligand_id)]
        if len(matches) == 1:
            return matches[0], ""
        if not matches and len(rows) == 1:
            return rows[0], ""
        if matches:
            return matches[0], f"{path}: multiple rows matched {ligand_id}, using first"
        errors.append(f"{path}: no row matched {ligand_id}")

    return {}, "; ".join(errors) if errors else "scores.csv row not found"


def find_boltz_prediction_dir(run_dir: Path, ligand_id: str) -> Path | None:
    candidates = [
        run_dir / "boltz" / "out" / f"boltz_results_{ligand_id}" / "predictions" / ligand_id,
        run_dir / "boltz" / "out" / ligand_id / f"boltz_results_{ligand_id}" / "predictions" / ligand_id,
        run_dir / "boltz" / ligand_id / f"boltz_results_{ligand_id}" / "predictions" / ligand_id,
    ]
    for candidate in candidates:
        if (candidate / f"confidence_{ligand_id}_model_0.json").exists():
            return candidate
    for root in (run_dir / "boltz" / "out", run_dir / "boltz"):
        if not root.exists():
            continue
        for confidence in root.rglob(f"confidence_{ligand_id}_model_0.json"):
            if confidence.parent.name == ligand_id:
                return confidence.parent
    return None


def parse_methods(items: list[str] | None) -> set[str]:
    if not items:
        return set()
    methods: set[str] = set()
    for item in items:
        for method in item.split(","):
            method = method.strip().lower()
            if not method:
                continue
            if method not in METHODS:
                raise SystemExit(f"Unknown method: {method}")
            methods.add(method)
    return methods


def parse_method_status(items: list[str] | None) -> dict[tuple[str | None, str], tuple[str, str]]:
    statuses: dict[tuple[str | None, str], tuple[str, str]] = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(
                "Invalid --method-status value, expected method=status[:error] "
                f"or ligand_id:method=status[:error]: {item}"
            )
        left, rest = item.split("=", 1)
        ligand_id: str | None = None
        if ":" in left:
            ligand_id, method = left.split(":", 1)
            ligand_id = ligand_id.strip()
            if not ligand_id:
                raise SystemExit(f"Empty ligand_id in --method-status: {item}")
        else:
            method = left
        method = method.strip().lower()
        if method not in METHODS:
            raise SystemExit(f"Unknown method in --method-status: {method}")
        status, _, error = rest.partition(":")
        status = status.strip().lower()
        if status not in STATUSES:
            raise SystemExit(f"Unknown status in --method-status: {status}")
        statuses[(ligand_id, method)] = (status, error.strip())
    return statuses


def parse_matcha_results(items: list[str] | None) -> dict[str, dict[str, str]]:
    results: dict[str, dict[str, str]] = {}
    for item in items or []:
        if ":" not in item:
            raise SystemExit(
                "Invalid --matcha-result value, expected "
                "ligand_id:key=value,key=value"
            )
        ligand_id, rest = item.split(":", 1)
        ligand_id = ligand_id.strip()
        if not ligand_id:
            raise SystemExit(f"Empty ligand_id in --matcha-result: {item}")
        values = results.setdefault(ligand_id, {})
        for pair in rest.split(","):
            pair = pair.strip()
            if not pair:
                continue
            if "=" not in pair:
                raise SystemExit(f"Invalid Matcha metric pair, expected key=value: {pair}")
            key, value = pair.split("=", 1)
            column = MATCHA_RESULT_KEYS.get(key.strip())
            if not column:
                raise SystemExit(f"Unknown Matcha metric key: {key}")
            values[column] = value.strip()
    return results


def infer_methods_run(run_dir: Path, ligand_ids: list[str]) -> set[str]:
    methods: set[str] = set()
    logs_dir = run_dir / "logs"
    for ligand_id in ligand_ids:
        if (logs_dir / f"{ligand_id}_gnina.log").exists():
            methods.add("gnina")
        if (logs_dir / f"{ligand_id}_smina.log").exists():
            methods.add("smina")
        if (logs_dir / f"{ligand_id}_matcha.log").exists() or (run_dir / "matcha" / f"{ligand_id}_matcha_best.sdf").exists():
            methods.add("matcha")
        if find_boltz_prediction_dir(run_dir, ligand_id):
            methods.add("boltz")
    return methods


def apply_status_override(
    row: dict[str, object],
    ligand_id: str,
    method: str,
    status_overrides: dict[tuple[str | None, str], tuple[str, str]],
) -> bool:
    override = status_overrides.get((ligand_id, method)) or status_overrides.get((None, method))
    if not override:
        return False
    status, error = override
    row[f"{method}_status"] = status
    if f"{method}_error" in row:
        row[f"{method}_error"] = error
    return status in {"not_run", "skipped", "unavailable", "failed"}


def build_row(
    run_dir: Path,
    case: str,
    receptor: str,
    ligand: str,
    ligand_id: str,
    methods_run: set[str],
    status_overrides: dict[tuple[str | None, str], tuple[str, str]],
    matcha_results: dict[str, dict[str, str]],
) -> dict[str, object]:
    row: dict[str, object] = {column: "" for column in COLUMNS}
    row["case"] = case
    row["input_receptor"] = receptor
    row["input_ligand"] = ligand

    if not apply_status_override(row, ligand_id, "gnina", status_overrides):
        if "gnina" in methods_run:
            gnina_errors = []
            gsa, gsc, gsca, gnina_score_error = parse_gnina(run_dir / "logs" / f"{ligand_id}_gnina_score_only.log")
            row["gnina_score_only_affinity"] = gsa
            row["gnina_score_only_cnnscore"] = gsc
            row["gnina_score_only_cnnaffinity"] = gsca
            if gnina_score_error:
                gnina_errors.append(f"score_only: {gnina_score_error}")
            ga, gc, gca, gnina_error = parse_gnina(run_dir / "logs" / f"{ligand_id}_gnina.log")
            row["gnina_minimized_affinity"] = ga
            row["gnina_minimized_cnnscore"] = gc
            row["gnina_minimized_cnnaffinity"] = gca
            if gnina_error:
                gnina_errors.append(f"minimized: {gnina_error}")
            gnina_pose = run_dir / "gnina" / f"{ligand_id}_gnina.sdf"
            if gnina_pose.is_file() and gnina_pose.stat().st_size > 0:
                row["gnina_docking_pose"] = str(gnina_pose)
            else:
                gnina_errors.append("docking: pose file missing or empty")
            row["gnina_status"] = "failed" if gnina_errors else "ok"
            row["gnina_error"] = "; ".join(gnina_errors)
        else:
            row["gnina_status"] = "not_run"

    if not apply_status_override(row, ligand_id, "smina", status_overrides):
        if "smina" in methods_run:
            smina_errors = []
            ssa, smina_score_error = parse_smina(run_dir / "logs" / f"{ligand_id}_smina_score_only.log")
            row["smina_score_only_affinity"] = ssa
            if smina_score_error:
                smina_errors.append(f"score_only: {smina_score_error}")
            sa, smina_error = parse_smina(run_dir / "logs" / f"{ligand_id}_smina.log")
            row["smina_minimized_affinity"] = sa
            if smina_error:
                smina_errors.append(f"minimized: {smina_error}")
            smina_pose = run_dir / "smina" / f"{ligand_id}_smina.pdbqt"
            if smina_pose.is_file() and smina_pose.stat().st_size > 0:
                row["smina_docking_pose"] = str(smina_pose)
            else:
                smina_errors.append("docking: pose file missing or empty")
            row["smina_status"] = "failed" if smina_errors else "ok"
            row["smina_error"] = "; ".join(smina_errors)
        else:
            row["smina_status"] = "not_run"

    if not apply_status_override(row, ligand_id, "matcha", status_overrides):
        if "matcha" in methods_run:
            result = matcha_results.get(ligand_id)
            if result:
                row.update(result)
                matcha_pose = run_dir / "matcha" / f"{ligand_id}_matcha_best.sdf"
                if matcha_pose.is_file() and matcha_pose.stat().st_size > 0:
                    row["matcha_best_pose"] = str(matcha_pose)
                    row["matcha_status"] = "ok"
                else:
                    row["matcha_status"] = "failed"
                    row["matcha_error"] = "Matcha metrics exist but best-pose file is missing or empty"
            else:
                row["matcha_status"] = "failed"
                row["matcha_error"] = "Matcha result not supplied; provide --matcha-result or validated parser output"
        else:
            row["matcha_status"] = "not_run"

    if not apply_status_override(row, ligand_id, "boltz", status_overrides):
        if "boltz" in methods_run:
            scores_row, scores_warning = find_boltz_scores_row(run_dir, ligand_id)
            boltz_errors: list[str] = []
            if scores_row:
                for source_key, column in BOLTZ_SCORE_KEYS.items():
                    row[column] = scores_row.get(source_key, "")
                if scores_warning:
                    boltz_errors.append(scores_warning)
            else:
                boltz_dir = find_boltz_prediction_dir(run_dir, ligand_id)
                if boltz_dir is None:
                    conf, aff = {}, {}
                    boltz_errors.append("Boltz prediction JSON directory not found")
                else:
                    conf, conf_error = load_json(boltz_dir / f"confidence_{ligand_id}_model_0.json")
                    aff, aff_error = load_json(boltz_dir / f"affinity_{ligand_id}.json")
                    boltz_errors.extend(err for err in (conf_error, aff_error) if err)

                for source_key, column in [
                    ("confidence_score", "boltz_confidence_score"),
                    ("ptm", "boltz_ptm"),
                    ("iptm", "boltz_iptm"),
                    ("ligand_iptm", "boltz_ligand_iptm"),
                    ("complex_plddt", "boltz_complex_plddt"),
                    ("complex_iplddt", "boltz_complex_iplddt"),
                ]:
                    row[column] = conf.get(source_key, "")

                row["boltz_affinity_pred_value"] = aff.get("affinity_pred_value", "")
                row["boltz_affinity_probability_binary"] = aff.get("affinity_probability_binary", "")

            value = row["boltz_affinity_pred_value"]
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                if not boltz_errors:
                    boltz_errors.append("missing affinity_pred_value")
            else:
                ic50 = 10**numeric
                pic50 = 6 - numeric
                row["boltz_ic50_uM"] = ic50
                row["boltz_pIC50"] = pic50
                row["boltz_deltaG_kcal_mol_approx"] = -1.364 * pic50

            row["boltz_status"] = "failed" if boltz_errors else "ok"
            row["boltz_error"] = "; ".join(boltz_errors)
        else:
            row["boltz_status"] = "not_run"
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--case", required=True)
    parser.add_argument("--receptor", required=True)
    parser.add_argument("--ligand", action="append", required=True, help="Format: input_name:working_id")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--cofactor-note", default="")
    parser.add_argument("--method", action="append", help="Methods that were intended to run. Repeat or comma-separate.")
    parser.add_argument(
        "--method-status",
        action="append",
        help="Override method status globally or per ligand, e.g. smina=skipped:reason or lig1:boltz=failed:reason.",
    )
    parser.add_argument(
        "--matcha-result",
        action="append",
        help=(
            "Explicit Matcha metrics, e.g. "
            "lig1:minimizedAffinity=-7.1,minimizedCNNscore=0.4,minimizedCNNaffinity=6.2,total_sec=31"
        ),
    )
    args = parser.parse_args()

    ligand_pairs = []
    for item in args.ligand:
        if ":" not in item:
            raise SystemExit(f"Invalid --ligand value, expected input_name:working_id: {item}")
        ligand_pairs.append(item.split(":", 1))

    methods_run = parse_methods(args.method)
    if not args.method:
        methods_run = infer_methods_run(args.run_dir, [ligand_id for _, ligand_id in ligand_pairs])
    status_overrides = parse_method_status(args.method_status)
    matcha_results = parse_matcha_results(args.matcha_result)
    if matcha_results:
        methods_run.add("matcha")

    rows = []
    for input_name, ligand_id in ligand_pairs:
        row = build_row(
            args.run_dir,
            args.case,
            args.receptor,
            input_name,
            ligand_id,
            methods_run,
            status_overrides,
            matcha_results,
        )
        row["boltz_receptor_includes_cofactors"] = args.cofactor_note
        rows.append(row)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: fmt(row.get(key, "")) for key in COLUMNS})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
