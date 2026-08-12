# 01 — Extract the structured observation API

**What to build:** Separate Trace collection and post-run evaluation from terminal rendering so both the CLI and Trace Explorer consume one structured lifecycle.

**Blocked by:** Nothing.

**Status:** ready-for-human

- [x] Expose immutable Events, Trace gaps, terminal outcome, Skill Attribution, Skill Contract, Obligations, Findings, and evaluation state through a structured API.
- [x] Preserve mid-run attachment, reconnection recovery, descendant replay, and isolated Evaluation Run behavior.
- [x] Keep the CLI as a projection over the new API with no externally visible regression.
- [x] Keep collection independent from the lifetime of any browser connection.
- [x] Preserve all existing tests and add focused lifecycle tests at the extracted seam.

## Comments

- Implemented `observeSkillRun` as the rendering-independent structured lifecycle and reduced `traceLoadedThread` to a terminal projection plus explicit Saved Trace export.
- Added direct lifecycle integration tests covering immutable Event updates, terminal outcome, exact and unresolved Skill Attribution, Skill Contract construction, both isolated Evaluation Run stages, Obligations, Findings, successful/skipped/failed evaluation, consumer disconnection, and final state.
- Resolved review findings by isolating update-consumer failures from collection, retaining the completed Trace when evaluation fails, and keeping default selection behavior solely at the structured API boundary.
