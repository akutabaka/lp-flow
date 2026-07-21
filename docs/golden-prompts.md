# Golden Prompts

`tests/golden-prompts/lp-flow-golden-prompts.json` is the small, versioned
replay set for LP-Flow agent behavior. Each case records the user prompt, the
expected tool/skill trace, terminal artifacts, final-result requirements, and
forbidden outcomes.

Run `npm run test:golden` to validate its shape. Replay prompts in dry-run mode
first; attach a captured tool trace and terminal artifact manifest before adding
a new real-workflow case.
