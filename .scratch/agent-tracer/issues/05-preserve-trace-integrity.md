# 05 — Preserve Trace integrity through abnormal endings

**What to build:** Reliable Trace completion semantics for failed, cancelled, disconnected, and partially recoverable Skill Runs so telemetry gaps cannot masquerade as observed behavior.

**Blocked by:** 02 — Attach mid-run without guessing the session; 04 — Render complete causal agent activity.

**Status:** ready-for-agent

- [ ] Successfully completed, failed, and cancelled turns each produce an explicit terminal outcome.
- [ ] After a connection interruption, the Tracer attempts to reconstruct missing activity from available history before continuing live observation.
- [ ] Recovered activity is normalized without duplicating Events already observed.
- [ ] Any unrecoverable known gap marks the Trace incomplete and identifies the affected observation interval or sources.
- [ ] The Live Trace clearly distinguishes a failed Skill Run from an Incomplete Trace.
- [ ] Black-box fixtures cover failure, cancellation, complete recovery, and unrecoverable observation gaps.
