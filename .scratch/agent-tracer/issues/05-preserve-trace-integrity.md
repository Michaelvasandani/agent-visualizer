# 05 — Preserve Trace integrity through abnormal endings

**What to build:** Reliable Trace completion semantics for failed, cancelled, disconnected, and partially recoverable Skill Runs so telemetry gaps cannot masquerade as observed behavior.

**Blocked by:** 02 — Attach mid-run without guessing the session; 04 — Render complete causal agent activity.

**Status:** ready-for-human

- [x] Successfully completed, failed, and cancelled turns each produce an explicit terminal outcome.
- [x] After a connection interruption, the Tracer attempts to reconstruct missing activity from available history before continuing live observation.
- [x] Recovered activity is normalized without duplicating Events already observed.
- [x] Any unrecoverable known gap marks the Trace incomplete and identifies the affected observation interval or sources.
- [x] The Live Trace clearly distinguishes a failed Skill Run from an Incomplete Trace.
- [x] Black-box fixtures cover failure, cancellation, complete recovery, and unrecoverable observation gaps.

## Comments

- Added explicit completed, failed, and cancelled terminal outcomes, rendered
  independently from Trace integrity so a failed Skill Run is not mislabeled as
  an Incomplete Trace.
- Connection interruption now reconnects and replays available item history
  through the existing Event pipeline. Stable lifecycle identities deduplicate
  recovered activity already observed before the interruption.
- Initial and reconnect history use Codex `itemsView` coverage to report partial
  item history. Because resumed turn history cannot reconstruct notification-only
  activity or newly discovered descendant sources, those observation intervals
  remain explicitly incomplete even when available item recovery is complete.
- Failed reconnect or resume reports the affected interval, sources, and failure
  reason before exiting. Black-box fixtures cover live terminal outcomes,
  complete available-item recovery, deduplication, partial initial and reconnect
  history, notification-only gaps, and failed recovery.
- Code review found and resolved false-completeness cases for partial initial
  history, full reconnect item history, failed recovery, and full initial item
  history.
