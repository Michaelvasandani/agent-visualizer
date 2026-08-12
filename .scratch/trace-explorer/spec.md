# Trace Explorer

**Status:** needs-info

## Problem Statement

The Tracer can already collect, normalize, render, evaluate, replay, and export a Skill Run, but its append-only terminal projection makes causal structure, concurrency, resource use, and large payloads difficult to understand while an agent is working. Developers need a lightweight local interface that makes the growing execution shape visible without weakening Trace fidelity, passive observation, or the CLI.

## Solution

Add the Trace Explorer as the primary interactive browser projection of the existing Tracer. A new `agent-tracer web` command will serve a loopback-only application, start a shared Codex App Server by default, and open the system browser. The Trace Explorer will display a stable, growing Activity Graph derived from the same immutable Events used by the CLI and Saved Trace replay, retain completed Skill Runs only in an in-memory Run List, and expose post-run Conformance in a separate panel.

The CLI remains supported. Collection, recovery, attribution, Conformance, and export semantics remain shared rather than being reimplemented for the browser.

## Canonical Experience

1. The developer runs `agent-tracer web`. The command starts the Trace Explorer and its owned shared Codex App Server, prints both the browser URL and the Codex TUI connection command, and opens the browser unless `--no-open` is supplied. `--server` connects to an existing App Server instead of starting one.
2. Before displaying an unredacted Trace, the browser requires one sensitive-data acknowledgement for that process lifetime and thereafter retains a compact warning indicator.
3. The Explorer lists loaded Observable Sessions. It automatically selects the sole session or asks the developer to select one when several are available.
4. If the selected session has an active turn, the Tracer attaches and reconstructs available history. Otherwise it enters Armed State and waits for the next Root Skill invocation. It does not silently select a stale completed turn.
5. While observation is active, the Activity Graph grows without repositioning existing nodes. The browser may disconnect or refresh without stopping collection; reconnect rebuilds the UI from the in-memory Trace.
6. After the Skill Run terminates, the Explorer reports Trace integrity, resolves Skill Attribution, and runs Conformance through the existing isolated Evaluation Runs. Findings appear in a dedicated panel without graph annotation or an overall score.
7. The completed Skill Run remains in the in-memory Run List. The developer must explicitly choose **Trace Next Run** to return to Armed State. Switching Observable Sessions is allowed only while idle.
8. The developer may explicitly export a Saved Trace or open an existing Saved Trace using ordinary browser file operations. No Trace is persisted automatically.

## Application Structure

- A compact top bar presents connection, selected session, current run state, Trace integrity, and aggregate token use.
- The Activity Graph is the main canvas.
- An on-demand left drawer contains the Run List.
- A collapsible right inspector provides Activity, Events, Tokens, and Conformance views.
- The first release uses no graph annotations for Findings; Evidence remains available in the Conformance panel.

## Activity Graph

The Activity Graph is a deterministic projection of immutable normalized Events. It must be usable for both live observation and Saved Trace replay.

- Agents, turns, tool calls, commands, File Changes, and Unknown Events appear as Activity Nodes.
- Started, streamed, and completed lifecycle Events may update one derived Activity Node; the underlying Events remain immutable and inspectable.
- Reasoning appears in detail rather than as a default canvas node. Resource Events update token displays rather than creating ordinary nodes.
- Unknown Events remain visible as coverage warnings rather than disappearing.
- Nodes are arranged left to right in authoritative per-source sequence, with one lane per agent/source. Spawn causality creates child lanes. Spatial alignment across concurrent lanes must not imply a total order.
- Existing nodes remain stable while live. New nodes appear near their causal parent. A manual **Re-layout** action may recompute the full layout.
- The user may pan, zoom, search, filter, select nodes, collapse subagent branches, and pause automatic camera-following. Pausing the viewport never pauses collection.
- Activity type is communicated through icon and label. State is communicated through color plus shape or border. The application follows the system light/dark preference and never relies on color alone.

## Activity Details and Fidelity

Activity Nodes show only a concise type, state, duration, and summary. The inspector exposes complete unredacted source payloads, command output, and diffs with folding, virtualization, and copy controls. Display optimizations must never discard or silently truncate Trace data.

Trace gaps, unknown coverage, failed recovery, and terminal failure or cancellation remain explicit. The visual projection must not turn unavailable evidence into an apparent absence.

