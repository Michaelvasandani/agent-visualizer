# 06 — Compile the Skill Contract into Obligations

**What to build:** An isolated OpenAI-backed Evaluation Run that compiles an attributed Skill Contract into inspectable, source-linked execution Obligations without altering or contaminating the observed workflow.

**Blocked by:** 03 — Attribute the Root Skill and construct its Skill Contract.

**Status:** ready-for-agent

- [ ] Obligation compilation runs in a separate internal App Server thread using the developer's existing Codex authentication.
- [ ] Evaluation Run activity is excluded from the observed Skill Run's Events.
- [ ] Each unambiguous Obligation identifies the source instruction from which it was derived and describes observable execution behavior.
- [ ] Instructions that cannot be interpreted confidently remain visible as ambiguous Obligations and are not evaluated.
- [ ] The full unredacted Skill Contract may be sent to OpenAI only after the sensitive-data warning has been displayed.
- [ ] Scripted Evaluation Run fixtures verify isolation, structured output, source linkage, and ambiguous-instruction handling.
