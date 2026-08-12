# 03 — Launch the local Trace Explorer

**What to build:** The `agent-tracer web` command, loopback-only HTTP and browser WebSocket services, default owned App Server startup, optional external attachment, and safe process lifecycle.

**Blocked by:** 01 — Extract the structured observation API.

**Status:** ready-for-human

- [x] Start the Trace Explorer and shared Codex App Server from one foreground command by default.
- [x] Support `--server` without taking ownership of the external App Server.
- [x] Print the browser URL and TUI connection command, open the browser by default, and support `--no-open`.
- [x] Bind only to loopback, validate browser origins, and serve all assets locally.
- [x] Send a state snapshot on browser connection followed by structured incremental updates.
- [x] Keep collection active across browser refresh and disconnection.
- [x] Implement immediate idle shutdown, deferred active shutdown, and explicit forced shutdown without stopping externally owned services.

## Comments

- Added `agent-tracer web` with an owned shared Codex App Server by default, optional external attachment, printed launch URLs, system-browser opening, and `--no-open`.
- Added a loopback-only HTTP and same-origin WebSocket service whose local shell has no remote assets. Browser connections receive a complete revisioned in-memory snapshot followed by structured observation updates; browser lifetime does not own collection.
- Added abortable Tracer subscriptions plus immediate idle, deferred active, and explicit forced shutdown. Owned App Servers are stopped with the command; externally managed App Servers are never signalled.
- Deferred shutdown prevents not-yet-started Conformance from beginning, while allowing already-started evaluation to settle. Default startup rejects an occupied App Server endpoint instead of claiming ownership of an unrelated listener.
- Added focused command, transport, CLI, reconnect, and abort tests covering every acceptance item. Browser workflows and Activity Graph rendering remain in tickets 04 and 05.
