# 02 — Attach mid-run without guessing the session

**What to build:** Complete attachment behavior for Observable Sessions with multiple loaded threads and Skill Runs already underway, combining available history with new notifications through one Event pipeline.

**Blocked by:** 01 — Trace one live Skill Run.

**Status:** ready-for-agent

- [ ] When multiple threads are loaded, the developer must select one and the Tracer never chooses by recency.
- [ ] Attaching during a turn reconstructs available history before rendering subsequent live activity.
- [ ] Historical and live representations of the same activity do not create duplicate Events.
- [ ] Event identity, per-source sequence, and available causal relationships remain consistent across the history-to-live boundary.
- [ ] Unsubscribing or exiting the Tracer does not steer, interrupt, or terminate the observed Skill Run.
- [ ] Black-box fixtures cover both single-thread automatic selection and multiple-thread interactive selection.
