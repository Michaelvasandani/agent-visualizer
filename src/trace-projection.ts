import { renderTraceEvent, type NormalizedEvent } from "./trace-event.js";
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";
import type { SkillAttribution } from "./skill-contract.js";

export function projectTraceEvents(
  events: readonly NormalizedEvent[],
  writeLine: (line: string) => void,
): void {
  for (const event of events) writeLine(renderTraceEvent(event));
}

export function renderTerminalOutcome(
  outcome: TerminalOutcome,
  writeLine: (line: string) => void,
): void {
  const failure =
    outcome.kind === "failed"
      ? ` error=${JSON.stringify(outcome.error)}`
      : "";
  writeLine(`Skill Run terminal outcome: ${outcome.kind}${failure}`);
}

export function renderTraceIntegrity(
  gaps: readonly TraceGap[],
  writeLine: (line: string) => void,
): void {
  if (gaps.length === 0) {
    writeLine("Trace integrity: complete.");
    return;
  }
  for (const gap of gaps) {
    const intervalStart =
      gap.afterEventId === null
        ? "observation start"
        : `after ${gap.afterEventId}`;
    writeLine(
      `Incomplete Trace: interval=${intervalStart} through ${gap.historyBoundary}; ` +
        `sources=${gap.sources.join(",")}; reason=${gap.reason}.`,
    );
  }
}

export function renderSkillAttribution(
  attribution: SkillAttribution,
  writeLine: (line: string) => void,
): void {
  if (attribution.kind === "unresolved") {
    writeLine(`Root Skill Attribution unresolved: ${attribution.reason}.`);
    writeLine(
      "Conformance evaluation is unavailable because Root Skill Attribution is unresolved; Trace collection was not affected.",
    );
    return;
  }
  const { rootSkill } = attribution;
  writeLine(
    `Root Skill Attribution: ${attribution.kind} name=${JSON.stringify(rootSkill.name)} path=${rootSkill.path}`,
  );
}
