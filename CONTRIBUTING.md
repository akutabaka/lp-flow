# Contributing

Use Node.js 20 or newer. Run `npm test` before opening a change.

Keep scientific workflows out of tests unless the test explicitly targets a disposable backend. Do not add credentials, private profiles, run outputs, trajectories, model checkpoints, or bundled executables to source control.

Changes to public MCP tools, CLI help, schemas, or skills require matching contract or eval coverage.
