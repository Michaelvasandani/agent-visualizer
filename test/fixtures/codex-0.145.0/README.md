# Codex 0.145.0 protocol fixtures

This directory records the experimental App Server boundary supported by the
POC. `live-code-review.json` is a sanitized capture from a real
`codex-cli 0.145.0` shared App Server, interactive TUI, and explicitly invoked
`$code-review` turn. Sanitization changes values, not method names or payload
shape. It includes the parent activity plus `thread/resume` responses captured
from both completed reviewer children, preserving their parent linkage and
subagent source metadata. The black-box server serves those child responses
when the Tracer passively resumes the causally reported descendants, and the
test asserts that both child histories become child-sourced Events in the
export. The fixture deliberately retains an unfamiliar notification so the
captured protocol inventory includes an Unknown Event; because it has no turn
identifier, the Tracer excludes it from a pinned Skill Run.
`live-failure-recovery.json` is a second sanitized real shared-App-Server
capture from sacrificial threads outside the observed acceptance run. It
records an invalid-model failure, an interrupted turn, a client disconnect
followed by `thread/resume`, and a completed structured-output Evaluation Run.
`fault-injection.json` remains deterministic harness input for additional edge
cases; it is not represented as a live capture.

`live-code-review-saved-trace.json` is the sanitized, self-contained export
from the completed manual acceptance workflow. It retains exactly one parent
turn and one causally spawned work turn from each reviewer, along with
the terminal outcome, honest initial-history gap, exact
Event/Obligation/Finding counts, and observed source identities while replacing
local paths and opaque identifiers.

The black-box tests in `test/cli.test.ts` replay captured 0.145.0 envelopes and
script deterministic edge conditions. The literal failure/recovery fixture is
replayed separately from synthetic unrecoverable-history cases so provenance
remains explicit.

| Protocol behavior | Black-box fixture test |
| --- | --- |
| Captured live prompt, command, resource, duration, Unknown Event, parallel reviewer activity and child-source history, history-only attribution, evaluation isolation, export | `replays the captured 0.145.0 code-review fixture through the black-box boundary` |
| Live tools, commands, selection, terminal output, exit status, passive requests | `traces the only loaded thread through a fake App Server` |
| History replay and history/live deduplication | `replays history before live activity without duplicating Events` |
| Multiple-thread selection prompt | `requires an explicit selection when multiple threads are loaded` |
| Exact live and confirmed historical attribution | `uses exact live Root Skill metadata...`; `requires confirmation before using a history-only Root Skill candidate` |
| Concurrent child sources, File Changes, tokens, timings, Unknown Events | `renders complete reported activity with causal per-source sequencing` |
| Captured failed and cancelled turn envelopes | `reports failed and cancelled Skill Run outcomes...` |
| Captured disconnect/resume/cancellation plus deterministic completed and unrecoverable recovery cases | `replays the captured 0.145.0 disconnect, resume, and cancellation envelopes`; `reconnects, recovers all available item history...`; `marks a recovered terminal run incomplete...`; `reports an Incomplete Trace when history recovery fails` |
| Captured isolated structured-output Evaluation Run envelopes | `replays the captured 0.145.0 code-review fixture through the black-box boundary`; `compiles source-linked Obligations in an isolated Evaluation Run`; `evaluates every evaluable Obligation...` |
| Memory-only default and Saved Trace output | `keeps Trace data in memory unless export is explicitly requested`; `explicitly exports one versioned... Saved Trace` |

Synthetic failure details and disconnect timing in `fault-injection.json` are
assertions about deterministic Tracer edge behavior. The equivalent normal
failure, cancellation, reconnect, and Evaluation shapes in
`live-failure-recovery.json` came from Codex 0.145.0 and were only sanitized.
The files remain separate so provenance cannot be mistaken.
