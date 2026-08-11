import { readFile, writeFile } from "node:fs/promises";

import { SUPPORTED_CODEX_VERSION } from "./codex-version.js";
import { renderFindings, type Finding } from "./conformance.js";
import { renderObligations, type Obligation } from "./obligation.js";
import {
  renderSkillContract,
  type SkillAttribution,
  type SkillContract,
} from "./skill-contract.js";
import {
  createNormalizedEvent,
  type EventTiming,
  type JsonObject,
  type NormalizedEvent,
  type TraceEventKind,
} from "./trace-event.js";
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";
import {
  projectTraceEvents,
  renderSkillAttribution,
  renderTerminalOutcome,
  renderTraceIntegrity,
} from "./trace-projection.js";

export const SAVED_TRACE_SCHEMA_VERSION = 1;

export const SAVED_TRACE_SENSITIVE_DATA_WARNING =
  "WARNING: SAVED TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Credentials, proprietary content, personal data, and other sensitive " +
  "Event payload values are preserved exactly as reported.";

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
  validateProtocolCompatibility(value);
  validateRun(value);
  validateTerminalOutcome(value);
  validateTraceIntegrity(value);
  validateSkillAttribution(value);
  validateSkillContract(value);
  validateObligations(value);
  validateFindings(value);
  const events = requiredArray(value, "events").map((event, index) =>
    normalizedEvent(event, index),
  );
  return Object.freeze({
    ...value,
    events: Object.freeze(events),
  }) as unknown as SavedTrace;
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
  renderSkillAttribution(savedTrace.skillAttribution, writeLine);
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

function validateProtocolCompatibility(
  savedTrace: Record<string, unknown>,
): void {
  const protocol = requiredObject(savedTrace, "protocolCompatibility");
  if (
    protocol.codexCli !== SUPPORTED_CODEX_VERSION ||
    protocol.codexAppServer !== SUPPORTED_CODEX_VERSION
  ) {
    throw new Error(
      `Saved Trace protocol compatibility must be Codex ${SUPPORTED_CODEX_VERSION}.`,
    );
  }
}

function validateRun(savedTrace: Record<string, unknown>): void {
  const run = requiredObject(savedTrace, "run");
  requiredString(run, "threadId", "run.threadId");
  if (run.cwd !== null && typeof run.cwd !== "string") {
    throw new Error("Saved Trace property run.cwd must be a string or null.");
  }
}

function validateTerminalOutcome(savedTrace: Record<string, unknown>): void {
  const outcome = requiredObject(savedTrace, "terminalOutcome");
  if (
    outcome.kind !== "completed" &&
    outcome.kind !== "cancelled" &&
    outcome.kind !== "failed"
  ) {
    throw new Error("Saved Trace terminalOutcome.kind is unsupported.");
  }
  if (outcome.kind === "failed" && !("error" in outcome)) {
    throw new Error("Saved Trace failed terminalOutcome must include error.");
  }
}

function validateTraceIntegrity(savedTrace: Record<string, unknown>): void {
  const integrity = requiredObject(savedTrace, "traceIntegrity");
  if (typeof integrity.complete !== "boolean") {
    throw new Error(
      "Saved Trace property traceIntegrity.complete must be boolean.",
    );
  }
  const gaps = requiredArray(integrity, "gaps", "traceIntegrity.gaps");
  gaps.forEach((value, index) => {
    if (!isObject(value)) invalidItem("traceIntegrity.gaps", index);
    if (
      value.afterEventId !== null &&
      typeof value.afterEventId !== "string"
    ) {
      invalidItem("traceIntegrity.gaps", index);
    }
    if (
      value.historyBoundary !== "initial history" &&
      value.historyBoundary !== "reconnect history" &&
      value.historyBoundary !== "failed history recovery"
    ) {
      invalidItem("traceIntegrity.gaps", index);
    }
    stringArray(value.sources, `traceIntegrity.gaps[${index}].sources`);
    requiredString(value, "reason", `traceIntegrity.gaps[${index}].reason`);
  });
  if (integrity.complete !== (gaps.length === 0)) {
    throw new Error(
      "Saved Trace traceIntegrity.complete must agree with its gaps.",
    );
  }
}

