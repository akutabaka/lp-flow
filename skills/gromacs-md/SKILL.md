---
name: gromacs-md
description: >
  GROMACS-first molecular dynamics setup, execution, cleanup, analysis, and
  trajectory handoff to Burrete/Mol* visualization. Use for MD, equilibration,
  CPU smoke MD, RMSD/RMSF, protein-ligand MD, membrane MD, nucleic-acid MD,
  trajectory cleanup, explicitly requested production MD, and opening/reviewing
  MD trajectories, using the configured local/server profile.
license: MIT
metadata:
  lp-flow-compatibility: Requires LP-Flow, GROMACS, and a compatible ligand-parameterization path; GPU is optional.
  lp-flow-category: molecular-dynamics
  lp-flow-requirements: cpu, optional-gpu
  lp-flow-third-party: GROMACS and ligand-parameterization tools; see THIRD_PARTY_NOTICES.md.
---

# GROMACS MD

GROMACS is the default MD engine for this plugin: prepared coordinates and
topology in, smoke/equilibration structures, trajectories, metrics, and a
review package out. Heavy runs use a configured local/server profile; resolve
the GROMACS command, library environment, writable output, and CPU/GPU backend
before execution. Use another selected engine by name in the manifest.

## Running it
Set force field, water model, box, ions, restraints, thermostat, barostat,
timestep, output stride, and run length before writing MDP files. Ligand systems
also need charge, protonation, stereochemistry, and a parameter source. Stop
before topology generation if ligand chemistry is unknown. Membrane systems add
lipid composition, orientation, compatibility, restraints, and semi-isotropic
pressure coupling.

```bash
gmx --version
obabel -V
acpype -h
```

CPU smoke with the largest useful scope uses no GPU GRES:

```bash
LIGAND_CHARGE=<validated-integer-charge>
obabel ligand.smi -O ligand_clean.sdf --gen3d
acpype -i ligand_clean.sdf -b LIG -o gmx -c bcc -n "$LIGAND_CHARGE"
gmx pdb2gmx -f receptor_clean.pdb -o protein.gro -p topol.top -water tip3p
# assemble/verify complex.gro from protein.gro plus placed ligand coordinates
gmx editconf -f complex.gro -o boxed.gro -c -d 1.0 -bt dodecahedron
gmx solvate -cp boxed.gro -cs spc216.gro -p topol.top -o solv.gro
gmx grompp -f ions.mdp -c solv.gro -p topol.top -o ions.tpr
gmx genion -s ions.tpr -o solv_ions.gro -p topol.top -neutral
gmx grompp -f em.mdp -c solv_ions.gro -p topol.top -o em.tpr
gmx mdrun -deffnm em -nb cpu -pme cpu
gmx grompp -f nvt.mdp -c em.gro -r em.gro -p topol.top -o nvt.tpr
gmx mdrun -deffnm nvt -nb cpu -pme cpu
gmx grompp -f npt.mdp -c nvt.gro -r nvt.gro -p topol.top -o npt.tpr
gmx mdrun -deffnm npt -nb cpu -pme cpu
```

Minimal CPU smoke may stop after EM plus short NVT. Fuller CPU smoke adds NPT,
cleanup, energy/temperature/pressure, RMSD, and contacts. Production MD is a
separate explicit run mode.

## Assembly

For docked ligands:

```text
clean ligand chemistry -> ligand topology
docked pose            -> ligand placement coordinates
```

Before `grompp`, check atom mapping, molecule counts, include order, coordinate
atom count, and protein/ligand force-field compatibility.

Use the reviewed docking pose when available; otherwise name the pose source in
the run manifest.

## Cleanup

Clean trajectories before interpretation: make molecules whole, center, fit,
and write compact no-bulk-water exports. Include water only for water-centered
analysis. Generate the Burrete display PDB from trajectory frames:

```bash
gmx select -s md.tpr -select 'Protein or resname LIG' -on preview_nowater.ndx
gmx trjconv -s md.tpr -f md_clean.xtc -n preview_nowater.ndx \
  -o md_nowater_multimodel.pdb -dt 10
```

## Review package

Use explicit structure, trajectory, selection, and output-prefix fields for
analysis jobs. Display is separate from native trajectory provenance:

| Role | Example file | Use |
|---|---|---|
| display | `md_nowater_multimodel.pdb` | Burrete/Mol* preview |
| preview metadata | `preview_nowater.json` | selectors, frame stride, ligand names |
| metrics | `rmsd_backbone.xvg`, `temperature.xvg` | interpretation |
| provenance | `md.tpr`, `md_clean.xtc`, `topol.top` | analysis/reproducibility |
| snapshot | `em.gro`, `nvt.gro` | stage snapshot only |

## Outputs

Write `trajectory_manifest.json` with display PDB, preview metadata, native
topology/trajectory, original ligand ID, simulation residue name, selectors,
engine, backend, completed stages, and terminal statuses:

```csv
stage,status,artifact,error,log_file
em,ok,em.gro,,logs/mdrun_em.log
nvt,blocked,,grompp failed,logs/grompp_nvt.log
visualization,unavailable,,Burrete target unavailable,logs/burrete_preflight.log
```

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `error while loading shared libraries: libplumedKernel.so: cannot open shared object file` | Load the configured GROMACS library environment. |
| `Residue XXX not found in residue topology database` / `Atom X in residue YYY not found in rtp entry` | Clean receptor; parameterize ligands separately. |
| `Number of coordinates in coordinate file does not match topology` / non-matching atom names | Check atom counts, `[ molecules ]`, molecule order, include order, solvation, and ions. |
| `Invalid order for directive atomtypes` | Move ligand atomtypes/includes before molecule definitions. |
| `Total number of electrons ... is odd` | Fix validated ligand charge/spin before `acpype`/Antechamber. |
| `Atoms TOO close (< 0.5 Ang.)` | Rebuild clean ligand chemistry and map docked placement separately. |

---

Open the no-water multi-frame display PDB in Burrete and keep native
trajectory/topology files beside it for interpretation.
