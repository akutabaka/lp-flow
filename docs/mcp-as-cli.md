# LP-Flow MCP / CLI

The public surface is for user-provided docking, scoring, MD, runtime checking,
and Burrete handoff workflows. It does not select bundled validation cases as
scientific inputs.

## CLI Families

Run from the plugin root:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 list-tools
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 run docking --config <config.yaml|json> --out-dir <package-dir>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 remote-command-plan --package-dir <package-dir> --profile-name <profile>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 remote-execute-step --package-dir <package-dir> --profile-name <profile> --step <step> --execute true
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lp-flow.ps1 md --help
```

`run docking` prepares a package; it does not mean remote docking has already
finished. The public execution path is `remote-command-plan` followed by
explicit `remote-execute-step` calls. Boltz and Matcha are campaign methods in
that package, not separate public MCP tools.

For heavy steps, use the configured scheduler when the profile declares one
(`scheduler: slurm`). The plan submits with `sbatch`, checks with `squeue`/status
artifacts, then hands off to Burrete before MD:

```text
upload -> preflight -> check_docking_scheduler -> run_docking_payload -> check_docking_payload_status
-> open_burrete_pose_review -> check_md_scheduler -> run_md_from_best_pose
-> check_md_from_best_pose_status -> open_burrete_trajectory_review
-> package_results -> download_archive
```

Use Burrete for ordinary molecular viewing, docking pose review, trajectory
playback, object-tree/debug layout, and visual QA.

## MCP Tools

Public:

- `lp_flow_plugin_status`
- `lp_flow_md_connect_check`
- `lp_flow_run_docking`
- `lp_flow_md_submit`
- `lp_flow_md_status`
- `lp_flow_md_log`
- `lp_flow_md_result`
- `lp_flow_md_analyze_tpr`
- `lp_flow_prepare_redocking_case`
- `lp_flow_remote_command_plan`
- `lp_flow_remote_execute_step`

Internal maintenance tools may appear only when internal discovery is
explicitly requested. A normal public MCP `tools/call` rejects tools outside
public visibility. Structures, poses, and trajectories are handed to Burrete
for visualization.

`open_burrete_pose_review` and `open_burrete_trajectory_review` are recorded
handoff gates. After the Burrete attempt, call the step with an exact
`handoff_status` and `execute=true`; the executor writes the run-local status
artifact. MD submission is blocked until pose review is recorded.

## Execution Policy

Execution configuration is external to the plugin. Scientific skills should use
the active configuration, report exact runtime checks, and avoid treating a
tool missing from one shell lookup as proof that the tool is unavailable.

Cleanup must be bounded to the active run/output directory. Shared software,
weights, and checkpoints are read-only unless the active configuration
explicitly says otherwise.
