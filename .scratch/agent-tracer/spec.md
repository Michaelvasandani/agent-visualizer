# Agent Tracer POC

**Status:** ready-for-agent

## Problem Statement

Developers invoking a Codex skill cannot easily see whether the resulting interactive workflow followed that skill's instructions. Codex exposes useful execution activity, but it is not presented as a coherent Skill Run, does not directly explain resource use or nested-agent causality, and does not evaluate the observed execution against the Root Skill's behavioral contract. Developers therefore have to reconstruct what happened manually and already understand the skill well enough to judge it.

## Solution

Build a source-run macOS CLI Tracer that passively subscribes to an Observable Session through a shared Codex App Server, renders a complete Live Trace, and evaluates the completed Skill Run for Conformance. The Tracer will normalize available history and live protocol activity into immutable Events, preserve causal relationships across agents, display the full unredacted payloads reported by Codex, and optionally export a self-contained Saved Trace.

The Tracer will derive a Skill Contract from the Root Skill and recursively referenced behavioral instructions. Separate Evaluation Runs will use OpenAI through the developer's existing Codex authentication to compile the contract into Obligations and evaluate those Obligations solely against Trace Evidence. The audit will report individual Findings without producing an overall score or verdict.

## User Stories

1. As a developer, I want to start a shared Codex App Server from the Tracer, so that my interactive TUI exposes an attachable event stream.
2. As a developer, I want clear instructions for connecting Codex TUI to the shared server, so that I can continue using an interactive workflow.
3. As a developer, I want the Tracer to verify the exact supported Codex version, so that an experimental protocol mismatch cannot silently corrupt my audit.
4. As a developer, I want to attach the Tracer to an already-running Observable Session, so that observation does not launch or replace my interactive workflow.
5. As a developer, I want the only loaded thread to be selected automatically, so that the common attachment path is quick.
6. As a developer, I want to choose from loaded threads when several exist, so that the Tracer never guesses which session I intend to audit.
7. As a developer, I want an attachment made during a turn to replay available history before streaming new activity, so that the Trace covers the complete Skill Run.
8. As a developer, I want historical and live activity normalized through the same pipeline, so that attachment timing does not change Event semantics.
9. As a developer, I want structured Codex skill metadata to identify the Root Skill when it is available, so that attribution is exact.
10. As a developer, I want a Root Skill inferred from replayed prompt text to require my confirmation, so that a mention is not mistaken for a successful invocation.
11. As a developer, I want the complete turn initiated by the Root Skill treated as one Skill Run, so that all resulting work is audited together.
12. As a developer, I want tool calls and their outcomes shown live, so that I can follow the agent's external actions.
13. As a developer, I want shell commands, working directories, output, exit status, and duration shown live, so that I can understand command execution.
14. As a developer, I want explicitly reported File Changes and their diffs shown live, so that I can inspect modifications without inferred filesystem claims.
15. As a developer, I want subagent creation and activity related causally to their parent, so that concurrent delegation remains understandable.
16. As a developer, I want token usage updates shown during the Skill Run, so that I can understand resource consumption.
17. As a developer, I want execution durations shown for completed activity, so that slow operations are visible.
18. As a developer, I want unknown protocol activity retained and identified, so that unsupported semantics become visible coverage gaps instead of disappearing.
19. As a developer, I want Events to remain immutable and append-only, so that live collection and replay produce an auditable record.
20. As a developer, I want causal relationships and per-source sequencing preserved without a fabricated global order, so that concurrent activity is represented truthfully.
21. As a developer, I want the Live Trace rendered as append-only terminal lines with causal indentation, so that it works in ordinary terminals, over SSH, and through output redirection.
22. As a developer, I want all source-reported payload details displayed, so that the audit preserves maximum fidelity.
23. As a developer, I want a prominent sensitive-data warning before tracing begins, so that I understand unredacted prompts, credentials, paths, and proprietary content may be exposed.
24. As a developer, I want the Trace kept only in memory by default, so that observation does not automatically create another durable copy of sensitive data.
25. As a developer, I want to export a Saved Trace explicitly, so that I can preserve an audit when its value outweighs its sensitivity.
26. As a developer, I want a Saved Trace to include versioned metadata, the Skill Contract, Obligations, Events, and Findings, so that it is self-contained and replayable.
27. As a developer, I want the Root Skill's behavioral instructions and explicitly referenced instruction graph compiled into a Skill Contract, so that existing unmodified skills can be audited.
28. As a developer, I want final-result quality excluded from Conformance, so that the Tracer evaluates observable execution rather than becoming a domain-specific output grader.
29. As a developer, I want prose instructions compiled into structured Obligations, so that each evaluation has an inspectable instruction-to-evidence chain.
30. As a developer, I want ambiguous instructions retained but not evaluated, so that uncertainty is visible without manufacturing an interpretation.
31. As a developer, I want Obligation compilation isolated from the observed Skill Run, so that auditing does not alter the workflow being audited.
32. As a developer, I want Conformance evaluated only after the Skill Run terminates, so that Findings use a complete stable Trace.
33. As a developer, I want each Finding linked to captured Evidence, so that I can inspect why an Obligation received its state.
34. As a developer, I want Findings classified as satisfied, violated, unobservable, or not applicable, so that absence, contradiction, and conditional behavior remain distinct.
35. As a developer, I want Findings summarized without an overall score or verdict, so that uncertainty is not hidden behind false precision.
36. As a developer, I want failed and cancelled Skill Runs evaluated, so that the most useful diagnostic executions remain auditable.
37. As a developer, I want unrecoverable observation gaps to mark the Trace incomplete, so that missing telemetry cannot become false evidence.
38. As a developer, I want gap-dependent Obligations marked unobservable while other Findings remain evaluable, so that partial evidence retains its value.
39. As a developer, I want Evaluation Runs to use my existing Codex authentication, so that the POC does not require another credential path.
40. As a developer, I want Evaluation Runs excluded from the observed Trace, so that internal audit activity cannot contaminate Skill Run evidence.
41. As a developer, I want exported data to feed a future graph without changing the tracing pipeline, so that visualization can become another projection of the same Event model.
42. As a developer, I want deterministic fixture replay tests, so that protocol normalization and audit behavior can be verified without consuming Codex usage on every test.
43. As a developer, I want a real `$code-review` acceptance run, so that the POC proves live attachment, nested activity, resource reporting, and Conformance end to end.

