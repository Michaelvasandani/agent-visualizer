import path from "node:path";

import { AppServerClient } from "./app-server-client.js";
import { runStructuredEvaluation } from "./evaluation-run.js";
import type { EvaluableObligation, Obligation } from "./obligation.js";
import type { ImmutableJsonValue, JsonObject, NormalizedEvent } from "./trace-event.js";
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";

export type FindingState =
  | "satisfied"
  | "violated"
  | "unobservable"
  | "not applicable";

export interface Finding {
  readonly obligation: EvaluableObligation;
  readonly state: FindingState;
  readonly evidenceEventIds: readonly string[];
  readonly explanation: string;
  readonly assessment: {
    readonly observationGapAffected: boolean;
    readonly eventSourceCoverage: "fully-reported" | "limited";
    readonly violationBasis: "contradiction" | "absence" | "none";
  };
}

interface ConformanceEvaluationInput {
  readonly rootSkillPath: string;
  readonly obligations: readonly Obligation[];
  readonly events: readonly NormalizedEvent[];
  readonly gaps: readonly TraceGap[];
  readonly terminalOutcome: TerminalOutcome;
}

const EVALUATION_INSTRUCTIONS =
  "You evaluate Conformance of a terminated Skill Run solely against supplied Trace Evidence. " +
  "Do not use tools or inspect the workspace. Return only the requested JSON.";

const COVERAGE_LIMITATIONS = Object.freeze([
  "Only File Changes explicitly reported by the event source are observable. Command text and ambient filesystem activity do not establish that a mutation did or did not occur.",
  "An Unknown Event preserves source data but has unsupported semantics. If an Obligation depends on those semantics, event-source coverage is limited.",
]);

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "obligationId",
          "state",
          "evidenceEventIds",
          "explanation",
          "assessment",
        ],
        properties: {
          obligationId: { type: "string", minLength: 1 },
          state: {
            enum: ["satisfied", "violated", "unobservable", "not applicable"],
          },
          evidenceEventIds: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          explanation: { type: "string", minLength: 1 },
          assessment: {
            type: "object",
            additionalProperties: false,
            required: [
              "observationGapAffected",
              "eventSourceCoverage",
              "violationBasis",
            ],
            properties: {
              observationGapAffected: { type: "boolean" },
              eventSourceCoverage: {
                enum: ["fully-reported", "limited"],
              },
              violationBasis: {
                enum: ["contradiction", "absence", "none"],
              },
            },
          },
        },
      },
    },
  },
} as const;

export async function evaluateConformance(
  client: AppServerClient,
  input: ConformanceEvaluationInput,
): Promise<readonly Finding[]> {
  const evaluableObligations = input.obligations.filter(
    (obligation): obligation is EvaluableObligation =>
      obligation.status === "evaluable",
  );
  if (evaluableObligations.length === 0) return Object.freeze([]);

  const responseText = await runStructuredEvaluation(client, {
    cwd: path.dirname(input.rootSkillPath),
    baseInstructions: EVALUATION_INSTRUCTIONS,
    prompt: findingPrompt(input),
    outputSchema: FINDINGS_SCHEMA,
    label: "Conformance Evaluation Run",
  });
  return parseFindings(
    responseText,
    evaluableObligations,
    input.events,
    input.gaps,
  );
}

export function renderFindings(findings: readonly Finding[]): readonly string[] {
  const lines = findings.map((finding) => {
    const obligation = finding.obligation;
    return (
      `[Finding ${obligation.id}] state=${finding.state} ` +
      `source=${obligation.source.path} ` +
      `instruction=${JSON.stringify(obligation.source.instruction)} ` +
      `observableBehavior=${JSON.stringify(obligation.observableBehavior)} ` +
      `evidence=${JSON.stringify(finding.evidenceEventIds)} ` +
      `explanation=${JSON.stringify(terminalExplanation(finding))}`
    );
  });

  const counts: Record<FindingState, number> = {
    satisfied: 0,
    violated: 0,
    unobservable: 0,
    "not applicable": 0,
  };
  for (const finding of findings) counts[finding.state] += 1;
  lines.push(
    `Finding summary: satisfied=${counts.satisfied} violated=${counts.violated} ` +
      `unobservable=${counts.unobservable} not applicable=${counts["not applicable"]}`,
  );
  for (const finding of findings) {
    if (finding.state !== "violated" && finding.state !== "unobservable") {
      continue;
    }
    lines.push(
      `Important Finding: obligation=${finding.obligation.id} state=${finding.state} ` +
        `explanation=${JSON.stringify(terminalExplanation(finding))}`,
    );
  }
  return Object.freeze(lines);
}

