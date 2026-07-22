# Validation

LP-Flow separates portable CI checks from host integration evidence.

## Portable CI

Ubuntu and Windows run static validation, release hygiene, MCP conformance,
public and skill contracts, golden prompts, dry-run execution smoke tests, and
source-package replay. The suite reports the Burrete host result separately as
`PASSED`, `SKIPPED`, or `FAILED`.

## Burrete host integration

On 2026-07-22, the required host test passed on Windows against installed
Burrete `0.1.4+codex.20260721120000`. It started the real Burrete MCP process,
confirmed `open_burrete_docking_view`, `burrete.open_workspace`, and
`validate_trajectory_review_artifact`, and validated a two-frame trajectory
artifact.

Run the required check in an environment with Burrete installed:

```powershell
$env:LP_FLOW_REQUIRE_BURRETE_HOST = '1'
node tests/integration/check_burrete_host_integration.mjs
```

An ordinary hosted CI runner has no Burrete installation and therefore reports
`BURRETE_HOST_STATUS=SKIPPED`; that result is not integration evidence.
