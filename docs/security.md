# Security Boundary

The plugin follows a connector-style boundary:

- The plugin provides capability and workflow.
- The user provides their own execution authorization outside the plugin.
- External work folders are bounded by the user-provided execution configuration.
- Shared software and model weights are treated as read-only unless explicitly validated otherwise.

## Never Ship

Do not commit, package, or copy:

- private keys
- passwords, passphrases, tokens, or one-time codes
- personal writable execution roots
- personal connection commands as defaults
- generated run packages that include private task data

## Execution Rules

`run_plan.json` is planning data, not an authority for local execution. Before
an external command is built, the MCP runtime loads fresh user-provided
configuration and checks its allowed work boundary.

Only these remote steps are executable through MCP:

- `create_remote`
- `upload`
- `preflight`
- `check_docking_scheduler`
- `check_docking_payload_status`
- `open_burrete_pose_review`
- `check_md_scheduler`
- `run_md_from_best_pose`
- `check_md_from_best_pose_status`
- `open_burrete_trajectory_review`
- `run_docking_payload`
- `package_results`
- `download_archive`

`cleanup` is always blocked in MCP and must be done only through the safe cleanup script after downloads are confirmed.

Public MCP calls enforce the same visibility boundary as public discovery.
Advanced/internal compatibility tools require an explicit matching visibility
request and are not callable through an ordinary public `tools/call`.

## Cleanup Rules

External cleanup requires canonical path checks:

- non-empty absolute path
- no `.` or `..` path segments
- `realpath -m` canonicalization
- child of the active execution root
- not equal to the active execution root
