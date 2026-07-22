# Quickstart

## 1. Requirements

Use Node.js 20 or newer and a Codex installation that can load local plugins.
LP-Flow does not bundle Node.js, docking engines, model weights, or
visualization software.

## 2. Install And Verify

LP-Flow is released under the [MIT License](../LICENSE). Follow
[Installation](installation.md) to add it to a local marketplace, install it,
and begin a new Codex session. Verify the source entrypoint before or after
installation:

```bash
node scripts/lp-flow.mjs status
node scripts/lp-flow.mjs list-tools
```

## 3. Prepare A Non-Executing Docking Package

Create an explicit docking config with receptor, ligand, binding box, methods,
and output directory. Then prepare the package through the public route:

```bash
node scripts/lp-flow.mjs run docking --config docking.json --out-dir run-package
```

Package generation does not claim docking completion. Inspect the resulting
manifest and dry-run plan before any remote execution.

## 4. Visualization

Burrete is an external Codex plugin. LP-Flow writes `burrete_request.json` for
docking and MD packages. Record the result with `lp-flow burrete receipt`;
success requires `workspaceSessionId`, ready document/viewer state, a URL, and
visual-QA evidence. Scientific package generation and visualization status are
reported separately.
