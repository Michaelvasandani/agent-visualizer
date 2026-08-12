# 02 — Project Events into an Activity Graph

**What to build:** A deterministic browser-compatible projection that derives stable Activity Nodes, source lanes, causal edges, states, summaries, and token views from immutable Events.

**Blocked by:** 01 — Extract the structured observation API.

**Status:** ready-for-human

- [x] Fold lifecycle and streamed Events into Activity Nodes without mutating or discarding the underlying Events.
- [x] Preserve per-source sequence and causal relationships without inventing a total order across concurrent sources.
- [x] Represent agents, turns, tools, commands, File Changes, and Unknown Events; keep reasoning and resources in their agreed secondary presentations.
- [x] Project root and child token values without summing values whose overlap is undocumented.
- [x] Produce identical graph state from equivalent live and Saved Trace Event sequences.
- [x] Cover late attachment, gaps, unknown activity, failures, cancellation, and concurrent descendants with pure tests.

## Comments

- Added a browser-compatible pure Activity Graph projector and immutable incremental reducer. The projection retains every Event by source, folds lifecycle and stream updates into stable nodes, models spawn and causal edges without a cross-source order, and keeps gaps and terminal outcomes explicit.
- Added separate reported token views for the root Skill Run and each source. Child totals remain independent, unavailable values remain marked across known gaps, and no aggregate or cost is inferred.
- Added focused deterministic tests for live/replay equivalence, late attachment, lifecycle folding, concurrent descendants, Unknown Events, gaps, token semantics, failures, and cancellation.