function validateSkillAttribution(savedTrace: Record<string, unknown>): void {
  const attribution = requiredObject(savedTrace, "skillAttribution");
  if (attribution.kind === "unresolved") {
    requiredString(attribution, "reason", "skillAttribution.reason");
    return;
  }
  if (attribution.kind !== "exact" && attribution.kind !== "confirmed") {
    throw new Error("Saved Trace skillAttribution.kind is unsupported.");
  }
  validateRootSkill(
    requiredObject(attribution, "rootSkill", "skillAttribution.rootSkill"),
  );
}

function validateSkillContract(savedTrace: Record<string, unknown>): void {
  if (!("skillContract" in savedTrace)) {
    missingProperty("skillContract");
  }
  if (savedTrace.skillContract === null) return;
  if (!isObject(savedTrace.skillContract)) {
    throw new Error(
      "Saved Trace property skillContract must be an object or null.",
    );
  }
  validateRootSkill(
    requiredObject(
      savedTrace.skillContract,
      "rootSkill",
      "skillContract.rootSkill",
    ),
  );
  requiredArray(
    savedTrace.skillContract,
    "sources",
    "skillContract.sources",
  ).forEach((source, index) => {
    if (!isObject(source)) invalidItem("skillContract.sources", index);
    requiredString(source, "path", `skillContract.sources[${index}].path`);
    requiredString(
      source,
      "instructions",
      `skillContract.sources[${index}].instructions`,
      true,
    );
  });
}

function validateObligations(savedTrace: Record<string, unknown>): void {
  requiredArray(savedTrace, "obligations").forEach((value, index) => {
    const label = `obligations[${index}]`;
    if (!isObject(value)) invalidItem("obligations", index);
    if (value.status === "evaluable") {
      validateEvaluableObligation(value, label);
    } else if (value.status === "ambiguous") {
      validateObligationIdentity(value, label);
      requiredString(value, "ambiguity", `${label}.ambiguity`);
    } else {
      throw new Error(`Saved Trace ${label}.status is unsupported.`);
    }
  });
}

function validateFindings(savedTrace: Record<string, unknown>): void {
  requiredArray(savedTrace, "findings").forEach((value, index) => {
    const label = `findings[${index}]`;
    if (!isObject(value)) invalidItem("findings", index);
    const obligation = requiredObject(value, "obligation", `${label}.obligation`);
    if (obligation.status !== "evaluable") {
      throw new Error(`Saved Trace ${label}.obligation must be evaluable.`);
    }
    validateEvaluableObligation(obligation, `${label}.obligation`);
    if (
      value.state !== "satisfied" &&
      value.state !== "violated" &&
      value.state !== "unobservable" &&
      value.state !== "not applicable"
    ) {
      throw new Error(`Saved Trace ${label}.state is unsupported.`);
    }
    stringArray(value.evidenceEventIds, `${label}.evidenceEventIds`);
    requiredString(value, "explanation", `${label}.explanation`);
    const assessment = requiredObject(
      value,
      "assessment",
      `${label}.assessment`,
    );
    if (typeof assessment.observationGapAffected !== "boolean") {
      throw new Error(
        `Saved Trace ${label}.assessment.observationGapAffected must be boolean.`,
      );
    }
    if (
      assessment.eventSourceCoverage !== "fully-reported" &&
      assessment.eventSourceCoverage !== "limited"
    ) {
      throw new Error(
        `Saved Trace ${label}.assessment.eventSourceCoverage is unsupported.`,
      );
    }
    if (
      assessment.violationBasis !== "contradiction" &&
      assessment.violationBasis !== "absence" &&
      assessment.violationBasis !== "none"
    ) {
      throw new Error(
        `Saved Trace ${label}.assessment.violationBasis is unsupported.`,
      );
    }
  });
}

