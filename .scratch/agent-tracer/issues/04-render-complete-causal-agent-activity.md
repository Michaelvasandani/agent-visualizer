# 04 — Render complete causal agent activity

**What to build:** A full-fidelity Live Trace of reported commands, tool calls, File Changes, subagents, resource usage, timings, outputs, and protocol activity with truthful causal structure.

**Blocked by:** 01 — Trace one live Skill Run.

**Status:** ready-for-human

- [x] Every normalized Event is immutable and includes stable identity, source identity, source sequence, normalized kind, timing when available, and its unredacted source payload.
- [x] Parent and subagent activity is causally indented without claiming a total order across concurrent sources.
- [x] Commands include their working directory, output, exit status, and duration when reported.
- [x] Explicit File Changes include reported paths and diffs, while command-induced mutations are not inferred.
- [x] Tool calls, collaboration activity, token updates, and duration updates are rendered when reported.
- [x] Unrecognized protocol messages remain visible as Unknown Events with their source type and unredacted payload.

## Comments

- Added a deeply immutable normalized Event model that clones and recursively
  freezes complete source payloads, observation provenance, and timing metadata.
  Live rendering and Root Skill Attribution consume those Events as the Trace's
  source of truth.
- Live notifications now retain reported turn, command, File Change, tool,
  collaboration, resource, duration, and unknown protocol activity. Unknown
  Events show their protocol source type and complete unredacted payload.
- Collaboration Events establish causal source edges from reported child thread
  IDs. Each source has an independent sequence, descendant activity is indented,
  and the CLI explicitly states that line position is not a total order across
  concurrent sources. Child activity that races its spawn report is buffered and
  rendered only after the causal edge is known.
- Black-box coverage verifies full command and File Change details, collaboration,
  child tools, token usage, timing, Unknown Events, causal indentation, and
  independent source sequences. A focused Event-model test verifies recursive
  immutability and isolation from post-capture source mutation.
- Code review aligned the regression fixture with Codex 0.145.0's
  `collabAgentToolCall.receiverThreadIds` shape, restored item-level causality for
  streamed updates, normalized nested Turn timing, classified known command,
  tool, and subagent updates explicitly, and verified that future namespaced
  notifications still remain Unknown Events.
