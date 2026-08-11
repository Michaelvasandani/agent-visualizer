import { readFile, writeFile } from "node:fs/promises";

import { SUPPORTED_CODEX_VERSION } from "./codex-version.js";
import { renderFindings, type Finding } from "./conformance.js";
import { renderObligations, type Obligation } from "./obligation.js";
import {
  renderSkillContract,
  type RootSkillSelection,
  type SkillContract,
} from "./skill-contract.js";
import type { NormalizedEvent } from "./trace-event.js";
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";
import {
  projectTraceEvents,
  renderTerminalOutcome,
  renderTraceIntegrity,
} from "./trace-projection.js";

export const SAVED_TRACE_SCHEMA_VERSION = 1;

export const SAVED_TRACE_SENSITIVE_DATA_WARNING =
  "WARNING: SAVED TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Credentials, proprietary content, personal data, and other sensitive " +
  "Event payload values are preserved exactly as reported.";

export type SkillAttribution =
  | {
      readonly kind: "exact" | "confirmed";
      readonly rootSkill: RootSkillSelection;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: string;
    };

export interface SavedTrace {
  readonly schemaVersion: typeof SAVED_TRACE_SCHEMA_VERSION;
  readonly protocolCompatibility: {
    readonly codexCli: typeof SUPPORTED_CODEX_VERSION;
    readonly codexAppServer: typeof SUPPORTED_CODEX_VERSION;
  };
  readonly run: {
    readonly threadId: string;
    readonly cwd: string | null;
  };
  readonly terminalOutcome: TerminalOutcome;
  readonly traceIntegrity: {
    readonly complete: boolean;
    readonly gaps: readonly TraceGap[];
  };
  readonly skillAttribution: SkillAttribution;
  readonly skillContract: SkillContract | null;
  readonly obligations: readonly Obligation[];
  readonly events: readonly NormalizedEvent[];
  readonly findings: readonly Finding[];
}

export async function exportSavedTrace(
  outputPath: string,
  trace: Omit<SavedTrace, "schemaVersion" | "protocolCompatibility">,
): Promise<void> {
  const savedTrace: SavedTrace = {
    schemaVersion: SAVED_TRACE_SCHEMA_VERSION,
    protocolCompatibility: {
      codexCli: SUPPORTED_CODEX_VERSION,
      codexAppServer: SUPPORTED_CODEX_VERSION,
    },
    ...trace,
  };
  await writeFile(outputPath, `${JSON.stringify(savedTrace, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function loadSavedTrace(inputPath: string): Promise<SavedTrace> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load Saved Trace ${inputPath}.`, { cause: error });
  }
  if (!isObject(value) || value.schemaVersion !== SAVED_TRACE_SCHEMA_VERSION) {
    throw new Error(
      `Saved Trace schema version must be ${SAVED_TRACE_SCHEMA_VERSION}.`,
    );
  }
  return value as unknown as SavedTrace;
}

export async function replaySavedTrace(
  inputPath: string,
  writeLine: (line: string) => void,
): Promise<void> {
  const savedTrace = await loadSavedTrace(inputPath);
  writeLine(SAVED_TRACE_SENSITIVE_DATA_WARNING);
  writeLine(
    "Saved Trace note: per-source sequence and causal links are authoritative; append-only line position is not a total order across concurrent sources.",
  );
  projectTraceEvents(savedTrace.events, writeLine);
  renderTerminalOutcome(savedTrace.terminalOutcome, writeLine);
  renderTraceIntegrity(savedTrace.traceIntegrity.gaps, writeLine);
  if (savedTrace.skillAttribution.kind === "unresolved") {
    writeLine(
      `Root Skill Attribution unresolved: ${savedTrace.skillAttribution.reason}.`,
    );
  } else {
    const { rootSkill } = savedTrace.skillAttribution;
    writeLine(
      `Root Skill Attribution: ${savedTrace.skillAttribution.kind} name=${JSON.stringify(rootSkill.name)} path=${rootSkill.path}`,
    );
  }
  if (savedTrace.skillContract !== null) {
    for (const line of renderSkillContract(savedTrace.skillContract)) {
      writeLine(line);
    }
  }
  for (const line of renderObligations(savedTrace.obligations)) writeLine(line);
  for (const line of renderFindings(savedTrace.findings)) writeLine(line);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
