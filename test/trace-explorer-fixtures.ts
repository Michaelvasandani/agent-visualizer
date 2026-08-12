import type { SkillRunObservation } from "../src/trace-observation.js";

export function completedObservation(
  threadId = "thread-one",
  terminalOutcome: SkillRunObservation["terminalOutcome"] = { kind: "completed" },
): SkillRunObservation {
  return {
    threadId,
    cwd: null,
    lifecycleState: "completed",
    evaluationState: "skipped",
    evaluationError: null,
    events: [],
    gaps: [],
    terminalOutcome,
    skillAttribution: { kind: "unresolved", reason: "fixture" },
    skillContract: null,
    obligations: [],
    findings: [],
  };
}
