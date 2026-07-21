# Third-Party Notices

LP-Flow orchestrates separately installed scientific tools and does not
redistribute their binaries, model weights, checkpoints, or licenses.

| Component | Version/source | License | Distribution | Local path | Notes |
|---|---|---|---|---|---|
| Boltz-2 | Upstream project | Upstream terms | External | User-configured runtime | Optional co-folding/triage method. |
| Matcha | [LigandPro/Matcha](https://github.com/LigandPro/Matcha) | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | External | User-configured runtime | Optional; code, weights, and checkpoints retain upstream terms. |
| GNINA, SMINA, GROMACS, Open Babel | Upstream projects | Upstream terms | External | User-configured runtime | Not bundled or relicensed by LP-Flow. |
| Burrete | External Codex plugin | Upstream terms | External | Host-managed | Optional visualization handoff. |
| Mol View Stories 5.8.0 | [molstar/mol-view-stories](https://github.com/molstar/mol-view-stories) | MIT | Bundled compatibility asset | `assets/mvs-stories/5.8.0/` | Notice: `third_party/mol-view-stories-LICENSE.txt`; checksums: `docs/artifact-provenance.md`. |

Operators are responsible for verifying compatibility of force fields, model checkpoints, and external tool licenses in their own environment.
