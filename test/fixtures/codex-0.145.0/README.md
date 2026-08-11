# Codex 0.145.0 protocol fixtures

This directory records the experimental App Server boundary supported by the
POC. `live-code-review.json` is a sanitized capture from a real
`codex-cli 0.145.0` shared App Server, interactive TUI, and explicitly invoked
`$code-review` turn. Sanitization changes values, not method names or payload
shape. It includes the parent activity plus `thread/resume` responses captured
from both completed reviewer children, preserving their parent linkage and
subagent source metadata. The fixture deliberately retains an unfamiliar
notification so Unknown Event behavior stays covered. `fault-injection.json`
records the deterministic App Server harness envelopes used for failure,
cancellation, reconnect, and Evaluation Run isolation. It is explicitly not
represented as a live failure capture.

`live-code-review-saved-trace.json` is the sanitized, self-contained export
from the completed manual acceptance run. It retains the terminal outcome,
honest initial-history gap, exact Event/Obligation/Finding counts, and observed
source identities while replacing local paths and opaque identifiers.

The black-box tests in `test/cli.test.ts` replay captured 0.145.0 envelopes and
script deterministic fault conditions. Faults such as connection loss and
unrecoverable history are scripted because a successful live acceptance run
cannot reproduce them safely or reliably.

| Protocol behavior | Black-box fixture test |
| --- | --- |
| Captured live prompt, command, resource, duration, Unknown Event, parallel reviewer activity and child-source history, history-only attribution, evaluation isolation, export | `replays the captured 0.145.0 code-review fixture through the black-box boundary` |
| Live tools, commands, selection, terminal output, exit status, passive requests | `traces the only loaded thread through a fake App Server` |
| History replay and history/live deduplication | `replays history before live activity without duplicating Events` |
| Multiple-thread selection prompt | `requires an explicit selection when multiple threads are loaded` |
| Exact live and confirmed historical attribution | `uses exact live Root Skill metadata...`; `requires confirmation before using a history-only Root Skill candidate` |
| Concurrent child sources, File Changes, tokens, timings, Unknown Events | `renders complete reported activity with causal per-source sequencing` |
| File-backed failed and cancelled turn envelopes | `reports failed and cancelled Skill Run outcomes...` |
| File-backed reconnect recovery plus scripted unrecoverable gaps | `reconnects, recovers all available item history...`; `marks a recovered terminal run incomplete...`; `reports an Incomplete Trace when history recovery fails` |
| File-backed isolated Obligation and Conformance Evaluation Run envelopes | `replays the captured 0.145.0 code-review fixture through the black-box boundary`; `compiles source-linked Obligations in an isolated Evaluation Run`; `evaluates every evaluable Obligation...` |
| Memory-only default and Saved Trace output | `keeps Trace data in memory unless export is explicitly requested`; `explicitly exports one versioned... Saved Trace` |

Evaluation responses, failure details, and disconnect timing are intentionally
scripted and file-backed where deterministic replay matters. They are
assertions about Tracer behavior, not claims that Codex emitted those synthetic
values in the manual run. The live capture and fault-injection capture remain
separate so provenance cannot be mistaken.
