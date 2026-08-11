# 08 — Export a self-contained Saved Trace

**What to build:** Explicit export of a replayable, versioned JSON audit bundle while keeping all Trace data in memory by default.

**Blocked by:** 07 — Evaluate and explain Conformance.

**Status:** ready-for-human

- [x] A Trace is not persisted unless the developer explicitly requests export.
- [x] Export produces one versioned JSON bundle containing run metadata, protocol compatibility metadata, terminal outcome, Trace integrity, Skill Attribution, the Skill Contract, Obligations, Events, and Findings.
- [x] Exported Event payloads remain unredacted and the CLI repeats the sensitive-data warning before writing them.
- [x] A Saved Trace retains causal identifiers and source sequence needed by a future graph projection.
- [x] The CLI can load the Saved Trace through the same projection boundary used for terminal replay.
- [x] Black-box tests verify memory-only default behavior, explicit export, schema versioning, round-trip loading, and complete payload preservation.

## Comments

- `trace --export <path>` writes exactly one schema-version-1 JSON Saved Trace
  after the Skill Run terminates and Conformance evaluation completes. Without
  that explicit option, all Trace data remains in memory.
- The bundle includes the observed thread and working directory, exact supported
  Codex CLI and App Server versions, terminal outcome, Trace gaps and completion
  state, resolved or unresolved Skill Attribution, Skill Contract, Obligations,
  immutable normalized Events, and Findings.
- Event payloads are serialized without redaction. The CLI repeats a prominent
  Saved Trace warning immediately before creating the requested file and does
  not overwrite an existing file.
- `replay --file <path>` loads supported bundles offline and sends their Events
  through the same terminal projection used during live collection, retaining
  event identity, causal parent and source-parent identity, source depth, and
  per-source sequence.
- Black-box coverage proves the memory-only default, explicit export, required
  bundle sections, schema and protocol-version rejection, complete nested
  payload preservation, and identical Event rendering after an export/load
  round trip. Focused loader coverage rejects malformed required sections and
  restores normalized Events as deeply immutable snapshots.
- Two-axis code review found no documented-standard violations. Its spec finding
  that schema-version-1 loads did not validate exact protocol compatibility,
  required bundle shape, or immutable Event fields was fixed with regression
  coverage. Its sole style judgment, duplicated Skill Attribution rendering,
  was addressed by sharing the live and replay projection.
