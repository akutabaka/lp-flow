# LP-Flow

Project home: [github.com/akutabaka/lp-flow](https://github.com/akutabaka/lp-flow).

`lp-flow` is a reusable Codex MCP/CLI plugin for protein-ligand
docking workflows, Boltz scoring/cofolding, molecular-dynamics job control, and
Burrete handoff.

## Distribution And Installation

This release candidate is source-available for non-commercial use. It requires
Node.js 20 or newer and an installed Codex host. Follow the exact local or Git
marketplace procedure in [Installation](docs/installation.md), then begin a new
Codex session so its skills and MCP server are discovered. Verify the local
source before or after installation with:

```bash
node scripts/lp-flow.mjs status
node scripts/lp-flow.mjs list-tools
```

LP-Flow does not bundle scientific engines, credentials, model weights, or
external visualization software.

The plugin provides run-package helpers, docking-result inspection, and
Burrete-ready outputs. It ships code, manifests, docs, scripts, skills, and
viewer handoff helpers.
Scientific datasets, user run artifacts, downloaded inputs, and generated
stories live in user-selected output folders.

Users provide all scientific inputs explicitly. Generated outputs go to
user-provided output directories.

Interactive molecular visualization, pose review, trajectory review, and scene
controls use Burrete by default. The visualization flow is:

```text
Burrete plugin -> handoff package -> open attempt -> link/status in chat
```

PNGs remain report thumbnails. A completed visualization has an opened Burrete
workspace link/status; a package that cannot be opened remains unavailable or
pending, not completed.

## Visualization Dependency

Burrete is an external Codex visualization plugin, not part of LP-Flow. LP-Flow
prepares receptor/pose and trajectory display packages, requests the Burrete
handoff, and reports its link or exact unavailable status. Without an available
Burrete target, LP-Flow retains the package and reports that visualization was
not opened; this does not invalidate otherwise completed docking or MD outputs.
Legacy Mol* story helpers are compatibility-only and are not the ordinary
visualization route.

## Command Families

- `run docking` - create local docking run packages from explicit configs.
- `md ...` - submit explicit run-local MD scripts, inspect logs/results,
  analyze TPR files, and write trajectory review manifests.
- `plugin_status` / `list-tools` - inspect the public MCP/CLI surface.

Deprecated compatibility aliases are hidden from normal help and emit warnings
when used.

Low-level `build-*`, execution helper, and planned/guarded modes are available
only through direct compatibility routes and `--help --advanced` /
`--help --internal`.

## Public API Contract Check

Run the local public API contract test from the plugin root:

```powershell
node .\tests\contracts\check_public_contract.mjs
```

The check verifies the compact Phase 1 CLI/MCP surface, public schemas,
planned-mode guards, deprecated-alias warnings, and source-tree artifact hygiene.

## Pipeline Skills Contract Check

Run the lightweight full-pipeline skill contract check from the plugin root:

```powershell
node .\tests\contracts\check_pipeline_skills_contract.mjs
```

The check verifies source/cache skill sync, focused Boltz/Matcha/docking/MD
trigger wording, docking -> MD -> Burrete handoff instructions, and public
CLI discovery. It also checks completion contracts for visualization requests:
static files alone are not completed visualization without a Burrete link or
exact open status. It does not run docking, MD, server, SSH, browser, or
visualization workflows.

## Pipeline Execution Smoke Check

Run the local execution smoke check from the plugin root:

```powershell
node .\tests\execution\check_pipeline_execution_smoke.mjs
```

The check creates a temporary receptor/ligand/config/profile, executes the
public `run docking` package-generation path, validates dry-run remote execution
steps, validates Slurm test-only/GRES planning, MD review gates and dry-run
submission, and checks trajectory artifact QC. It does not start real docking,
MD, SSH, Slurm jobs, browser, or viewer
servers by default. Add `--allow-viewer-server` to also start a temporary local
trajectory viewer smoke test.

Detailed user and developer documentation lives in `docs/`. Skills stay compact:
each focused skill is a `SKILL.md` with optional agent metadata.

LP-Flow requires Node.js 20 or newer. Scientific engines are supplied by the
execution environment rather than bundled with the plugin.

## License

LP-Flow is source-available under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): it may be shared and adapted with attribution for non-commercial use. It is not described as OSI open-source software.
Third-party tools and models retain their own terms.

Docking, runtime, and MD helper scripts live under plugin-level `scripts/`.
The built-in MD lane records its exact force-field protocol and never claims
equivalence to a named external tutorial without its required force-field inputs.
