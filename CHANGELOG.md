# Changelog

All notable changes to LP-Flow are documented here.

## [Unreleased]

- Changed tag automation to verify and attest release assets without publishing
  GitHub Releases under the `github-actions` identity.

## [0.1.0-rc.7] - 2026-07-22

- Switched `.mcp.json` to the documented direct server-map format.
- Added a Git-backed marketplace entry and reproducible public install command.
- Added MCP subprocess cancellation and explicit Burrete host PASS/SKIPPED status.
- Added a dated installed-Burrete validation record and external-tool matrix.
- Pinned CI actions to immutable commit SHAs and added CodeQL, Dependabot, and
  release-asset provenance attestation.

## [0.1.0-rc.6] - 2026-07-22

- Added typed `burrete_request.json` generation for docking and MD review.
- Added CLI/MCP receipt validation with workspace, readiness, URL, and visual-QA evidence.
- Replaced declarative viewer targets with installed Burrete tool recommendations.
- Added an installed-Burrete host integration test and compatibility aliases for rc.5 step names.

## [0.1.0-rc.5] - 2026-07-22

- Removed unused profile, case-discovery, input-validation, and MCP launcher
  duplicates from the public source tree.
- Consolidated the execution security boundary into `SECURITY.md` and removed
  stale private-repository and legacy-viewer wording.

## [0.1.0-rc.4] - 2026-07-22

- Added a real Codex-to-Burrete workflow screenshot as the README hero.
- Replaced the linear workflow artwork with an architecture diagram that shows
  docking, Boltz, Matcha, and GROMACS as distinct calculation lanes.
- Removed the bundled MolViewStories, CellPACK, PyMOL, and local trajectory
  viewer compatibility layer from the CLI, MCP surface, source tree, tests,
  notices, and release package.
- Reduced the source release while preserving docking, MD, scheduler, manifest,
  scientific parsing, Burrete handoff, security, and CI coverage.
- Added the first bundled MCP configuration for the LP-Flow server.

## [0.1.0-rc.3] - 2026-07-21

- Relicensed LP-Flow under MIT and synchronized package, plugin, and skill metadata.
- Added LP-Flow architecture and workflow diagrams to the public README.
- Reorganized the README around workflow, quick start, capabilities, and Burrete integration.

- Redacted installation and configured-profile paths from ordinary plugin status output.
- Added concrete public MCP output schemas, source archive validation, and bounded subprocess termination.
- Documented the four-skill architecture, marketplace installation, Matcha terms,
  legacy profile discovery, and optional Burrete availability.

## [0.1.0-rc.1] - 2026-07-20

### Added

- Public CLI and MCP entrypoints for docking, MD, runtime discovery, and Burrete handoff.
- Focused skills for GNINA/SMINA, Boltz, Matcha, GROMACS, and runtime discovery.
- Contract tests and non-destructive execution smoke tests.

### Security

- Remote execution remains profile-scoped with explicit write and cleanup bounds.
- Credentials, private profiles, scientific outputs, model checkpoints, and bundled runtimes are excluded from release artifacts.
