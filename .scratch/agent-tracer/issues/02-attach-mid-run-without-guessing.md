# 02 — Attach mid-run without guessing the session

**What to build:** Complete attachment behavior for Observable Sessions with multiple loaded threads and Skill Runs already underway, combining available history with new notifications through one Event pipeline.

**Blocked by:** 01 — Trace one live Skill Run.

**Status:** ready-for-human

- [x] When multiple threads are loaded, the developer must select one and the Tracer never chooses by recency.
- [x] Attaching during a turn reconstructs available history before rendering subsequent live activity.
- [x] Historical and live representations of the same activity do not create duplicate Events.
- [x] Event identity, per-source sequence, and available causal relationships remain consistent across the history-to-live boundary.
- [x] Unsubscribing or exiting the Tracer does not steer, interrupt, or terminate the observed Skill Run.
- [x] Black-box fixtures cover both single-thread automatic selection and multiple-thread interactive selection.

## Comments

- Added explicit numbered selection for multiple loaded threads while retaining
  automatic selection only for the sole-thread case.
- Thread history and notifications received during attachment now enter one
  buffered Event pipeline. Stable lifecycle identity deduplicates overlapping
  history/live activity while source sequence and causal turn metadata continue
  across the boundary.
- Black-box App Server fixtures verify selection, history-before-live ordering,
  deduplication, passive unsubscribe behavior, and Event metadata.
- Code review added coverage for completion racing attachment and changed overlap
  handling to coalesce richer buffered lifecycle payloads with reconstructed
  history before rendering, preserving reported timing without duplicate Events.
