import path from "node:path";

import { AppServerClient } from "./app-server-client.js";
import { runStructuredEvaluation } from "./evaluation-run.js";
import type {
  SkillContract,
  SkillContractSource,
} from "./skill-contract.js";
import type { JsonObject } from "./trace-event.js";

export interface ObligationSource {
  readonly path: string;
  readonly instruction: string;
}

export interface EvaluableObligation {
  readonly id: string;
  readonly status: "evaluable";
  readonly source: ObligationSource;
  readonly observableBehavior: string;
}

export interface AmbiguousObligation {
  readonly id: string;
  readonly status: "ambiguous";
  readonly source: ObligationSource;
  readonly ambiguity: string;
}

export type Obligation = EvaluableObligation | AmbiguousObligation;

const EVALUATION_INSTRUCTIONS =
  "You compile Skill Contracts into structured execution Obligations. " +
  "Do not use tools or inspect the workspace. Return only the requested JSON.";

const OBLIGATIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["obligations"],
  properties: {
    obligations: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "status", "source", "observableBehavior"],
            properties: {
              id: { type: "string", minLength: 1 },
              status: { const: "evaluable" },
              source: sourceSchema(),
              observableBehavior: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "status", "source", "ambiguity"],
            properties: {
              id: { type: "string", minLength: 1 },
              status: { const: "ambiguous" },
              source: sourceSchema(),
              ambiguity: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
  },
} as const;

export async function compileObligations(
  client: AppServerClient,
  contract: SkillContract,
): Promise<readonly Obligation[]> {
  const responseText = await runStructuredEvaluation(client, {
    cwd: path.dirname(contract.rootSkill.path),
    baseInstructions: EVALUATION_INSTRUCTIONS,
    prompt: obligationPrompt(contract),
    outputSchema: OBLIGATIONS_SCHEMA,
    label: "Obligation Evaluation Run",
  });
  return parseObligations(responseText, contract.sources);
}

export function renderObligations(
  obligations: readonly Obligation[],
): readonly string[] {
  return obligations.map((obligation) => {
    const source =
      `source=${obligation.source.path} ` +
      `instruction=${JSON.stringify(obligation.source.instruction)}`;
    return obligation.status === "evaluable"
      ? `[Obligation ${obligation.id}] status=evaluable ${source} observableBehavior=${JSON.stringify(obligation.observableBehavior)}`
      : `[Obligation ${obligation.id}] status=ambiguous evaluation=skipped ${source} ambiguity=${JSON.stringify(obligation.ambiguity)}`;
  });
}

function sourceSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["path", "instruction"],
    properties: {
      path: { type: "string", minLength: 1 },
      instruction: { type: "string", minLength: 1 },
    },
  };
}

function obligationPrompt(contract: SkillContract): string {
  return [
    "Compile the unredacted Skill Contract below into execution Obligations.",
    "The instructions field of each source contains complete instruction blocks separated by blank lines. Return at least one Obligation for every block. Create an evaluable Obligation only when the block confidently maps to observable execution behavior. Preserve every uncertain interpretation as an ambiguous Obligation; ambiguous Obligations must explain the uncertainty and must not invent observable behavior. Every source.path must equal the contract source path, and every source.instruction must equal the complete instruction block from which the Obligation was derived. Multiple Obligations may cite the same block. Do not assess final-result quality and do not evaluate any Obligation against Trace Evidence.",
    "",
    JSON.stringify(contract),
  ].join("\n");
}

function parseObligations(
  responseText: string,
  sources: readonly SkillContractSource[],
): readonly Obligation[] {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch (error) {
    throw new Error("Obligation Evaluation Run returned invalid JSON.", {
      cause: error,
    });
  }
  const responseObject = asObject(response);
  if (responseObject === null || !Array.isArray(responseObject.obligations)) {
    throw new Error(
      "Obligation Evaluation Run response is missing an obligations array.",
    );
  }

  const instructionBlocksByPath = new Map(
    sources.map((source) => [
      source.path,
      source.instructions.split("\n\n").filter((block) => block !== ""),
    ]),
  );
  const uncoveredInstructions = new Set(
    [...instructionBlocksByPath].flatMap(([sourcePath, blocks]) =>
      blocks.map((block) => instructionIdentity(sourcePath, block)),
    ),
  );
  const ids = new Set<string>();
  const obligations = responseObject.obligations.map((value) => {
    const obligation = asObject(value);
    const id = requiredString(obligation?.id, "Obligation id");
    if (ids.has(id)) {
      throw new Error(`Obligation Evaluation Run returned duplicate id ${id}.`);
    }
    ids.add(id);

    const source = asObject(obligation?.source);
    const sourcePath = requiredString(source?.path, `Obligation ${id} source path`);
    const instruction = requiredString(
      source?.instruction,
      `Obligation ${id} source instruction`,
    );
    const instructionBlocks = instructionBlocksByPath.get(sourcePath);
    if (
      instructionBlocks === undefined ||
      !instructionBlocks.includes(instruction)
    ) {
      throw new Error(
        `Obligation ${id} does not link to an exact instruction block in the Skill Contract.`,
      );
    }
    uncoveredInstructions.delete(instructionIdentity(sourcePath, instruction));
    const obligationSource = Object.freeze({ path: sourcePath, instruction });

    if (obligation?.status === "evaluable") {
      return Object.freeze({
        id,
        status: "evaluable" as const,
        source: obligationSource,
        observableBehavior: requiredString(
          obligation.observableBehavior,
          `Obligation ${id} observable behavior`,
        ),
      });
    }
    if (obligation?.status === "ambiguous") {
      return Object.freeze({
        id,
        status: "ambiguous" as const,
        source: obligationSource,
        ambiguity: requiredString(
          obligation.ambiguity,
          `Obligation ${id} ambiguity`,
        ),
      });
    }
    throw new Error(`Obligation ${id} has an unsupported status.`);
  });
  const omittedInstruction = uncoveredInstructions.values().next().value;
  if (typeof omittedInstruction === "string") {
    throw new Error(
      "Obligation Evaluation Run omitted a Skill Contract instruction block.",
    );
  }
  return Object.freeze(obligations);
}

function instructionIdentity(sourcePath: string, instruction: string): string {
  return `${sourcePath}\0${instruction}`;
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
