# Compile skill instructions into obligations

The Tracer will use an LLM to compile the Skill Contract into structured execution Obligations and evaluate each one solely against captured Trace evidence. This supports existing prose-based skills while preserving an inspectable path from instruction to evidence; deterministic parsing would miss semantic requirements, author-supplied assertions would not work with unmodified skills, and a holistic LLM verdict would be difficult to audit.
