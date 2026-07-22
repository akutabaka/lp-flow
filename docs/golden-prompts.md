# Golden Prompts

`tests/golden-prompts/lp-flow-golden-prompts.json` is the small, versioned
replay set for LP-Flow agent behavior. Each case records the user prompt, the
expected tool/skill trace, terminal artifacts, final-result requirements, and
forbidden outcomes.

Run `npm run test:golden` to validate encoding and shape, then replay each
expected route against the shipped skills and executable Burrete handoff
contract. This deterministic replay does not replace a model-level evaluation;
attach a captured model/tool trace and terminal artifact manifest before adding
a new real-workflow case.