## Implementation Decisions

- Implement the POC in TypeScript on Node.js and run it from source.
- Support macOS and exactly `codex-cli 0.145.0` for the POC. Reject other versions before observation begins.
- Provide a foreground server command that starts and owns a shared Codex App Server and tells the developer how to launch the interactive TUI against it.
- Attach only to Observable Sessions connected to that shared server. Do not tail private Codex session files, inject hooks, or launch a replacement non-interactive workflow.
- Subscribe passively: the Tracer may list, resume, and unsubscribe from threads but must not start, steer, interrupt, or control the observed Skill Run.
- Automatically select the only loaded thread. When several are loaded, require an explicit developer selection rather than relying on recency.
- Reconstruct a mid-turn Trace from available thread history before processing live notifications.
- Treat structured live skill selection metadata as exact Skill Attribution. Treat a skill name inferred only from historical prompt text as a candidate that requires confirmation.
- Use immutable normalized Events as the Trace source of truth. Each Event carries stable identity, source identity, per-source sequence, causal relationships, timing information when available, a normalized kind, and the full source-reported payload.
- Preserve unrecognized protocol messages as Unknown Events rather than discarding or pretending to understand them.
- Treat File Changes as only the mutations explicitly reported by Codex. Do not infer additional changes from command strings, ambient filesystem observation, or repository snapshots.
- Render a Live Trace as append-only chronological output with causal indentation. Display full unredacted source-reported details.
- Warn prominently that terminal output, Saved Traces, and Evaluation Runs may expose credentials, proprietary content, personal data, or other sensitive information.
- Keep a Trace in memory by default. On explicit request, export one versioned JSON bundle containing run metadata, the Skill Contract, Obligations, Events, Findings, Trace integrity, protocol compatibility metadata, and terminal outcome.
- Recursively follow explicit file references from the Root Skill to construct the Skill Contract, including only behavioral execution instructions and excluding final-output quality.
- Use separate internal App Server threads for Evaluation Runs. Exclude their Events from the observed Trace.
- Use OpenAI through the developer's existing Codex authentication for Evaluation Runs. Send the full unredacted Skill Contract and Trace.
- Compile the Skill Contract into structured, source-linked Obligations before evaluating each Obligation against Trace Evidence.
- Preserve ambiguous Obligations as visible, unevaluated entries.
- Run Conformance evaluation once after the Skill Run completes, fails, or is cancelled.
- Classify each evaluated Obligation as satisfied, violated, unobservable, or not applicable and cite the supporting Events. Do not compute an overall verdict or numeric score.
- Attempt to reconstruct missing activity after a disconnect. If any known gap remains, mark the Trace incomplete and prevent absence within that gap from supporting a violation.
- Design terminal rendering and the future graph as projections of the normalized Event model rather than as alternate collection pipelines.

