# 04 — Render complete causal agent activity

**What to build:** A full-fidelity Live Trace of reported commands, tool calls, File Changes, subagents, resource usage, timings, outputs, and protocol activity with truthful causal structure.

**Blocked by:** 01 — Trace one live Skill Run.

**Status:** ready-for-agent

- [ ] Every normalized Event is immutable and includes stable identity, source identity, source sequence, normalized kind, timing when available, and its unredacted source payload.
- [ ] Parent and subagent activity is causally indented without claiming a total order across concurrent sources.
- [ ] Commands include their working directory, output, exit status, and duration when reported.
- [ ] Explicit File Changes include reported paths and diffs, while command-induced mutations are not inferred.
- [ ] Tool calls, collaboration activity, token updates, and duration updates are rendered when reported.
- [ ] Unrecognized protocol messages remain visible as Unknown Events with their source type and unredacted payload.
