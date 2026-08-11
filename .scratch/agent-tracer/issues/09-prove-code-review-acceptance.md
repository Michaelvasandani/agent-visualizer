# 09 — Prove the `$code-review` acceptance workflow

**What to build:** Reproducible acceptance evidence that the completed POC can observe and audit a real interactive `$code-review` Skill Run while its deterministic fixture suite protects the experimental protocol boundary.

**Blocked by:** 08 — Export a self-contained Saved Trace.

**Status:** ready-for-agent

- [ ] Captured Codex 0.145.0 fixtures cover live events, history replay, concurrency, attribution, resource updates, failures, cancellation, reconnect recovery, Unknown Events, and Evaluation Runs.
- [ ] The black-box suite verifies terminal output, selection and confirmation prompts, exit status, passive observation, and Saved Trace output using those fixtures.
- [ ] A real shared App Server and interactive TUI complete a `$code-review` Skill Run while the Tracer is attached.
- [ ] The live acceptance run shows tool calls, commands, File Changes, subagent activity, token usage, durations, and a post-run Conformance report when Codex emits those categories.
- [ ] The acceptance evidence confirms that internal Evaluation Runs do not appear in the observed Trace.
- [ ] The supported setup, known App Server limitations, sensitive-data behavior, and acceptance procedure are documented for another developer to reproduce.
