---
name: matcha-scoring
description: >
  Matcha pose/interaction scoring for explicit receptor-ligand pose inputs when
  Matcha runtime, checkpoints, and parser support are available. Use to score
  existing poses, compare Matcha with GNINA/SMINA/Boltz outputs, or add Matcha
  fields to a docking summary through the configured profile/checkpoints.
license: CC-BY-NC-4.0
metadata:
  lp-flow-compatibility: Requires LP-Flow plus a configured Matcha checkout, checkpoints, parser support, receptor, and pose inputs.
  lp-flow-category: docking
  lp-flow-requirements: checkpoints, optional-gpu
  lp-flow-third-party: Matcha is CC-BY-NC-4.0; see THIRD_PARTY_NOTICES.md.
---

# Matcha Scoring

Matcha is optional and profile-backed. Install/reference:
github.com/LigandPro/Matcha#installation. Use it when the active runtime
provides the Matcha checkout, Python entrypoint, checkpoints, receptor, and pose
files. Heavy runs use a configured local machine or server profile. Resolve
commands, versions, writable output directory, and accelerator availability.
Matcha is licensed under CC BY-NC 4.0; retain attribution and use its runtime
and checkpoints only under its non-commercial terms.

## Running it

As a profile-backed docking campaign method:

```yaml
methods: [matcha]
matcha_samples: 10
```

```bash
lp-flow run docking --config docking.yaml --out-dir docking_run/
```

Public CLI after repository install:

```bash
uv run matcha -r protein.pdb -l ligand.sdf -o results/
```

Or with the configured/internal Matcha entrypoint:

```bash
python -m matcha.cli \
  --receptor receptor.pdb \
  --ligand poses.sdf \
  --out matcha_out/ \
  --run-name lig1_matcha \
  --n-samples 10 \
  --checkpoints checkpoints/ \
  --scorer gnina
```

Outputs come from the available Matcha parser or the raw Matcha files.

## Input QC

Set receptor `.pdb`, pose `.sdf/.mol2`, checkpoint path or profile key, parser
availability, and device before running. For remote/profile runs, stage receptor
and ligand files into the run package and pass runtime-visible paths.

## Outputs

Use fields emitted by Matcha, for example:

```csv
ligand_id,matcha_status,matcha_best_pose,matcha_total_sec,matcha_score_fields,matcha_error
lig1,ok,matcha/lig1_matcha_best.sdf,42.1,minimizedAffinity;minimizedCNNscore,
```

Keep Matcha output in `matcha_*` columns. Empty parser fields stay empty;
`matcha_status` and `matcha_error` carry the run state.

If `matcha_best_pose` exists, keep it as a downstream pose artifact even when
optional parser or GNINA-backed score fields are unavailable:

```csv
ligand_id,matcha_status,matcha_best_pose,downstream_pose_status
lig1,ok,matcha/lig1_matcha_best.sdf,usable
```

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `Matcha requested but matcha_checkout is missing from profile/input` | Active profile lacks Matcha checkout; set `matcha_status=unavailable` for Matcha. |
| `Matcha requested but matcha_python is missing from profile/input` | Active profile lacks Matcha Python entrypoint; set `matcha_status=unavailable` for Matcha. |
| `Matcha requested but matcha_checkpoints is missing from profile/input` | Active profile lacks checkpoints; set `matcha_status=unavailable` for Matcha. |
| `FileNotFoundError: [Errno 2] No such file or directory` | Matcha received a bad relative/absolute receptor or ligand path; rerun with valid paths. |
| `matcha best pose not found` | Matcha ran but no expected best-pose SDF was found; use raw logs and set `matcha_status=failed`. |

---

Write parsed Matcha fields into the shared summary table and keep
`matcha_best_pose` as a pose artifact when it exists.
