# 04 — Manage Observable Sessions and Skill Runs

**What to build:** Browser workflows for session selection, active-turn attachment, Armed State, Run List navigation, evaluation progress, and explicit re-arming.

**Blocked by:** 03 — Launch the local Trace Explorer.

**Status:** ready-for-human

- [x] Automatically select the sole loaded Observable Session and require a choice when several exist.
- [x] Attach to an active turn with available history reconstruction; otherwise enter Armed State.
- [x] Never silently select a stale completed turn as a new live Skill Run.
- [x] Prevent session switching during active observation.
- [x] Retain the active and process-lifetime completed runs in an in-memory Run List.
- [x] Require **Trace Next Run** after Conformance evaluation before observing another run.
- [x] Restore the complete in-memory state when a browser reconnects.

## Comments

- Added active-or-next observation semantics that reconstruct an active turn,
  enter Armed State when only stale completed history exists, and pin the next
  Root Skill turn before accepting root or descendant activity. Ordinary turns
  are ignored while the Explorer remains armed.
- Added a process-owned Trace Explorer session manager with explicit multi-
  session selection, automatic sole-session selection, observation-time switch
  locking, evaluation progress, and an in-memory active/completed Run List.
- Added same-origin browser actions and complete state snapshots so refresh and
  reconnection restore session choice, current phase, selected run, Run List,
  observation updates, and completed observation data without restarting
  collection.
- The browser reports Conformance evaluation progress and retains distinct
  completed, failed, and cancelled terminal outcomes in the Run List.
- Added deterministic fake App Server and browser WebSocket tests for active
  attachment, stale history exclusion, Armed State, switching, explicit
  **Trace Next Run**, and reconnect restoration.
