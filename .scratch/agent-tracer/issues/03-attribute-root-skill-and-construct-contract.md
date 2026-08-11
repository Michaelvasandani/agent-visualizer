# 03 — Attribute the Root Skill and construct its Skill Contract

**What to build:** Trustworthy Root Skill identification and construction of the execution-only Skill Contract from the selected skill's explicit instruction graph.

**Blocked by:** 02 — Attach mid-run without guessing the session.

**Status:** ready-for-agent

- [ ] Structured live skill name and path metadata produces exact Skill Attribution without a confirmation prompt.
- [ ] A skill inferred only from replayed prompt text is presented as a candidate and requires developer confirmation.
- [ ] Missing, ambiguous, or rejected historical attribution prevents Conformance evaluation without stopping Trace collection.
- [ ] The Skill Contract recursively follows explicit file references from the Root Skill.
- [ ] Only behavioral execution requirements enter the Skill Contract; final-result quality and unrelated contextual instructions are excluded.
- [ ] Fixture tests cover exact live attribution, confirmed history-only inference, unresolved mentions, and recursive references.
