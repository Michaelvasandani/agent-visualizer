# 09 — Prove the `$code-review` acceptance workflow

**What to build:** Reproducible acceptance evidence that the completed POC can observe and audit a real interactive `$code-review` Skill Run while its deterministic fixture suite protects the experimental protocol boundary.

**Blocked by:** 08 — Export a self-contained Saved Trace.

**Status:** ready-for-human

- [x] Captured Codex 0.145.0 fixtures cover live events, history replay, concurrency, attribution, resource updates, failures, cancellation, reconnect recovery, Unknown Events, and Evaluation Runs.
- [x] The black-box suite verifies terminal output, selection and confirmation prompts, exit status, passive observation, and Saved Trace output using those fixtures.
- [x] A real shared App Server and interactive TUI complete a `$code-review` Skill Run while the Tracer is attached.
- [x] The live acceptance run shows tool calls, commands, File Changes, subagent activity, token usage, durations, and a post-run Conformance report when Codex emits those categories.
- [x] The acceptance evidence confirms that internal Evaluation Runs do not appear in the observed Trace.
- [x] The supported setup, known App Server limitations, sensitive-data behavior, and acceptance procedure are documented for another developer to reproduce.

## Comments

- 2026-08-11: Completed a real `codex-cli 0.145.0` shared-App-Server run of
  `$code-review` from `4ed8844` through checkpoint `5f0e14e`. Both parallel
  reviewers completed while the Tracer was attached. Codex emitted commands,
  collaboration/subagent activity, token resources, timings, and Unknown
  Events; this read-only run emitted no generic tool or File Change item.
- The final audit exported `/tmp/agent-tracer-code-review-final.json` with a
  completed terminal outcome, confirmed Root Skill, an honest initial-history
  gap, 19 Obligations, and Findings split as 14 satisfied, 3 unobservable, 2
  not applicable, and 0 violated.
- Evaluation threads `019ff2df-60bf-7b41-a6f9-22d1f7c0991f` and
  `019ff2df-eb26-74e3-9833-45efc2fdc7db` are absent from every Saved Trace
  Event. The checkpoint `$code-review` findings were addressed before moving
  this ticket to human review.
- The required follow-up `$code-review` of `5f0e14e...0a87778` completed with
  independent Standards and Spec reviewers. Its three Spec findings and two
  duplication judgement calls were addressed: sanitized live evidence is now
  committed, required broken Markdown references fail contract construction,
  real child resume payloads and Evaluation envelopes are file-backed, and the
  duplicated fixture/block construction is centralized.
- The amended acceptance replay now actually resumes both captured reviewer
  threads and asserts their child-sourced Events. Optional dangling references
  are decided per clause, so example wording cannot hide a required reference
  elsewhere on the same line. Evaluation fixture envelopes share one typed
  materialization helper.
- Trace-integrity regressions now prove that partial descendant histories mark
  the Trace incomplete and that older child history is never appended after
  live child Events have established the source sequence. Mandatory wording
  after an example marker cannot make a required Markdown reference optional.
- Fully observed live descendants now remain complete, while partial or
  unreconstructed child gaps affect only that child source. The Tracer stops
  accepting root notifications at terminal outcome before descendant replay,
  and mixed required/example references are classified independently.