function terminalExplanation(finding: Finding): string {
  if (finding.state === "satisfied") {
    return "Cited Evidence supports this Obligation.";
  }
  if (finding.state === "violated") {
    return finding.assessment.violationBasis === "absence"
      ? "Cited Evidence establishes the observation context; the required behavior is absent from a complete Trace with full event-source reporting coverage."
      : "Cited Evidence contradicts this Obligation.";
  }
  if (finding.state === "not applicable") {
    return "Cited Evidence shows that this Obligation's condition did not arise.";
  }
  if (finding.assessment.observationGapAffected) {
    return "An identified observation gap prevents this Obligation from being evaluated.";
  }
  return "A known event-source coverage limitation prevents this Obligation from being evaluated.";
}

function findingPrompt(input: {
  readonly obligations: readonly Obligation[];
  readonly events: readonly NormalizedEvent[];
  readonly gaps: readonly TraceGap[];
  readonly terminalOutcome: TerminalOutcome;
}): string {
  return [
    "Evaluate each evaluable Obligation exactly once against only the supplied Trace Events. Do not return a Finding for ambiguous Obligations. Use exactly one state: satisfied, violated, unobservable, or not applicable. Every Finding must cite at least one supplied Event id. Preserve instruction meaning; do not assess final-result quality.",
    "A violated Finding must use violationBasis=contradiction when cited Events contradict the Obligation, or violationBasis=absence only when the Trace has no gaps and the event source fully reports the required behavior. If a Finding depends on any listed gap, set observationGapAffected=true and state=unobservable. If a listed coverage limitation affects it, set eventSourceCoverage=limited and state=unobservable. Otherwise use eventSourceCoverage=fully-reported. For every non-violated Finding, use violationBasis=none. A conditional instruction whose condition did not arise is not applicable.",
    "The Skill Run has already terminated. Its terminal outcome does not prevent evaluation.",
    "Do not include a run-level conclusion, score, pass/fail statement, or verdict in any explanation.",
    "",
    JSON.stringify({
      terminalOutcome: jsonValue(input.terminalOutcome),
      traceIntegrity: {
        complete: input.gaps.length === 0,
        gaps: input.gaps,
      },
      coverageLimitations: COVERAGE_LIMITATIONS,
      obligations: input.obligations,
      events: input.events,
    }),
  ].join("\n");
}

function parseFindings(
  responseText: string,
  obligations: readonly EvaluableObligation[],
  events: readonly NormalizedEvent[],
  gaps: readonly TraceGap[],
): readonly Finding[] {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch (error) {
    throw new Error("Conformance Evaluation Run returned invalid JSON.", {
      cause: error,
    });
  }
  const responseObject = asObject(response);
  if (responseObject === null || !Array.isArray(responseObject.findings)) {
    throw new Error(
      "Conformance Evaluation Run response is missing a findings array.",
    );
  }

  const obligationsById = new Map(
    obligations.map((obligation) => [obligation.id, obligation]),
  );
  const eventIds = new Set(events.map((event) => event.id));
  const seenObligationIds = new Set<string>();
  const findings = responseObject.findings.map((value) => {
    const finding = asObject(value);
    const obligationId = requiredString(
      finding?.obligationId,
      "Finding obligation id",
    );
    const obligation = obligationsById.get(obligationId);
    if (obligation === undefined) {
      throw new Error(
        `Conformance Evaluation Run returned a Finding for unknown or ambiguous Obligation ${obligationId}.`,
      );
    }
    if (seenObligationIds.has(obligationId)) {
      throw new Error(
        `Conformance Evaluation Run returned multiple Findings for Obligation ${obligationId}.`,
      );
    }
    seenObligationIds.add(obligationId);

    const state = findingState(finding?.state, obligationId);
    if (!Array.isArray(finding?.evidenceEventIds)) {
      throw new Error(`Finding ${obligationId} must cite an Event id array.`);
    }
    const evidenceEventIds = finding.evidenceEventIds.map((value) =>
      requiredString(value, `Finding ${obligationId} Evidence Event id`),
    );
    if (new Set(evidenceEventIds).size !== evidenceEventIds.length) {
      throw new Error(`Finding ${obligationId} cites a duplicate Event.`);
    }
    for (const eventId of evidenceEventIds) {
      if (!eventIds.has(eventId)) {
        throw new Error(
          `Finding ${obligationId} cites Event ${eventId}, which is not in the Trace.`,
        );
      }
    }
    if (evidenceEventIds.length === 0) {
      throw new Error(
        `Finding ${obligationId} must cite at least one Evidence Event.`,
      );
    }

    const explanation = requiredString(
      finding.explanation,
      `Finding ${obligationId} explanation`,
    );
    if (containsRunLevelConclusion(explanation)) {
      throw new Error(
        `Finding ${obligationId} explanation must not contain a run-level conclusion, score, or verdict.`,
      );
    }

    const assessment = asObject(finding.assessment);
    const observationGapAffected = requiredBoolean(
      assessment?.observationGapAffected,
      `Finding ${obligationId} observationGapAffected`,
    );
    const eventSourceCoverage = coverage(
      assessment?.eventSourceCoverage,
      obligationId,
    );
    const violationBasis = basis(assessment?.violationBasis, obligationId);
    validateClassification({
      obligationId,
      state,
      evidenceEventIds,
      observationGapAffected,
      eventSourceCoverage,
      violationBasis,
      traceIsComplete: gaps.length === 0,
    });

    return Object.freeze({
      obligation,
      state,
      evidenceEventIds: Object.freeze(evidenceEventIds),
      explanation,
      assessment: Object.freeze({
        observationGapAffected,
        eventSourceCoverage,
        violationBasis,
      }),
    });
  });

  const missing = obligations.find(
    (obligation) => !seenObligationIds.has(obligation.id),
  );
  if (missing !== undefined) {
    throw new Error(
      `Conformance Evaluation Run omitted Obligation ${missing.id}.`,
    );
  }
  return Object.freeze(findings);
}

