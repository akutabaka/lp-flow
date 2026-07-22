# Installation

LP-Flow is an MIT-licensed Codex plugin. It requires Node.js 20 or newer,
an installed Codex or ChatGPT desktop host, and a marketplace entry.

## Git Marketplace

Register the public repository as a marketplace and install LP-Flow from the
Plugins Directory:

```bash
codex plugin marketplace add akutabaka/lp-flow --ref v0.1.0-rc.8
codex plugin marketplace list
```

The release tag provides a reproducible installation. Use `--ref main` only
when intentionally testing the current development channel.

Restart the ChatGPT desktop app, open **Plugins**, select **LP-Flow**, install
the plugin, and start a new chat. Verify that four skills and the `lp_flow_mcp`
server are visible, then call `lp_flow_plugin_status`.

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

LP-Flow does not bundle scientific engines, user credentials, compute profiles,
or Burrete. Configure those components in the user's environment.
