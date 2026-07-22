# Security Policy

Report vulnerabilities through GitHub's
**Private vulnerability reporting** form. The maintainer will acknowledge a
valid report within 14 days and coordinate a fix before public disclosure.

Do not include passwords, private keys, tokens, SSH configuration, or private
scientific inputs in a report. Include a minimal reproduction, affected command
or file, impact, and redacted logs.

Private vulnerability reporting is enabled for this public repository. Do not
disclose suspected vulnerabilities in public issues or pull requests.

## Execution Boundary

LP-Flow builds bounded run packages and command plans; execution authorization,
credentials, profiles, scientific engines, and writable roots remain outside
the repository. External commands must stay within the configured run root.
Shared software and model weights are treated as read-only.

Remote cleanup is not exposed as a public MCP action. The bundled cleanup
helper rejects empty, relative, parent-traversing, root-equal, and out-of-bound
paths and is intended only after result downloads are confirmed.
