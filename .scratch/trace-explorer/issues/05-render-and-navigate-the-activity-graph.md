# 05 — Render and navigate the Activity Graph

**What to build:** The central SVG Activity Graph with stable live layout, agent lanes, causal branches, accessible visual semantics, and lightweight navigation controls.

**Blocked by:** 02 — Project Events into an Activity Graph; 03 — Launch the local Trace Explorer.

**Status:** ready-for-human

- [x] Lay out authoritative source sequence left to right and spawned agents in child lanes.
- [x] Keep existing node positions stable as live activity arrives and provide manual **Re-layout**.
- [x] Support pan, zoom, search, filtering, node selection, and collapsing subagent branches.
- [x] Support pausing and resuming automatic camera-following without affecting collection.
- [x] Use icons and labels for activity type and redundant non-color cues for state.
- [x] Follow system light/dark preference and provide keyboard-operable interactions.
- [x] Keep Unknown Events and integrity gaps visibly distinct.

## Comments

- Added an incremental, browser-neutral Activity Graph layout to each process-owned Run Snapshot. Existing lane and node coordinates remain stable as live activity arrives; explicit **Re-layout** recomputes the deterministic full layout.
- Added the local SVG rendering adapter and keyboard-operable navigation controls for pan, zoom, search, activity filtering, selection, branch collapse, and camera-follow pause/resume. Camera state remains browser-local and does not dispatch collection actions.
- Activity Nodes combine icons and labels with state symbols and distinct solid, heavy, dashed, or dotted borders. Unknown Events use coverage-warning cards; integrity gaps use separate striped diamond markers. Styling follows the system light/dark preference.
- Added focused projection-layout, session-snapshot, browser-shell, and executed DOM interaction tests covering SVG rendering, search/filter, selection, branch collapse, zoom/reset, camera pause, and Re-layout dispatch. The in-app browser runtime reported no available browser surface, so visual screenshot verification could not be performed in this environment.
