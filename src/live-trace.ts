import { renderFindings } from "./conformance.js";
import { renderObligations } from "./obligation.js";
import {
  exportSavedTrace,
  SAVED_TRACE_SENSITIVE_DATA_WARNING,
} from "./saved-trace.js";
import {
  renderSkillContract,
  type RootSkillSelection,
} from "./skill-contract.js";
import {
  observeSkillRun,
  type ObservationUpdate,
  type TraceGap,
} from "./trace-observation.js";
import {
  projectTraceEvents,
  renderSkillAttribution,
  renderTerminalOutcome,
  renderTraceIntegrity,
} from "./trace-projection.js";

const SENSITIVE_DATA_WARNING =
  "WARNING: THIS LIVE TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Prompts, credentials, paths, proprietary content, and personal data may be " +
  "exposed in terminal output; Skill Contracts and Traces are sent unredacted " +
  "to OpenAI by Evaluation Runs.";

const CAUSAL_ORDER_NOTE =
  "Live Trace note: per-source sequence and causal links are authoritative; " +
  "append-only line position is not a total order across concurrent sources.";

export async function traceLoadedThread(
  serverUrl: string,
  writeLine: (line: string) => void,
  selectThread?: (threadIds: readonly string[]) => Promise<string>,
  confirmHistoricalRootSkill?: (
    rootSkill: RootSkillSelection,
  ) => Promise<boolean>,
  exportPath?: string,
): Promise<void> {
  writeLine(SENSITIVE_DATA_WARNING);
  const pendingGaps: TraceGap[] = [];
  const observation = await observeSkillRun({
    serverUrl,
    ...(selectThread === undefined ? {} : { selectThread }),
    ...(confirmHistoricalRootSkill === undefined
      ? {}
      : { confirmHistoricalRootSkill }),
    onUpdate: (update) =>
      renderObservationUpdate(update, pendingGaps, writeLine),
  });
  if (observation.evaluationState === "failed") {
    throw observation.evaluationError;
  }

  if (exportPath !== undefined) {
    writeLine(SAVED_TRACE_SENSITIVE_DATA_WARNING);
    await exportSavedTrace(exportPath, {
      run: { threadId: observation.threadId, cwd: observation.cwd },
      terminalOutcome: observation.terminalOutcome,
      traceIntegrity: {
        complete: observation.gaps.length === 0,
        gaps: observation.gaps,
      },
      skillAttribution: observation.skillAttribution,
      skillContract: observation.skillContract,
      obligations: observation.obligations,
      events: observation.events,
      findings: observation.findings,
    });
    writeLine(`Saved Trace exported to ${exportPath}`);
  }
}

function renderObservationUpdate(
  update: ObservationUpdate,
  pendingGaps: TraceGap[],
  writeLine: (line: string) => void,
): void {
  switch (update.kind) {
    case "loaded-threads":
      if (update.threadIds.length > 1) {
        writeLine("Multiple loaded threads are available:");
        update.threadIds.forEach((threadId, index) => {
          writeLine(`${index + 1}. ${threadId}`);
        });
      }
      return;
    case "thread-selected":
      writeLine(
        update.automatic
          ? `Automatically selected the only loaded thread: ${update.threadId}`
          : `Selected loaded thread: ${update.threadId}`,
      );
      writeLine(CAUSAL_ORDER_NOTE);
      return;
    case "event":
      projectTraceEvents([update.event], writeLine);
      return;
    case "gap":
      if (update.gap.historyBoundary === "failed history recovery") {
        renderTraceIntegrity([...pendingGaps, update.gap], writeLine);
      } else {
        pendingGaps.push(update.gap);
      }
      return;
    case "terminal-outcome":
      renderTerminalOutcome(update.outcome, writeLine);
      renderTraceIntegrity(pendingGaps, writeLine);
      return;
    case "root-skill-candidate":
      writeLine(
        `Root Skill candidate inferred from replayed prompt text: name=${JSON.stringify(update.rootSkill.name)} path=${update.rootSkill.path}. Developer confirmation is required.`,
      );
      return;
    case "skill-attribution":
      renderSkillAttribution(update.attribution, writeLine);
      return;
    case "skill-contract":
      for (const line of renderSkillContract(update.contract)) writeLine(line);
      return;
    case "obligations":
      for (const line of renderObligations(update.obligations)) writeLine(line);
      return;
    case "findings":
      for (const line of renderFindings(update.findings)) writeLine(line);
      return;
    case "lifecycle":
      if (update.state === "recovering") {
        writeLine(
          `Connection interruption detected after ${update.afterEventId ?? "observation start"}.`,
        );
        writeLine(
          "Attempting history recovery before continuing live observation.",
        );
      } else if (update.recoveryComplete === true) {
        writeLine(
          "Available item history recovery complete; resumed live observation without duplicate Events.",
        );
      }
      return;
    case "evaluation-state":
      return;
  }
}