function normalizedEvent(value: unknown, index: number): NormalizedEvent {
  if (!isObject(value)) invalidItem("events", index);
  const label = `events[${index}]`;
  const sourceSequence = requiredInteger(value, "sourceSequence", label);
  const sourceDepth = requiredInteger(value, "sourceDepth", label);
  if (sourceSequence < 1 || sourceDepth < 0) invalidItem("events", index);
  const kind = value.kind;
  if (!TRACE_EVENT_KINDS.has(kind as TraceEventKind)) {
    throw new Error(`Saved Trace ${label}.kind is unsupported.`);
  }
  const timing = eventTiming(value.timing, label);
  const observationSources = stringArray(
    value.observationSources,
    `${label}.observationSources`,
  );
  if (
    observationSources.some(
      (source) => source !== "history" && source !== "live",
    )
  ) {
    throw new Error(`Saved Trace ${label}.observationSources is unsupported.`);
  }
  const payload = requiredObject(value, "payload", `${label}.payload`);
  return createNormalizedEvent({
    id: requiredString(value, "id", `${label}.id`),
    sourceId: requiredString(value, "sourceId", `${label}.sourceId`),
    sourceSequence,
    causalParentId: nullableString(value, "causalParentId", label),
    sourceParentId: nullableString(value, "sourceParentId", label),
    sourceDepth,
    method: requiredString(value, "method", `${label}.method`),
    kind: kind as TraceEventKind,
    timing,
    observationSources: observationSources as readonly ("history" | "live")[],
    payload: payload as JsonObject,
  });
}

function eventTiming(value: unknown, label: string): EventTiming | null {
  if (value === null) return null;
  if (!isObject(value)) {
    throw new Error(`Saved Trace ${label}.timing must be an object or null.`);
  }
  for (const key of [
    "startedAt",
    "completedAt",
    "startedAtMs",
    "completedAtMs",
    "durationMs",
  ]) {
    if (key in value && typeof value[key] !== "number") {
      throw new Error(`Saved Trace ${label}.timing.${key} must be a number.`);
    }
  }
  return value as EventTiming;
}

function validateRootSkill(rootSkill: Record<string, unknown>): void {
  requiredString(rootSkill, "name", "rootSkill.name");
  requiredString(rootSkill, "path", "rootSkill.path");
}

function validateEvaluableObligation(
  obligation: Record<string, unknown>,
  label: string,
): void {
  validateObligationIdentity(obligation, label);
  requiredString(
    obligation,
    "observableBehavior",
    `${label}.observableBehavior`,
  );
}

function validateObligationIdentity(
  obligation: Record<string, unknown>,
  label: string,
): void {
  requiredString(obligation, "id", `${label}.id`);
  const source = requiredObject(obligation, "source", `${label}.source`);
  requiredString(source, "path", `${label}.source.path`);
  requiredString(source, "instruction", `${label}.source.instruction`);
}

function requiredObject(
  parent: Record<string, unknown>,
  property: string,
  label = property,
): Record<string, unknown> {
  if (!(property in parent)) missingProperty(label);
  const value = parent[property];
  if (!isObject(value)) {
    throw new Error(`Saved Trace property ${label} must be an object.`);
  }
  return value;
}

function requiredArray(
  parent: Record<string, unknown>,
  property: string,
  label = property,
): readonly unknown[] {
  if (!(property in parent)) missingProperty(label);
  const value = parent[property];
  if (!Array.isArray(value)) {
    throw new Error(`Saved Trace property ${label} must be an array.`);
  }
  return value;
}

function requiredString(
  parent: Record<string, unknown>,
  property: string,
  label: string,
  allowEmpty = false,
): string {
  const value = parent[property];
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "")
  ) {
    throw new Error(`Saved Trace property ${label} must be a string.`);
  }
  return value;
}

function requiredInteger(
  parent: Record<string, unknown>,
  property: string,
  label: string,
): number {
  const value = parent[property];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `Saved Trace property ${label}.${property} must be an integer.`,
    );
  }
  return value;
}

function nullableString(
  parent: Record<string, unknown>,
  property: string,
  label: string,
): string | null {
  const value = parent[property];
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `Saved Trace property ${label}.${property} must be a string or null.`,
    );
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Saved Trace property ${label} must be a string array.`);
  }
  return value as readonly string[];
}

function missingProperty(property: string): never {
  throw new Error(`Saved Trace is missing required property ${property}.`);
}

function invalidItem(property: string, index: number): never {
  throw new Error(`Saved Trace property ${property}[${index}] is invalid.`);
}

const TRACE_EVENT_KINDS = new Set<TraceEventKind>([
  "agent",
  "collaboration",
  "command",
  "duration",
  "error",
  "file-change",
  "plan",
  "reasoning",
  "resource",
  "thread",
  "tool",
  "turn",
  "unknown",
  "user",
]);