## Testing Decisions

- Test external behavior at one primary seam: invoke the CLI as a black box against a fake shared App Server that replays captured Codex 0.145.0 protocol fixtures and scripted Evaluation Run responses.
- Assert terminal output, process exit status, prompts or selections exposed to the developer, and the optional Saved Trace bundle. Do not assert internal class structure, helper calls, or implementation-specific state transitions.
- Cover live-only observation, history followed by live continuation, a single automatically selected thread, multiple-thread selection, exact live Skill Attribution, confirmed historical attribution, causal subagent activity, command and File Change details, token updates, timings, Unknown Events, failed and cancelled turns, reconnect recovery, unrecoverable gaps, and all Finding states through the black-box seam.
- Verify that Evaluation Runs are excluded from observed Events and that the observed thread never receives start, steer, interrupt, or evaluation requests from the Tracer.
- Verify the sensitive-data warning, memory-only default, explicit export, schema version, and full unredacted payload preservation.
- Verify exact Codex version rejection at the CLI boundary.
- Maintain captured protocol fixtures as the prior-art contract for the experimental App Server adapter.
- Complete one manual end-to-end acceptance run using a real Codex 0.145.0 App Server, an interactive TUI, and an explicitly invoked `$code-review` Root Skill.

## Out of Scope

- Attaching to arbitrary vanilla Codex TUI, IDE, desktop, cloud, or web sessions.
- Supporting Codex versions other than exactly 0.145.0.
- Linux or Windows support.
- Published npm packages, standalone binaries, background services, or Codex plugins.
- Non-interactive `codex exec --json` observation.
- Private rollout-file tailing, hooks, OpenTelemetry, filesystem watchers, command parsing, or repository snapshots as alternate evidence sources.
- Automatic persistence, cloud trace storage, sharing, collaboration, retention policies, or access controls.
- Automatic or configurable redaction.
- Third-party, OpenAI-compatible, pluggable, or local evaluation providers.
- Evaluation of final-result quality, general agent policy compliance, or instructions outside the Skill Contract.
- Live provisional Findings, overall verdicts, numeric scoring, cross-run comparisons, benchmarks, budgets, or optimization recommendations.
- A graphical or full-screen terminal interface and the future interactive workflow graph.
- Multi-version protocol adapters or best-effort compatibility.

## Further Notes

- The shared App Server and its WebSocket transport are experimental. The exact version pin and protocol-fixture suite are part of the POC's trust boundary.
- Live skill selection carries structured name and path metadata, while reconstructed Codex 0.145.0 history retains prompt text but may omit that structured metadata. The confirmation path is therefore required for trustworthy late attachment.
- App Server File Change coverage does not enumerate every mutation a shell command might cause. The Live Trace must state this limitation without weakening commands or explicitly reported File Changes as Evidence.
- Maximum fidelity was chosen over automatic redaction. Developers must treat terminal output and Saved Traces as sensitive and understand that Evaluation Runs send unredacted data to OpenAI.
