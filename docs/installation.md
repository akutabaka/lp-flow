# Installation

LP-Flow is a source-available Codex plugin. It requires Node.js 20 or newer,
an installed Codex or ChatGPT desktop host, and a marketplace entry.

## Local Marketplace

Create a marketplace root with this layout:

```text
marketplace-root/
  .agents/plugins/marketplace.json
  plugins/lp-flow/
```

Copy this repository into `plugins/lp-flow/`, then copy
`examples/marketplace.json` to `.agents/plugins/marketplace.json`. The
`source.path` in that file is relative to `marketplace-root`.

Register the marketplace from Codex CLI:

```bash
codex plugin marketplace add <absolute-path-to-marketplace-root>
codex plugin marketplace list
```

Restart the ChatGPT desktop app. In Work mode or Codex, open **Plugins**, select
**LP-Flow Local**, install **LP-Flow**, and start a new chat. Verify the
installation with `lp_flow_plugin_status` and a non-executing
`lp_flow_run_docking` package request.

## Shared Git Marketplace

This repository is the plugin source, not a published marketplace repository.
Until LP-Flow publishes a separate marketplace with a real URL and a tested
installation command, use the local marketplace procedure above. Do not assume
that `codex plugin marketplace add <owner>/lp-flow` is supported.

LP-Flow does not bundle scientific engines, user credentials, compute profiles,
or Burrete. Configure those components in the user's environment.