## Token Semantics

- Display only values reported by Codex: total, input, cached input, output, reasoning output, and model context window where available.
- Treat the root source's reported total as the Skill Run total.
- Display child-source totals independently. Do not sum parent and child totals unless a future supported protocol documents them as disjoint.
- Mark token data unavailable across known notification-only observation gaps.
- Do not estimate cost.

## Conformance

Conformance begins after a Skill Run completes, fails, or is cancelled and continues to use isolated Evaluation Runs excluded from the observed Trace. The Explorer exposes the Skill Contract, Obligations, Findings, Evidence references, and evaluation progress in a dedicated panel. It does not annotate Activity Nodes, calculate an overall verdict, or produce a score.

## Locality and Sensitive Data

- Bind the application only to `127.0.0.1` and reject remote binding in the first release.
- Serve all JavaScript, styles, icons, and fonts locally. Use no CDN, analytics, telemetry, remote fonts, or cloud storage.
- Use a same-origin browser connection and validate browser connection origins.
- Keep live and completed runs in memory only for the process lifetime.
- Use a browser file picker to open a Saved Trace and a browser download to export one. Validate the Saved Trace schema before replacing the current view.
- Do not expose arbitrary server-side filesystem browsing through the HTTP interface.
- Preserve the existing unredacted-data behavior and warning.

## Process and Shutdown Lifecycle

Closing or refreshing every browser tab does not stop observation. The local Node process owns collection and the Run List.

When the command owns the shared Codex App Server, an initial interrupt during active observation requests graceful shutdown after the Skill Run and already-started Conformance work settle. A second interrupt forces termination after warning that this can interrupt Codex. When idle, shutdown is immediate and clean. When connected through `--server`, shutdown unsubscribes and closes only resources owned by the Tracer.

## Implementation Shape

- Extract a structured observation API from the current CLI orchestration. It emits Events, gaps, attribution, lifecycle state, Obligations, Findings, and terminal outcome without rendering strings.
- Keep the CLI and Trace Explorer as independent consumers of that API.
- Use browser-native TypeScript and DOM for the application shell, Node built-in HTTP support for local serving, and the existing WebSocket package for live browser updates.
- Use a deterministic browser-compatible Activity Graph projector for live Events and Saved Traces.
- Start with an SVG rendering adapter. Benchmark it with 10,000 Events and 2,000 derived Activity Nodes. If it misses the responsiveness target, replace only the adapter with one focused Canvas or WebGL dependency.
- Send a complete in-memory state snapshot when a browser connects, followed by structured incremental updates. Browser reconnection must not alter collection state.
- Keep runtime dependencies minimal. Development-only browser testing tools are acceptable.

## Performance Target

The Explorer must remain interactive with at least 10,000 Events and 2,000 derived Activity Nodes. Projection and rendering are incremental; non-visible details may be virtualized and completed branches may be collapsed, but underlying Trace data remains available.

## Acceptance

- Existing CLI behavior and its black-box fixture suite remain green.
- Pure tests establish deterministic Event-to-Activity projection for live and replayed data.
- Browser tests cover session selection, Armed State, live growth, stable layout, inspection, filters, viewport pause, explicit re-arming, Conformance, Saved Trace open/export, warning acknowledgement, refresh, and reconnection.
- Failure tests cover incomplete history, disconnect recovery, failed recovery, unknown activity, failed and cancelled Skill Runs, malformed Saved Traces, and forced shutdown.
- A deterministic performance fixture proves the 10,000-Event and 2,000-node target.
- One manual run against the supported real Codex App Server proves launch, TUI attachment, live causal visualization, token reporting, Conformance, graceful shutdown, and export end to end.

## Out of Scope

- Remote access, authentication, accounts, sharing, or collaboration.
- Durable run history, automatic persistence, databases, or cloud storage.
- Multiple simultaneously observed Observable Sessions.
- Cost estimates, budgets, optimization recommendations, or cross-run comparison.
- Live provisional Conformance, graph-level pass/fail decoration, or overall scoring.
- Steering, cancelling, or otherwise controlling the observed Codex workflow.
- Graph editing or user-authored nodes and edges.
- Mobile-specific UI.
- Broader operating-system support or Codex protocol versions beyond the existing POC boundary.
- CDN assets, analytics, telemetry, or remote fonts.
