# Third-Party Notices

LP-Flow orchestrates separately installed scientific tools and does not
redistribute their binaries, model weights, checkpoints, or licenses.

| Component | Version/source | License | Distribution | Local path | Notes |
|---|---|---|---|---|---|
| Boltz-2 | Upstream project | Upstream terms | External | User-configured runtime | Optional co-folding/triage method. |
| Matcha | [LigandPro/Matcha](https://github.com/LigandPro/Matcha) | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | External | User-configured runtime | Optional; code, weights, and checkpoints retain upstream terms. |
| GNINA, SMINA, GROMACS, Open Babel | Upstream projects | Upstream terms | External | User-configured runtime | Not bundled or relicensed by LP-Flow. |
| Burrete | External Codex plugin | Upstream terms | External | Host-managed | Optional visualization handoff. |

Operators are responsible for verifying compatibility of force fields, model checkpoints, and external tool licenses in their own environment.

## Validation matrix

The following versions were observed in dated LP-Flow validation runs. They are
compatibility evidence, not bundled dependencies or minimum-version guarantees.

| Component | Observed version | Validation scope |
|---|---|---|
| SMINA | 2019-10-15 build, based on AutoDock Vina 1.1.2 | Docking and rescoring |
| Open Babel | 3.1.1 | Ligand conversion and preparation |
| GROMACS | 2022.5 with PLUMED 2.9.3 | Protein-ligand EM and short equilibration |
| ACPYPE | 2023.10.27 | Ligand topology generation |
| Burrete | 0.1.4+codex.20260721120000 | Docking-pose and trajectory host integration |

GNINA, Boltz, and Matcha versions depend on the active external profile. LP-Flow
records their emitted version or status when available and does not claim a
validated version when the backend does not expose one.
