# 07 — Evaluate and explain Conformance

**What to build:** A post-run Conformance report that evaluates every unambiguous Obligation solely against Trace Evidence and explains each Finding without collapsing the audit into an overall verdict.

**Blocked by:** 05 — Preserve Trace integrity through abnormal endings; 06 — Compile the Skill Contract into Obligations.

**Status:** ready-for-human

- [x] Conformance evaluation begins only after the observed Skill Run completes, fails, or is cancelled.
- [x] Each evaluated Obligation receives exactly one state: satisfied, violated, unobservable, or not applicable.
- [x] Every Finding cites the Events used as Evidence and preserves the instruction-to-Obligation-to-Evidence chain.
- [x] Absence supports a violation only when observation was complete and the event source fully reports the required behavior.
- [x] Findings affected by an observation gap or a known coverage limitation are unobservable rather than violated.
- [x] The terminal summarizes Finding counts and important Findings without an overall score, pass/fail result, or verdict.

## Comments

- Added a second isolated, ephemeral Evaluation Run after Obligation compilation.
  It receives the terminal outcome, Trace integrity, known event-source coverage
  limitations, evaluable Obligations, and the complete unredacted Trace.
- Findings retain the exact source instruction and observable Obligation behavior,
  cite validated Event ids, and explain one of satisfied, violated,
  unobservable, or not applicable for every evaluable Obligation. Ambiguous
  Obligations remain visible but are not evaluated.
- Runtime validation rejects duplicate or omitted Findings, unknown Evidence
  Events, missing Evidence citations, contradictory classifications, run-level
  conclusions, and absence violations unless the Trace is complete and the
  evaluator identifies full reporting coverage.
- The terminal renders state counts and highlights violated and unobservable
  Findings with deterministic Evidence-based explanations. Model-authored prose
  is not rendered, so it cannot reduce the audit to a score or run-level
  conclusion.
- Black-box fixtures cover all Finding states, isolated post-terminal evaluation,
  complete Evidence chains, failed and cancelled Skill Runs, observation gaps,
  and known reporting limitations.
- Two-axis code review found no documented-standard violations. Its valid spec
  findings (missing Evidence was permitted for some states and model-authored
  run-level conclusions could be rendered) were fixed with regression coverage.
  Its duplication findings were addressed by sharing the isolated Evaluation
  Run transport, observation-result types, Conformance input, and test fixture
  construction; a follow-up review also prompted removal of a delegation-only
  helper. Repeated parser guards remain a minor pre-existing style judgment and
  are kept local to preserve domain-specific validation messages.
