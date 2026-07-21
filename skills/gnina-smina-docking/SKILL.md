---
name: gnina-smina-docking
description: >
  Classical protein-ligand docking, redocking, rescoring, and docking-pose
  preparation with GNINA and SMINA. Use for explicit binding boxes, existing
  pose rescoring, GNINA CNN fields, SMINA/Vina-style scores, and top-pose
  packages for Burrete/Mol* review or later dynamics through the configured
  local machine/server profile.
license: MIT
metadata:
  lp-flow-compatibility: Requires LP-Flow and configured GNINA or SMINA tooling; GNINA CNN scoring may require GPU support.
  lp-flow-category: docking
  lp-flow-requirements: cpu, optional-gpu
  lp-flow-third-party: GNINA, SMINA, and Open Babel; see THIRD_PARTY_NOTICES.md.
---

# GNINA / SMINA Docking

GNINA provides docking/scoring with CNN fields. SMINA is the lightweight
Vina-style cross-check. Both need a prepared receptor, prepared ligand, and
explicit search box. Heavy batches use a configured local/server profile and
resolve commands, versions, output, and CPU/GPU backend before execution.

## Running it
Plugin route:

```bash
lp-flow run docking --config docking.yaml --out-dir docking_run/
```

Direct docking:

```bash
gnina --receptor receptor.pdbqt --ligand ligand.sdf \
  --center_x 0 --center_y 0 --center_z 0 \
  --size_x 20 --size_y 20 --size_z 20 \
  --num_modes 10 --out poses.sdf --log gnina.log

smina --receptor receptor.pdbqt --ligand ligand.pdbqt \
  --center_x 0 --center_y 0 --center_z 0 \
  --size_x 20 --size_y 20 --size_z 20 \
  --exhaustiveness 8 --num_modes 10 \
  --out poses.sdf --log smina.log
```

Existing pose scoring:

```bash
gnina --receptor receptor.pdbqt --ligand pose.sdf --score_only --log score.log
smina --receptor receptor.pdbqt --ligand pose.sdf --score_only --log score.log
```

Define the box from a co-crystal/reference ligand, residue list, manual
center/size, or configured pocket detector.

## Input QC

```yaml
receptor: receptor.pdbqt
receptor_prep: prepared/protonated receptor source
ligand: ligand.sdf
box_source: reference_ligand | residues | manual | pocket_detector
box_center_angstrom: [0, 0, 0]
box_size_angstrom: [20, 20, 20]
ligand_charge: 0
ligand_state: neutral/protonation/tautomer/stereo notes
exhaustiveness: 8
seed: 20260710
```

A ligand-bound reference may define an apo receptor box:

```yaml
receptor: apo_target_prepared.pdbqt
box_source: reference_ligand
reference_ligand: cocrystal_ligand.sdf
```

## Outputs

Write pose files, raw logs, and one method-status table as `summary_wide.csv`:

```csv
ligand_id,engine,status,affinity,cnn_pose_score,cnn_affinity,pose_file,log_file,box_source
lig1,smina,ok,-8.1,,,smina/lig1_poses.sdf,logs/lig1_smina.log,reference_ligand
lig1,gnina,failed,,,,,logs/lig1_gnina.log,reference_ligand
```

Open the selected/top pose or pose collection in Burrete and record the result
beside the docking package:

```text
docking package: receptor context + pose files + score table
review output: Burrete link/status in report
```

Docking, CNN, and Vina-style scores rank poses for review; they are not measured
binding free energies.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `error while loading shared libraries: libcudnn.so.9: cannot open shared object file` | GNINA CUDA runtime is incomplete; keep GNINA `status=failed` and run/keep SMINA separately. |
| `Failed to kekulize aromatic bonds in OBMol::PerceiveBondOrders` | Open Babel could not assign aromatic bond orders cleanly; inspect chemistry before downstream use. |
| `score_only: mode 1 table row not found` | Parser did not find the expected docking table; preserve raw log and set method status from the log. |
| `No such file or directory` while reading receptor/ligand/pose or writing output | Resolve configured input/output paths and record the missing path in method status. |

---

Open the selected/top poses in Burrete, then use the reviewed pose for the next
requested analysis.
