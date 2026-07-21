# Changelog

All notable changes to LP-Flow are documented here.

## [0.1.0-rc.3] - 2026-07-21

- Relicensed LP-Flow under MIT and synchronized package, plugin, and skill metadata.
- Added LP-Flow architecture and workflow diagrams to the public README.
- Reorganized the README around workflow, quick start, capabilities, and Burrete integration.

## [Unreleased]

### Changed

- Changed the LP-Flow project license to MIT; third-party components retain their own terms.
- Redacted installation and configured-profile paths from ordinary plugin status output.
- Added concrete public MCP output schemas and bounded subprocess termination.
- Clarified the four-skill architecture, legacy profile discovery, marketplace scope, and optional Burrete availability.

- Prepared a portable, source-only release candidate.
- Switched `.mcp.json` to a direct server map and added MCP lifecycle/tool-risk checks.
- Added deterministic source archive packaging, checksum generation, archive hygiene, and extracted-artifact validation.
- Added marketplace installation instructions and documented Matcha's separate terms.

## [0.1.0-rc.1] - 2026-07-20

### Added

- Public CLI and MCP entrypoints for docking, MD, runtime discovery, and Burrete handoff.
- Focused skills for GNINA/SMINA, Boltz, Matcha, GROMACS, and runtime discovery.
- Contract tests and non-destructive execution smoke tests.

### Security

- Remote execution remains profile-scoped with explicit write and cleanup bounds.
- Credentials, private profiles, scientific outputs, model checkpoints, and bundled runtimes are excluded from release artifacts.
