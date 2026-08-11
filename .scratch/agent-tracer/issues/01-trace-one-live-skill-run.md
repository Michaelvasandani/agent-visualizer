# 01 — Trace one live Skill Run

**What to build:** A source-run TypeScript CLI that starts a shared Codex App Server, verifies the supported Codex version, attaches to its only loaded thread, and renders a basic Live Trace without controlling the observed workflow.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The CLI rejects any Codex version other than exactly 0.145.0 before observation begins.
- [ ] The server command starts and owns a foreground shared App Server and tells the developer how to connect an interactive Codex TUI.
- [ ] Attachment to a server with exactly one loaded thread selects that thread automatically and only subscribes to its activity.
- [ ] A prominent warning explains that Trace output and later evaluation may expose unredacted sensitive information.
- [ ] User, tool, and command activity appears as append-only terminal Events with complete source-reported payload details.
- [ ] A black-box test drives the CLI against a fake App Server and verifies terminal output and exit status.
