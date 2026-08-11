# 08 — Export a self-contained Saved Trace

**What to build:** Explicit export of a replayable, versioned JSON audit bundle while keeping all Trace data in memory by default.

**Blocked by:** 07 — Evaluate and explain Conformance.

**Status:** ready-for-agent

- [ ] A Trace is not persisted unless the developer explicitly requests export.
- [ ] Export produces one versioned JSON bundle containing run metadata, protocol compatibility metadata, terminal outcome, Trace integrity, Skill Attribution, the Skill Contract, Obligations, Events, and Findings.
- [ ] Exported Event payloads remain unredacted and the CLI repeats the sensitive-data warning before writing them.
- [ ] A Saved Trace retains causal identifiers and source sequence needed by a future graph projection.
- [ ] The CLI can load the Saved Trace through the same projection boundary used for terminal replay.
- [ ] Black-box tests verify memory-only default behavior, explicit export, schema versioning, round-trip loading, and complete payload preservation.