function validateClassification(input: {
  readonly obligationId: string;
  readonly state: FindingState;
  readonly evidenceEventIds: readonly string[];
  readonly observationGapAffected: boolean;
  readonly eventSourceCoverage: "fully-reported" | "limited";
  readonly violationBasis: "contradiction" | "absence" | "none";
  readonly traceIsComplete: boolean;
}): void {
  if (
    (input.observationGapAffected || input.eventSourceCoverage === "limited") &&
    input.state !== "unobservable"
  ) {
    throw new Error(
      `Finding ${input.obligationId} is affected by a gap or coverage limitation and must be unobservable.`,
    );
  }
  if (
    input.state === "unobservable" &&
    !input.observationGapAffected &&
    input.eventSourceCoverage !== "limited"
  ) {
    throw new Error(
      `Finding ${input.obligationId} is unobservable without an identified gap or coverage limitation.`,
    );
  }
  if (input.state === "violated") {
    if (input.violationBasis === "none") {
      throw new Error(
        `Violated Finding ${input.obligationId} must identify contradiction or absence.`,
      );
    }
    if (
      input.violationBasis === "contradiction" &&
      input.evidenceEventIds.length === 0
    ) {
      throw new Error(
        `Contradiction Finding ${input.obligationId} must cite Trace Evidence.`,
      );
    }
    if (
      input.violationBasis === "absence" &&
      (!input.traceIsComplete ||
        input.eventSourceCoverage !== "fully-reported")
    ) {
      throw new Error(
        `Absence cannot support violated Finding ${input.obligationId} without a complete Trace and full event-source reporting coverage.`,
      );
    }
    return;
  }
  if (input.violationBasis !== "none") {
    throw new Error(
      `Non-violated Finding ${input.obligationId} must use violationBasis=none.`,
    );
  }
}

function containsRunLevelConclusion(explanation: string): boolean {
  return (
    /\boverall\b/i.test(explanation) ||
    /\b(?:numeric )?score\b/i.test(explanation) ||
    /\bverdict\b/i.test(explanation) ||
    /\bpass\s*\/\s*fail\b/i.test(explanation) ||
    /\b(?:skill )?run\s+(?:passed|failed)\b/i.test(explanation)
  );
}

function findingState(value: unknown, obligationId: string): FindingState {
  if (
    value === "satisfied" ||
    value === "violated" ||
    value === "unobservable" ||
    value === "not applicable"
  ) {
    return value;
  }
  throw new Error(`Finding ${obligationId} has an unsupported state.`);
}

function coverage(
  value: unknown,
  obligationId: string,
): "fully-reported" | "limited" {
  if (value === "fully-reported" || value === "limited") return value;
  throw new Error(`Finding ${obligationId} has unsupported event-source coverage.`);
}

function basis(
  value: unknown,
  obligationId: string,
): "contradiction" | "absence" | "none" {
  if (value === "contradiction" || value === "absence" || value === "none") {
    return value;
  }
  throw new Error(`Finding ${obligationId} has an unsupported violation basis.`);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function jsonValue(value: unknown): ImmutableJsonValue {
  return JSON.parse(JSON.stringify(value)) as ImmutableJsonValue;
}
