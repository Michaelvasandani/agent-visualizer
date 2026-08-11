# 07 — Evaluate and explain Conformance

**What to build:** A post-run Conformance report that evaluates every unambiguous Obligation solely against Trace Evidence and explains each Finding without collapsing the audit into an overall verdict.

**Blocked by:** 05 — Preserve Trace integrity through abnormal endings; 06 — Compile the Skill Contract into Obligations.

**Status:** ready-for-agent

- [ ] Conformance evaluation begins only after the observed Skill Run completes, fails, or is cancelled.
- [ ] Each evaluated Obligation receives exactly one state: satisfied, violated, unobservable, or not applicable.
- [ ] Every Finding cites the Events used as Evidence and preserves the instruction-to-Obligation-to-Evidence chain.
- [ ] Absence supports a violation only when observation was complete and the event source fully reports the required behavior.
- [ ] Findings affected by an observation gap or a known coverage limitation are unobservable rather than violated.
- [ ] The terminal summarizes Finding counts and important Findings without an overall score, pass/fail result, or verdict.
