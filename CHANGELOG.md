# Changelog

All notable changes to LP-Flow are documented here.

## [Unreleased]

## [0.1.0-rc.4] - 2026-07-22

- Added a real Codex-to-Burrete workflow screenshot as the README hero.
- Replaced the linear workflow artwork with an architecture diagram that shows
  docking, Boltz, Matcha, and GROMACS as distinct calculation lanes.
- Removed the bundled MolViewStories, CellPACK, PyMOL, and local trajectory
  viewer compatibility layer from the CLI, MCP surface, source tree, tests,
  notices, and release package.
- Reduced the source release while preserving docking, MD, scheduler, manifest,
  scientific parsing, Burrete handoff, security, and CI coverage.
- Aligned `.mcp.json` with the standard Codex `mcpServers` plugin manifest.

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
