# Agent Tracing

This context describes how developers observe and audit the behavior of a skill-driven Codex workflow.

## Language

**Tracer**:
A tool that passively observes and presents a Skill Run, then evaluates its Conformance without altering the observed workflow.
_Avoid_: Profiler, visualizer

**Trace**:
The append-only record of normalized Events captured across a Skill Run, combining available history with live activity when attachment occurs mid-turn. It preserves causal relationships and per-source sequence without imposing a total order on concurrent activity, and identifies whether observation was complete.
_Avoid_: Profile, log

**Incomplete Trace**:
A Trace with one or more known observation gaps that could not be reconstructed. Conformance evaluation may continue, but any Finding dependent on missing activity is unobservable.
_Avoid_: Failed trace, partial log

**Live Trace**:
The append-only terminal projection of a Trace, including unredacted details reported by its event source and causal indentation for related activity.
_Avoid_: Dashboard, activity tree

**Trace Explorer**:
The local browser interface for observing a Trace as it grows and inspecting the completed Skill Run and its Conformance. It is the primary interactive interface but does not replace the CLI.
_Avoid_: Dashboard, web visualizer

**Activity Graph**:
The interactive causal projection of a Trace in the Trace Explorer. It grows during observation without asserting a total order across concurrent activity.
_Avoid_: Timeline, activity tree

**Activity Node**:
A visual work unit in the Activity Graph derived from one or more Events, such as an agent, turn, tool call, command, or File Change. Lifecycle Events may update one Activity Node while remaining immutable in the underlying Trace.
_Avoid_: Event node, span

**Run List**:
The Trace Explorer's in-memory collection of the active Skill Run and Skill Runs completed since the local process started. It is discarded when the process exits.
_Avoid_: Run history, saved sessions

**Armed State**:
The Trace Explorer state in which an Observable Session has been selected and the Tracer is waiting to observe its next Root Skill invocation. No Skill Run exists until that turn begins.
_Avoid_: Recording, idle trace

**Saved Trace**:
A versioned JSON bundle the developer explicitly chooses to persist or export, containing run metadata, the Skill Contract, Obligations, Events, and Findings. Traces otherwise remain in memory only for the duration of observation and Conformance evaluation.
_Avoid_: Automatic log, session history

**Unredacted Trace**:
A Trace whose Event payload values are preserved exactly as reported by the event source. It may contain credentials, proprietary content, personal data, or other sensitive information.
_Avoid_: Full trace, raw trace

**Event**:
An immutable normalized observation about a Skill Run, identified and related to its source and causal parent independently of how it is displayed.
_Avoid_: Message, record

**Unknown Event**:
An Event whose source type and unredacted payload are preserved but whose semantics the Tracer does not yet normalize. It remains visible as an explicit coverage gap.
_Avoid_: Unsupported message, ignored event

**File Change**:
A file mutation explicitly reported by the observed event source. A command and a File Change are separate observations; the Tracer does not infer unreported mutations from command text or ambient filesystem activity.
_Avoid_: File operation, inferred change

**Skill Run**:
The complete Codex turn caused by a developer explicitly invoking a Root Skill.
_Avoid_: Session, workflow

**Observable Session**:
An interactive Codex session that exposes a live event stream to which the Tracer can subscribe.
_Avoid_: Codex process, vanilla session

**Root Skill**:
The skill explicitly invoked by the developer to begin a Skill Run, including all activity that results during that turn.
_Avoid_: Active skill, current skill

**Skill Attribution**:
The evidence linking a Skill Run to its Root Skill. Attribution is exact when live Codex metadata identifies the selected skill; a candidate inferred from replayed prompt text requires developer confirmation.
_Avoid_: Skill detection, skill guess

**Skill Contract**:
The execution expectations expressed by the Root Skill and the behavioral instructions reached by recursively following its explicit file references. It excludes final-result quality and instructions that are merely present elsewhere in the agent's context.
_Avoid_: Specification, rubric

**Conformance**:
The degree to which a Skill Run's observed execution satisfies its Skill Contract, independent of the quality of the final result.
_Avoid_: Correctness, compliance

**Evaluation Run**:
A model interaction that derives Obligations or Findings for a Skill Run. It is isolated from the observed workflow and excluded from its Trace.
_Avoid_: Audit subagent, observed turn

**Obligation**:
A structured, observable execution expectation derived from a Skill Contract. An instruction that cannot be interpreted confidently remains visible as an ambiguous Obligation and is not evaluated.
_Avoid_: Rule, assertion

**Evidence**:
One or more Trace Events used to evaluate an Obligation. Absence may support a violation only when observation was complete and the event source fully reports the required behavior; otherwise the Obligation is unobservable.
_Avoid_: Proof, context

**Finding**:
The evidence-backed evaluation of one Obligation after a Skill Run terminates, whether by completion, failure, or cancellation. Its state is **satisfied**, **violated**, **unobservable**, or **not applicable**; Findings are summarized without collapsing the Skill Run into an overall verdict or score.
_Avoid_: Verdict, result
