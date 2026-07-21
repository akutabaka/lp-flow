# LP-Flow Architecture

LP-Flow is a portable Codex plugin for molecular workflow preparation, staged
execution, result inspection, and visualization handoff. It ships no scientific
engine, credentials, private profile, or machine-specific writable root.

## Skills

- **Boltz**: co-folding, confidence interpretation, and optional affinity
  triage for protein, nucleic-acid, and ligand complexes.
- **GNINA/SMINA**: prepared receptor-ligand docking, redocking, rescoring, and
  pose packages.
- **Matcha**: optional learned scoring for existing receptor-ligand poses when
  its checkout, checkpoints, and parser are configured.
- **GROMACS MD**: topology-aware molecular-dynamics setup, staged execution,
  cleanup, and analysis.

The four skills are self-contained. Runtime/profile discovery is a shared MCP
and CLI layer, not a separate public skill.

## Runtime and Profiles

The user supplies a private profile that names the available local or remote
runtime and writable work root. LP-Flow validates profile fields, builds argv
based plans, and keeps credentials and private hosts outside the plugin bundle.
Legacy `%APPDATA%\\LP-FlowDocking` profiles are read-only discovery only; new
profiles belong under `%USERPROFILE%\\.config\\lp-flow` on Windows or
`~/.config/lp-flow` on Unix-like systems.

## MCP and CLI

`scripts/lp-flow.mjs` provides the same public workflow surface through MCP
stdio and the CLI. Public calls prepare packages, inspect plans, submit approved
stages, and read results. Cleanup is deliberately not executable through MCP.

## Data Flow and Trust Boundaries

```text
user input
  -> plugin validation
  -> local run package
  -> private profile and approved execution
  -> scientific artifacts and manifests
  -> Burrete handoff or recorded unavailable status
```

Input validation and run-package generation happen locally. Private profiles,
remote paths, credentials, scheduler settings, and scientific engines remain in
the user environment. Scientific artifacts stay under the configured run root.

## Visualization Handoff

LP-Flow prepares docking-pose and trajectory display packages for Burrete.
Burrete is an external optional integration and may not be publicly available.
When it cannot open a package, LP-Flow retains the scientific artifacts and
returns `visualization_status: unavailable`; that status is distinct from a
scientific method failure.

## Source Release Validation

The source release excludes runtimes, dependencies, profiles, generated
artifacts, and archives. The test suite checks static syntax, source hygiene,
MCP protocol behavior, public tool contracts, skills, golden prompts, execution
smoke behavior, and an extracted source-package replay.
