# 06 — Compile the Skill Contract into Obligations

**What to build:** An isolated OpenAI-backed Evaluation Run that compiles an attributed Skill Contract into inspectable, source-linked execution Obligations without altering or contaminating the observed workflow.

**Blocked by:** 03 — Attribute the Root Skill and construct its Skill Contract.

**Status:** ready-for-human

- [x] Obligation compilation runs in a separate internal App Server thread using the developer's existing Codex authentication.
- [x] Evaluation Run activity is excluded from the observed Skill Run's Events.
- [x] Each unambiguous Obligation identifies the source instruction from which it was derived and describes observable execution behavior.
- [x] Instructions that cannot be interpreted confidently remain visible as ambiguous Obligations and are not evaluated.
- [x] The full unredacted Skill Contract may be sent to OpenAI only after the sensitive-data warning has been displayed.
- [x] Scripted Evaluation Run fixtures verify isolation, structured output, source linkage, and ambiguous-instruction handling.

## Comments

- Obligation compilation starts an ephemeral, read-only internal App Server
  thread pinned to the OpenAI model provider over the already-initialized shared
  client, so it reuses the developer's Codex authentication without adding a
  credential or process path.
- The Evaluation Run is started only after the observed Skill Run reaches a
  terminal outcome. Its notifications are collected by a dedicated handler and
  never enter the observed Event pipeline; both internal and observed thread
  subscriptions are released separately.
- The compiler sends the complete unredacted Skill Contract only after the CLI
  has displayed its sensitive-data warning. A constrained output schema and
  runtime validation require every Obligation to link an exact complete
  instruction block to a contract source and require every contract instruction
  block to produce at least one Obligation.
- Evaluable Obligations carry a concrete observable behavior. Ambiguous
  Obligations instead carry an ambiguity explanation and are rendered with
  `evaluation=skipped`, preserving uncertainty without inventing behavior.
- Black-box App Server fixtures verify the single authenticated connection,
  isolated ephemeral thread and turn, unredacted contract input, structured
  output, exact source linkage, total instruction coverage, visible ambiguous
  Obligations, and exclusion of Evaluation Run activity from the Live Trace.
