# 03 — Attribute the Root Skill and construct its Skill Contract

**What to build:** Trustworthy Root Skill identification and construction of the execution-only Skill Contract from the selected skill's explicit instruction graph.

**Blocked by:** 02 — Attach mid-run without guessing the session.

**Status:** ready-for-human

- [x] Structured live skill name and path metadata produces exact Skill Attribution without a confirmation prompt.
- [x] A skill inferred only from replayed prompt text is presented as a candidate and requires developer confirmation.
- [x] Missing, ambiguous, or rejected historical attribution prevents Conformance evaluation without stopping Trace collection.
- [x] The Skill Contract recursively follows explicit file references from the Root Skill.
- [x] Only behavioral execution requirements enter the Skill Contract; final-result quality and unrelated contextual instructions are excluded.
- [x] Fixture tests cover exact live attribution, confirmed history-only inference, unresolved mentions, and recursive references.

## Comments

- Exact attribution now comes only from structured `skill` input received in live
  App Server notifications. Replayed `$skill-name` prompt text is resolved
  against enabled skills for the thread working directory and remains a
  candidate until the developer explicitly confirms it.
- Missing, ambiguous, unresolvable, or rejected candidates leave Root Skill
  Attribution unresolved. The CLI reports that later Conformance evaluation is
  unavailable after completing Trace collection, without treating the mention
  as an invocation.
- Skill Contract construction reads the attributed root `SKILL.md` and explicit
  Markdown file references recursively, including inline links, reference-style
  links, backticked paths, and plain Markdown paths. Traversal discovers links
  from the complete source graph while requirement-like instruction blocks are
  selected independently of heading names; frontmatter, contextual prose, and
  final-result quality sections are excluded from the contract.
- Black-box fixtures cover exact live attribution without a prompt, confirmed
  and rejected history-only candidates, ambiguous prompt mentions, recursive
  references, history/live overlap, and execution-only filtering.
- Code review moved attribution onto the immutable normalized Event collection
  so live metadata and replayed prompt evidence cannot diverge from the Trace
  source of truth. It also broadened explicit-reference traversal and replaced
  broad heading-keyword filtering with behavioral instruction-block selection.
