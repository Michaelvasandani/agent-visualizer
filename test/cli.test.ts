import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

import { constructSkillContract } from "../src/skill-contract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repositoryRoot, "src", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface EvaluationRunCapturedEnvelopes {
  readonly threadStartResult: Record<string, unknown>;
  readonly turnStartResult: Record<string, unknown>;
  readonly itemCompletedNotification: Record<string, unknown>;
  readonly turnCompletedNotification: Record<string, unknown>;
}

interface EvaluationPlaceholderContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly structuredOutput: string;
}

interface FaultInjectionFixture {
  readonly terminalTurns: {
    readonly failed: Record<string, unknown>;
    readonly cancelled: Record<string, unknown>;
  };
  readonly reconnect: {
    readonly liveNotification: Record<string, unknown>;
    readonly recoveredThread: Record<string, unknown> & {
      readonly turns: readonly Record<string, unknown>[];
    };
  };
  readonly evaluationRuns: {
    readonly obligationThreadId: string;
    readonly conformanceThreadId: string;
    readonly capturedEnvelopes: EvaluationRunCapturedEnvelopes;
  };
}

interface LiveFailureRecoveryFixture {
  readonly provenance: {
    readonly codexVersion: string;
    readonly kind: string;
  };
  readonly failure: {
    readonly errorNotification: Record<string, unknown>;
    readonly turnCompletedNotification: Record<string, unknown>;
  };
  readonly cancelledReconnect: {
    readonly recoveredThread: Record<string, unknown> & {
      readonly turns: readonly Record<string, unknown>[];
    };
    readonly turnCompletedNotification: Record<string, unknown>;
  };
  readonly evaluationRun: EvaluationRunCapturedEnvelopes;
}

async function readFaultInjectionFixture(): Promise<FaultInjectionFixture> {
  return JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "codex-0.145.0",
        "fault-injection.json",
      ),
      "utf8",
    ),
  ) as FaultInjectionFixture;
}

async function readLiveFailureRecoveryFixture(): Promise<LiveFailureRecoveryFixture> {
  return JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "codex-0.145.0",
        "live-failure-recovery.json",
      ),
      "utf8",
    ),
  ) as LiveFailureRecoveryFixture;
}

async function runCli(
  args: readonly string[],
  options: {
    readonly codexVersion: string;
    readonly codexBehavior?: string;
    readonly cwd?: string;
    readonly stdin?: string;
  },
): Promise<CliResult> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "agent-tracer-bin-"));
  const codexPath = path.join(binDirectory, "codex");
  await writeFile(
    codexPath,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo '${options.codexVersion}'\n  exit 0\nfi\n${options.codexBehavior ?? ""}\nexit 64\n`,
  );
  await chmod(codexPath, 0o755);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, cliPath, ...args],
      {
        cwd: options.cwd ?? repositoryRoot,
        env: {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end(options.stdin);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function respondToEvaluationRun(
  socket: WebSocket,
  request: Record<string, unknown>,
  fixture: {
    readonly obligations: readonly Record<string, unknown>[];
    readonly additionalItems?: readonly Record<string, unknown>[];
    readonly findings?: readonly Record<string, unknown>[];
    readonly threadId?: string;
    readonly turnId?: string;
    readonly capturedEnvelopes?: EvaluationRunCapturedEnvelopes;
  },
): boolean {
  const params = request.params as Record<string, unknown> | undefined;
  const isConformanceRun =
    (JSON.stringify(params?.outputSchema) ?? "").includes('"findings"') ||
    String(params?.baseInstructions).includes("evaluate Conformance");
  const threadId = isConformanceRun
    ? `${fixture.threadId ?? "fixture-evaluation-thread"}-conformance`
    : fixture.threadId ?? "fixture-evaluation-thread";
  const turnId = isConformanceRun
    ? `${fixture.turnId ?? "fixture-evaluation-turn"}-conformance`
    : fixture.turnId ?? "fixture-evaluation-turn";
  const evaluationContext: EvaluationPlaceholderContext = {
    threadId,
    turnId,
    structuredOutput: "",
  };
  if (request.method === "thread/start") {
    socket.send(
      JSON.stringify({
        id: request.id,
        result: materializeEvaluationEnvelope(
          fixture.capturedEnvelopes?.threadStartResult,
          { thread: { id: threadId } },
          evaluationContext,
        ),
      }),
    );
    return true;
  }
  if (request.method !== "turn/start") return false;
  socket.send(
    JSON.stringify({
      id: request.id,
      result: materializeEvaluationEnvelope(
        fixture.capturedEnvelopes?.turnStartResult,
        { turn: { id: turnId, status: "inProgress", items: [] } },
        evaluationContext,
      ),
    }),
  );
  setImmediate(() => {
    const input = (params?.input as readonly Record<string, unknown>[] | undefined)?.[0];
    const promptText = typeof input?.text === "string" ? input.text : "";
    const promptPayload = promptText.split("\n").at(-1);
    const prompt =
      promptPayload === undefined || promptPayload === ""
        ? null
        : (JSON.parse(promptPayload) as {
            readonly events?: readonly { readonly id?: string }[];
          });
    const defaultEvidenceEventId = prompt?.events?.[0]?.id;
    const findings =
      fixture.findings ??
      fixture.obligations
        .filter((obligation) => obligation.status === "evaluable")
        .map((obligation) => ({
          obligationId: obligation.id,
          state: "unobservable",
          evidenceEventIds:
            defaultEvidenceEventId === undefined
              ? []
              : [defaultEvidenceEventId],
          explanation: "The fixture does not provide reporting coverage.",
          assessment: {
            observationGapAffected: false,
            eventSourceCoverage: "limited",
            violationBasis: "none",
          },
        }));
    const structuredOutput = JSON.stringify(
      isConformanceRun ? { findings } : { obligations: fixture.obligations },
    );
    socket.send(
      JSON.stringify(
        materializeEvaluationEnvelope(
          fixture.capturedEnvelopes?.itemCompletedNotification,
          {
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: {
                type: "agentMessage",
                id: "fixture-evaluation-message",
                text: structuredOutput,
              },
            },
          },
          { ...evaluationContext, structuredOutput },
        ),
      ),
    );
    for (const item of isConformanceRun ? [] : fixture.additionalItems ?? []) {
      socket.send(
        JSON.stringify({
          method: "item/completed",
          params: { threadId, turnId, item },
        }),
      );
    }
    socket.send(
      JSON.stringify(
        materializeEvaluationEnvelope(
          fixture.capturedEnvelopes?.turnCompletedNotification,
          {
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: turnId,
                status: "completed",
                items: [],
              },
            },
          },
          evaluationContext,
        ),
      ),
    );
  });
  return true;
}

function replaceEvaluationPlaceholders(
  value: unknown,
  context: EvaluationPlaceholderContext,
): unknown {
  if (value === "{{EVALUATION_THREAD_ID}}") return context.threadId;
  if (value === "{{EVALUATION_TURN_ID}}") return context.turnId;
  if (value === "{{STRUCTURED_OUTPUT}}") return context.structuredOutput;
  if (Array.isArray(value)) {
    return value.map((item) => replaceEvaluationPlaceholders(item, context));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      replaceEvaluationPlaceholders(item, context),
    ]),
  );
}

function materializeEvaluationEnvelope(
  capturedEnvelope: Record<string, unknown> | undefined,
  fallbackEnvelope: Record<string, unknown>,
  context: EvaluationPlaceholderContext,
): unknown {
  return capturedEnvelope === undefined
    ? fallbackEnvelope
    : replaceEvaluationPlaceholders(capturedEnvelope, context);
}

function requestedThreadIds(
  requests: readonly Record<string, unknown>[],
  method: string,
): readonly string[] {
  return requests
    .filter((request) => request.method === method)
    .map((request) =>
      String(
        (request.params as { readonly threadId?: unknown } | undefined)
          ?.threadId,
      ),
    );
}

function traceFixtureObligations(
  skillPath: string,
): readonly Record<string, unknown>[] {
  const verificationPath = path.join(
    path.dirname(skillPath),
    "references",
    "verification.md",
  );
  const releaseChecksPath = path.join(
    path.dirname(skillPath),
    "references",
    "release-checks.md",
  );
  return [
    [skillPath, "Implement the work described by the developer."],
    [skillPath, "Inspect the requested change before editing it."],
    [skillPath, "Before sending the final output, run the tests."],
    [
      skillPath,
      "Follow the [verification workflow](references/verification.md).",
    ],
    [skillPath, "Run the output verification command after editing."],
    [
      verificationPath,
      "Run the targeted test after each behavioral change.\nThen read `release-checks.md` and follow its instructions.",
    ],
    [releaseChecksPath, "Run the full test suite once at the end."],
  ].map(([sourcePath, instruction], index) => ({
    id: `fixture-obligation-${index + 1}`,
    status: "evaluable",
    source: { path: sourcePath, instruction },
    observableBehavior: `The execution performs instruction ${index + 1}.`,
  }));
}

async function runObligationValidationFixture(
  obligations: readonly Record<string, unknown>[],
): Promise<CliResult> {
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "evaluation-fixture",
    "SKILL.md",
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["validation-observed-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "validation-observed-thread",
              turnId: "validation-observed-turn",
              item: {
                type: "userMessage",
                id: "validation-user",
                content: [
                  { type: "skill", name: "evaluation-fixture", path: skillPath },
                ],
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "validation-observed-thread",
                cwd: repositoryRoot,
                turns: [
                  {
                    id: "validation-observed-turn",
                    status: "completed",
                    items: [],
                  },
                ],
              },
            },
          }),
        );
      } else if (respondToEvaluationRun(socket, request, { obligations })) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  try {
    const address = server.address() as AddressInfo;
    return await runCli(
      ["trace", "--server", `ws://127.0.0.1:${address.port}`],
      { codexVersion: "codex-cli 0.145.0" },
    );
  } finally {
    server.close();
  }
}

function conformanceValidationObligations(
  skillPath: string,
): readonly Record<string, unknown>[] {
  return [
    "Call the release tool once.",
    "Do not call the release tool with dry-run disabled.",
    "Record every ambient filesystem mutation.",
    "If a deployment occurs, notify the release channel.",
    "Handle any exceptional circumstances appropriately.",
  ].map((instruction, index) =>
    index === 4
      ? {
          id: "ambiguous-5",
          status: "ambiguous",
          source: { path: skillPath, instruction },
          ambiguity: "Exceptional circumstances are not defined.",
        }
      : {
          id: `obligation-${index + 1}`,
          status: "evaluable",
          source: { path: skillPath, instruction },
          observableBehavior: `Observable behavior ${index + 1}.`,
        },
  );
}

async function runConformanceValidationFixture(options: {
  readonly status?: "completed" | "failed" | "interrupted";
  readonly itemsView?: "summary";
  readonly findings?: readonly Record<string, unknown>[];
  readonly cwd?: string;
  readonly traceArgs?: readonly string[];
  readonly sensitivePayload?: Record<string, unknown>;
}): Promise<CliResult> {
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "conformance-fixture",
    "SKILL.md",
  );
  const obligations = conformanceValidationObligations(skillPath);
  const status = options.status ?? "completed";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["validation-observed-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "validation-observed-thread",
              turnId: "validation-observed-turn",
              item: {
                type: "userMessage",
                id: "validation-user",
                content: [
                  { type: "skill", name: "conformance-fixture", path: skillPath },
                ],
              },
            },
          }),
        );
        const turns =
          options.itemsView === "summary"
            ? [
                {
                  id: "validation-observed-turn",
                  status,
                  itemsView: "summary",
                  items: [],
                },
              ]
            : [];
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: { id: "validation-observed-thread", turns },
            },
          }),
        );
        if (options.sensitivePayload !== undefined) {
          socket.send(
            JSON.stringify({
              method: "thread/futureActivity",
              params: {
                threadId: "validation-observed-thread",
                turnId: "validation-observed-turn",
                ...options.sensitivePayload,
              },
            }),
          );
        }
        if (options.itemsView !== "summary") {
          setImmediate(() => {
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "validation-observed-thread",
                  turn: {
                    id: "validation-observed-turn",
                    status,
                    error:
                      status === "failed"
                        ? { message: "fixture failure" }
                        : null,
                    items: [],
                  },
                },
              }),
            );
          });
        }
      } else if (
        respondToEvaluationRun(socket, request, {
          obligations,
          ...(options.findings === undefined
            ? {}
            : { findings: options.findings }),
        })
      ) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  try {
    const address = server.address() as AddressInfo;
    return await runCli(
      [
        "trace",
        "--server",
        `ws://127.0.0.1:${address.port}`,
        ...(options.traceArgs ?? []),
      ],
      {
        codexVersion: "codex-cli 0.145.0",
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
    );
  } finally {
    server.close();
  }
}

test("keeps Trace data in memory unless export is explicitly requested", async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-memory-only-"),
  );

  const result = await runConformanceValidationFixture({
    cwd: workingDirectory,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(await readdir(workingDirectory), []);
});

test("explicitly exports one versioned, self-contained, unredacted Saved Trace", async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-export-"),
  );
  const savedTracePath = path.join(workingDirectory, "audit.json");
  const sensitivePayload = {
    protocolSecret: "saved-secret-atlas",
    nested: { exact: ["alpha", 42, true, null] },
  };

  const result = await runConformanceValidationFixture({
    traceArgs: ["--export", savedTracePath],
    sensitivePayload,
  });
  const savedText = await readFile(savedTracePath, "utf8").catch(() => null);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.notEqual(savedText, null, "explicit export should write the requested file");
  const saved = JSON.parse(savedText ?? "null") as Record<string, unknown>;
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(Object.keys(saved).sort(), [
    "events",
    "findings",
    "obligations",
    "protocolCompatibility",
    "run",
    "schemaVersion",
    "skillAttribution",
    "skillContract",
    "terminalOutcome",
    "traceIntegrity",
  ]);
  assert.deepEqual(saved.protocolCompatibility, {
    codexCli: "0.145.0",
    codexAppServer: "0.145.0",
  });
  assert.deepEqual(saved.run, {
    threadId: "validation-observed-thread",
    cwd: null,
  });
  assert.deepEqual(saved.terminalOutcome, { kind: "completed" });
  assert.deepEqual(saved.traceIntegrity, { complete: true, gaps: [] });
  assert.deepEqual(saved.skillAttribution, {
    kind: "exact",
    rootSkill: {
      name: "conformance-fixture",
      path: path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "skills",
        "conformance-fixture",
        "SKILL.md",
      ),
    },
  });
  assert.ok(saved.skillContract);
  assert.equal((saved.obligations as readonly unknown[]).length, 5);
  assert.equal((saved.findings as readonly unknown[]).length, 4);
  const events = saved.events as readonly Record<string, unknown>[];
  assert.ok(events.length >= 3);
  assert.deepEqual(
    events.find(
      (event) =>
        (event.payload as Record<string, unknown>).protocolSecret ===
        "saved-secret-atlas",
    )?.payload,
    {
      threadId: "validation-observed-thread",
      turnId: "validation-observed-turn",
      ...sensitivePayload,
    },
  );
  assert.ok(
    events.every(
      (event) =>
        typeof event.id === "string" &&
        typeof event.sourceId === "string" &&
        typeof event.sourceSequence === "number" &&
        "causalParentId" in event &&
        "sourceParentId" in event &&
        typeof event.sourceDepth === "number",
    ),
  );
  assert.match(
    result.stdout,
    /WARNING: SAVED TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION/i,
  );
  assert.ok(
    result.stdout.indexOf("WARNING: SAVED TRACE") <
      result.stdout.indexOf(`Saved Trace exported to ${savedTracePath}`),
    result.stdout,
  );
});

test("loads a Saved Trace through the same terminal Event projection", async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-round-trip-"),
  );
  const savedTracePath = path.join(workingDirectory, "round-trip.json");
  const observed = await runConformanceValidationFixture({
    traceArgs: ["--export", savedTracePath],
    sensitivePayload: {
      protocolSecret: "round-trip-secret-atlas",
      nested: { preserved: ["one", 2, false, null] },
    },
  });

  const replayed = await runCli(["replay", "--file", savedTracePath], {
    codexVersion: "codex-cli 9.999.0",
  });

  assert.equal(observed.exitCode, 0, observed.stderr);
  assert.equal(replayed.exitCode, 0, replayed.stderr);
  const eventLines = (output: string): readonly string[] =>
    output
      .split("\n")
      .filter((line) => /^\s*\[[a-z-]+\].* event=/.test(line));
  assert.deepEqual(eventLines(replayed.stdout), eventLines(observed.stdout));
  assert.match(replayed.stdout, /round-trip-secret-atlas/);
  assert.match(
    replayed.stdout,
    /WARNING: SAVED TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION/i,
  );
  assert.match(replayed.stdout, /Skill Run terminal outcome: completed/);
  assert.match(replayed.stdout, /Trace integrity: complete/);
  assert.match(replayed.stdout, /Root Skill Attribution: exact/);
  assert.match(replayed.stdout, /\[Skill Contract\]/);
  assert.match(replayed.stdout, /\[Obligation obligation-1\]/);
  assert.match(replayed.stdout, /\[Finding obligation-1\]/);
});

test("rejects an unsupported Saved Trace schema version", async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-schema-version-"),
  );
  const savedTracePath = path.join(workingDirectory, "future.json");
  const observed = await runConformanceValidationFixture({
    traceArgs: ["--export", savedTracePath],
  });
  const saved = JSON.parse(
    await readFile(savedTracePath, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    savedTracePath,
    JSON.stringify({ ...saved, schemaVersion: 2 }),
  );

  const replayed = await runCli(["replay", "--file", savedTracePath], {
    codexVersion: "codex-cli 0.145.0",
  });

  assert.equal(observed.exitCode, 0, observed.stderr);
  assert.equal(replayed.exitCode, 1);
  assert.match(replayed.stderr, /Saved Trace schema version must be 1/i);
});

test("rejects Saved Trace protocol metadata from an unsupported Codex version", async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-protocol-version-"),
  );
  const savedTracePath = path.join(workingDirectory, "incompatible.json");
  const observed = await runConformanceValidationFixture({
    traceArgs: ["--export", savedTracePath],
  });
  const saved = JSON.parse(
    await readFile(savedTracePath, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    savedTracePath,
    JSON.stringify({
      ...saved,
      protocolCompatibility: {
        codexCli: "0.145.0",
        codexAppServer: "0.146.0",
      },
    }),
  );

  const replayed = await runCli(["replay", "--file", savedTracePath], {
    codexVersion: "codex-cli 0.145.0",
  });

  assert.equal(observed.exitCode, 0, observed.stderr);
  assert.equal(replayed.exitCode, 1);
  assert.match(replayed.stderr, /protocol compatibility must be Codex 0\.145\.0/i);
});

test("rejects an unsupported Codex version before observation", async () => {
  const result = await runCli(["trace", "--server", "ws://127.0.0.1:1"], {
    codexVersion: "codex-cli 0.146.0",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires exactly codex-cli 0\.145\.0/i);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("launches the local Trace Explorer command without opening a browser when requested", async () => {
  const result = await runCli(
    ["web", "--server", "ws://127.0.0.1:1", "--no-open"],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Trace Explorer: http:\/\/127\.0\.0\.1:4310/);
  assert.match(
    result.stdout,
    /codex --remote ws:\/\/127\.0\.0\.1:1/,
  );
  assert.match(result.stdout, /Trace Explorer collection failed:/);
  assert.equal(result.stderr, "");
});

test("traces the only loaded thread through a fake App Server", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              userAgent:
                "agent-tracer/0.145.0 (Mac OS 14.6.1; arm64) vscode/1.130.0 (agent-tracer; 0.1.0)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id,
            result: { thread: { id: "thread-one", turns: [] } },
          }),
        );

        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                startedAtMs: 100,
                item: {
                  type: "userMessage",
                  id: "user-one",
                  clientId: "client-one",
                  content: [{ type: "text", text: "trace this proprietary prompt" }],
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-other",
                turnId: "turn-other",
                completedAtMs: 110,
                item: {
                  type: "commandExecution",
                  id: "not-observed",
                  command: "must-not-appear",
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 130,
                item: {
                  type: "webSearch",
                  id: "search-one",
                  query: "private search terms",
                  action: { type: "search", query: "private search terms" },
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 140,
                item: {
                  type: "imageGeneration",
                  id: "image-one",
                  revisedPrompt: "private image prompt",
                  result: "data:image/png;base64,unredacted",
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 120,
                item: {
                  type: "mcpToolCall",
                  id: "tool-one",
                  server: "example",
                  tool: "lookup",
                  status: "completed",
                  arguments: { token: "secret-tool-argument" },
                  result: { content: [{ type: "text", text: "tool result" }] },
                  durationMs: 20,
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 150,
                item: {
                  type: "commandExecution",
                  id: "command-one",
                  command: "pwd",
                  cwd: "/workspace/private",
                  status: "completed",
                  aggregatedOutput: "/workspace/private\n",
                  exitCode: 0,
                  durationMs: 30,
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-one",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /WARNING.*UNREDACTED SENSITIVE INFORMATION/i);
  assert.match(result.stdout, /sent unredacted\s+to OpenAI/i);
  assert.match(result.stdout, /automatically selected.*thread-one/i);
  assert.match(result.stdout, /Skill Run terminal outcome: completed/);
  assert.match(result.stdout, /Trace integrity: complete/);
  assert.match(result.stdout, /^\[user\] item\/started .*proprietary prompt/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*secret-tool-argument.*tool result/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*private search terms/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*private image prompt/m);
  assert.match(
    result.stdout,
    /^\[command\] item\/completed .*"command":"pwd".*"cwd":"\/workspace\/private".*"aggregatedOutput":"\/workspace\/private\\n".*"exitCode":0.*"durationMs":30/m,
  );
  assert.doesNotMatch(result.stdout, /must-not-appear/);

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
  assert.deepEqual(requests[3]?.params, { threadId: "thread-one" });
});

test("replays the captured 0.145.0 code-review fixture through the black-box boundary", async (t) => {
  const fixturePath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "codex-0.145.0",
    "live-code-review.json",
  );
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "acceptance-code-review",
    "SKILL.md",
  );
  const fixtureText = (await readFile(fixturePath, "utf8")).replaceAll(
    "{{REPOSITORY_ROOT}}",
    repositoryRoot,
  );
  const fixture = JSON.parse(fixtureText) as {
    readonly capture: { readonly codexVersion: string };
    readonly threadId: string;
    readonly history: Record<string, unknown>;
    readonly notifications: readonly Record<string, unknown>[];
    readonly childResumeResponses: readonly {
      readonly result: {
        readonly thread: {
          readonly id: string;
          readonly parentThreadId: string;
          readonly threadSource: string;
          readonly turns: readonly {
            readonly status: string;
            readonly items: readonly Record<string, unknown>[];
          }[];
        };
      };
    }[];
  };
  const liveFailureRecoveryFixture = await readLiveFailureRecoveryFixture();
  const acceptanceContract = await constructSkillContract({
    name: "acceptance-code-review",
    path: skillPath,
  });
  const obligations = acceptanceContract.sources.flatMap((source) =>
    source.instructions.split("\n\n").map((instruction, index) => ({
      id: `acceptance-obligation-${index + 1}`,
      status: "evaluable",
      source: { path: source.path, instruction },
      observableBehavior: `The captured run performs acceptance behavior ${index + 1}.`,
    })),
  );
  const requests: Array<Record<string, unknown>> = [];
  const exportDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-captured-acceptance-"),
  );
  const savedTracePath = path.join(exportDirectory, "captured.json");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              userAgent: `agent-tracer/${fixture.capture.codexVersion} (Mac OS; arm64)`,
            },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: [fixture.threadId], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        const params = request.params as { readonly threadId?: unknown };
        if (params.threadId === fixture.threadId) {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { cwd: repositoryRoot, thread: fixture.history },
            }),
          );
          setImmediate(() => {
            for (const notification of fixture.notifications) {
              socket.send(JSON.stringify(notification));
            }
          });
        } else {
          const childResponse = fixture.childResumeResponses.find(
            ({ result }) => result.thread.id === params.threadId,
          );
          assert.notEqual(childResponse, undefined);
          socket.send(
            JSON.stringify({ id: request.id, result: childResponse?.result }),
          );
        }
      } else if (request.method === "skills/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              data: [
                {
                  cwd: repositoryRoot,
                  errors: [],
                  skills: [
                    {
                      name: "acceptance-code-review",
                      path: skillPath,
                      description: "fixture",
                      scope: "repo",
                      enabled: true,
                    },
                  ],
                },
              ],
            },
          }),
        );
      } else if (
        respondToEvaluationRun(socket, request, {
          obligations,
          threadId: "captured-evaluation-thread",
          capturedEnvelopes:
            liveFailureRecoveryFixture.evaluationRun,
        })
      ) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    [
      "trace",
      "--server",
      `ws://127.0.0.1:${address.port}`,
      "--export",
      savedTracePath,
    ],
    { codexVersion: "codex-cli 0.145.0", stdin: "y\n" },
  );
  const saved = JSON.parse(await readFile(savedTracePath, "utf8")) as {
    readonly events: readonly Record<string, unknown>[];
  };

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Automatically selected the only loaded thread/);
  assert.match(result.stdout, /Confirm inferred Root Skill.*\[y\/N\]:/);
  assert.match(result.stdout, /Root Skill Attribution: confirmed/);
  assert.match(result.stdout, /^\[command\].*git diff --stat/m);
  assert.match(result.stdout, /^\[resource\].*"totalTokens":144/m);
  assert.match(
    result.stdout,
    /^\[collaboration\].*captured-standards-thread.*standards_review/m,
  );
  assert.match(
    result.stdout,
    /^\[collaboration\].*captured-spec-thread.*spec_review/m,
  );
  assert.match(
    result.stdout,
    /^  \[agent\].*source=captured-standards-thread.*Sanitized Standards reviewer result/m,
  );
  assert.match(
    result.stdout,
    /^  \[agent\].*source=captured-spec-thread.*Sanitized Spec reviewer result/m,
  );
  assert.doesNotMatch(result.stdout, /^\[unknown\].*thread\/goal\/cleared/m);
  assert.match(result.stdout, /"durationMs":2000/);
  assert.match(result.stdout, /Skill Run terminal outcome: completed/);
  assert.match(result.stdout, /Finding summary:/);
  assert.match(result.stdout, /Saved Trace exported/);
  assert.equal(fixture.childResumeResponses.length, 2);
  assert.equal(
    fixture.childResumeResponses.every(
      ({ result }) =>
        result.thread.parentThreadId === fixture.threadId &&
        result.thread.threadSource === "subagent" &&
        result.thread.turns.some(
          (turn) => turn.status === "completed" && turn.items.length > 0,
        ),
    ),
    true,
  );
  assert.deepEqual(
    [...new Set(saved.events.map((event) => event.sourceId))].sort(),
    [
      fixture.threadId,
      ...fixture.childResumeResponses.map(({ result }) => result.thread.id),
    ].sort(),
  );
  assert.deepEqual(
    requestedThreadIds(requests, "thread/resume"),
    [
      fixture.threadId,
      ...fixture.childResumeResponses.map(({ result }) => result.thread.id),
    ],
  );
  assert.deepEqual(
    requestedThreadIds(requests, "thread/unsubscribe").filter((threadId) =>
      [
        fixture.threadId,
        ...fixture.childResumeResponses.map(({ result }) => result.thread.id),
      ].includes(threadId),
    ),
    [
      fixture.threadId,
      ...fixture.childResumeResponses.map(({ result }) => result.thread.id),
    ],
  );
  assert.deepEqual(
    Object.keys(liveFailureRecoveryFixture.evaluationRun),
    [
      "threadStartResult",
      "turnStartResult",
      "itemCompletedNotification",
      "turnCompletedNotification",
    ],
  );
  assert.equal(
    saved.events.some((event) =>
      JSON.stringify(event).includes(
        "captured-evaluation-thread",
      ),
    ),
    false,
  );
  assert.equal(
    requests.some((request) => {
      const params = request.params as { readonly threadId?: unknown } | undefined;
      return (
        params?.threadId === fixture.threadId &&
        ["turn/start", "turn/steer", "turn/interrupt"].includes(
          String(request.method),
        )
      );
    }),
    false,
  );
});

test("commits sanitized Saved Trace evidence for the real code-review acceptance", async () => {
  const evidence = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "test",
        "fixtures",
        "codex-0.145.0",
        "live-code-review-saved-trace.json",
      ),
      "utf8",
    ),
  ) as {
    readonly schemaVersion: number;
    readonly protocolCompatibility: {
      readonly codexCli: string;
      readonly codexAppServer: string;
    };
    readonly terminalOutcome: { readonly kind: string };
    readonly traceIntegrity: { readonly complete: boolean };
    readonly events: readonly {
      readonly id: string;
      readonly sourceId: string;
      readonly payload: {
        readonly turnId?: string;
        readonly turn?: { readonly id?: string };
      };
    }[];
    readonly obligations: readonly unknown[];
    readonly findings: readonly {
      readonly state: string;
      readonly evidenceEventIds: readonly string[];
    }[];
  };

  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.protocolCompatibility, {
    codexCli: "0.145.0",
    codexAppServer: "0.145.0",
  });
  assert.equal(evidence.terminalOutcome.kind, "completed");
  assert.equal(evidence.traceIntegrity.complete, false);
  assert.equal(evidence.events.length, 15);
  assert.equal(evidence.obligations.length, 17);
  assert.deepEqual(
    Object.fromEntries(
      ["satisfied", "unobservable", "not applicable", "violated"].map(
        (state) => [
          state,
          evidence.findings.filter((finding) => finding.state === state).length,
        ],
      ),
    ),
    { satisfied: 16, unobservable: 0, "not applicable": 1, violated: 0 },
  );
  assert.deepEqual(
    [...new Set(evidence.events.map((event) => event.sourceId))].sort(),
    [
      "captured-parent-thread",
      "captured-spec-thread",
      "captured-standards-thread",
    ],
  );
  const turnsBySource = new Map<string, Set<string>>();
  for (const event of evidence.events) {
    const turnId = event.payload.turnId ?? event.payload.turn?.id;
    if (turnId === undefined) continue;
    const turns = turnsBySource.get(event.sourceId) ?? new Set<string>();
    turns.add(turnId);
    turnsBySource.set(event.sourceId, turns);
  }
  assert.deepEqual(
    Object.fromEntries(
      [...turnsBySource].map(([sourceId, turns]) => [
        sourceId,
        [...turns],
      ]),
    ),
    {
      "captured-parent-thread": ["captured-code-review-turn"],
      "captured-standards-thread": ["captured-standards-turn"],
      "captured-spec-thread": ["captured-spec-turn"],
    },
  );
  const eventIds = new Set(evidence.events.map((event) => event.id));
  assert.equal(
    evidence.findings.every((finding) =>
      finding.evidenceEventIds.every((eventId) => eventIds.has(eventId)),
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(evidence), /michaelvasandani|\/Users\//i);
});

test("marks partial descendant history as an Incomplete Trace", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      const params = request.params as { readonly threadId?: unknown } | undefined;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["partial-parent"], nextCursor: null },
          }),
        );
      } else if (
        request.method === "thread/resume" &&
        params?.threadId === "partial-parent"
      ) {
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "partial-parent",
              turnId: "unrelated-buffered-turn",
              item: {
                type: "agentMessage",
                id: "unrelated-buffered-message",
                text: "must-not-mix-a-buffered-skill-run",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "must-not-mix-a-turnless-root-event",
            params: {
              threadId: "partial-parent",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "partial-parent",
                turns: [
                  {
                    id: "unrelated-earlier-turn",
                    itemsView: "full",
                    status: "completed",
                    items: [
                      {
                        type: "agentMessage",
                        id: "unrelated-earlier-message",
                        text: "must-not-mix-an-earlier-skill-run",
                      },
                    ],
                  },
                  {
                    id: "partial-parent-turn",
                    startedAt: 100,
                    completedAt: 200,
                    itemsView: "full",
                    status: "completed",
                    items: [
                      {
                        type: "subAgentActivity",
                        id: "partial-child-start",
                        kind: "started",
                        agentThreadId: "partial-child",
                        agentPath: "/root/partial-child",
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (
        request.method === "thread/resume" &&
        params?.threadId === "partial-child"
      ) {
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "partial-parent",
              turnId: "later-root-turn",
              item: {
                type: "agentMessage",
                id: "later-root-message",
                text: "must-not-contaminate-the-finished-skill-run",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "partial-child",
                createdAt: 120,
                turns: [
                  {
                    id: "unrelated-earlier-child-turn",
                    startedAt: 90,
                    completedAt: 95,
                    itemsView: "full",
                    status: "completed",
                    items: [
                      {
                        type: "agentMessage",
                        id: "unrelated-earlier-child-message",
                        text: "must-not-mix-earlier-child-history",
                      },
                    ],
                  },
                  {
                    id: "causal-earlier-child-turn",
                    startedAt: 130,
                    completedAt: 150,
                    itemsView: "full",
                    status: "completed",
                    items: [
                      {
                        type: "agentMessage",
                        id: "causal-earlier-child-message",
                        text: "include-an-earlier-causal-child-turn",
                      },
                    ],
                  },
                  {
                    id: "partial-child-turn",
                    startedAt: 160,
                    completedAt: 180,
                    itemsView: "summary",
                    status: "completed",
                    items: [
                      {
                        type: "agentMessage",
                        id: "partial-child-message",
                        text: "available child summary",
                      },
                    ],
                  },
                  {
                    id: "unrelated-later-child-turn",
                    startedAt: 220,
                    completedAt: 230,
                    itemsView: "full",
                    status: "completed",
                    items: [
                      {
                        type: "agentMessage",
                        id: "unrelated-later-child-message",
                        text: "must-not-mix-later-child-history",
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    result.stdout,
    /source=partial-child.*include-an-earlier-causal-child-turn/m,
  );
  assert.match(result.stdout, /source=partial-child.*available child summary/m);
  assert.match(
    result.stdout,
    /Incomplete Trace:.*sources=partial-child;.*itemsView=summary/i,
  );
  assert.doesNotMatch(result.stdout, /sources=partial-parent,partial-child/);
  assert.doesNotMatch(
    result.stdout,
    /must-not-contaminate-the-finished-skill-run/,
  );
  assert.doesNotMatch(result.stdout, /must-not-mix-an-earlier-skill-run/);
  assert.doesNotMatch(result.stdout, /must-not-mix-a-buffered-skill-run/);
  assert.doesNotMatch(
    result.stdout,
    /^\[unknown\] must-not-mix-a-turnless-root-event/m,
  );
  assert.match(
    result.stdout,
    /Incomplete Trace:.*turn-less root notification must-not-mix-a-turnless-root-event could not be attributed/i,
  );
  assert.doesNotMatch(result.stdout, /must-not-mix-earlier-child-history/);
  assert.doesNotMatch(result.stdout, /must-not-mix-later-child-history/);
});

test("reports failed and cancelled Skill Run outcomes without calling them Incomplete Traces", async (t) => {
  const liveFixture = await readLiveFailureRecoveryFixture();
  const terminalNotifications = [
    [
      liveFixture.failure.errorNotification,
      liveFixture.failure.turnCompletedNotification,
    ],
    [liveFixture.cancelledReconnect.turnCompletedNotification],
  ];
  let connectionNumber = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const notifications = terminalNotifications[connectionNumber++] ?? [];
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-terminal"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-terminal",
                turns: [],
              },
            },
          }),
        );
        setImmediate(() => {
          for (const notification of notifications) {
            socket.send(JSON.stringify(notification));
          }
        });
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const serverUrl = `ws://127.0.0.1:${address.port}`;
  const failed = await runCli(["trace", "--server", serverUrl], {
    codexVersion: "codex-cli 0.145.0",
  });
  const cancelled = await runCli(["trace", "--server", serverUrl], {
    codexVersion: "codex-cli 0.145.0",
  });

  assert.equal(failed.exitCode, 0, failed.stderr);
  assert.match(
    failed.stdout,
    /Skill Run terminal outcome: failed.*captured invalid model request/,
  );
  assert.match(failed.stdout, /^\[error\] error/m);
  assert.match(failed.stdout, /Trace integrity: complete/);
  assert.doesNotMatch(failed.stdout, /Incomplete Trace/);

  assert.equal(cancelled.exitCode, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Skill Run terminal outcome: cancelled/);
  assert.match(cancelled.stdout, /Trace integrity: complete/);
  assert.doesNotMatch(cancelled.stdout, /failed|Incomplete Trace/);
});

test("replays the captured 0.145.0 disconnect, resume, and cancellation envelopes", async (t) => {
  const fixture = await readLiveFailureRecoveryFixture();
  let connectionNumber = 0;
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const connection = ++connectionNumber;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-terminal"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: fixture.cancelledReconnect.recoveredThread },
          }),
        );
        setImmediate(() => {
          if (connection === 1) {
            socket.close();
          } else {
            socket.send(
              JSON.stringify(
                fixture.cancelledReconnect.turnCompletedNotification,
              ),
            );
          }
        });
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fixture.provenance.codexVersion, "0.145.0");
  assert.equal(
    fixture.provenance.kind,
    "sanitized-real-shared-app-server-capture",
  );
  assert.match(result.stdout, /Connection interruption detected/);
  assert.match(result.stdout, /Available item history recovery complete/);
  assert.match(result.stdout, /Skill Run terminal outcome: cancelled/);
  assert.deepEqual(
    requests.filter((request) => request.method === "thread/resume").length,
    2,
  );
});

test("reconnects, recovers all available item history, and deduplicates activity", async (t) => {
  const faultFixture = await readFaultInjectionFixture();
  let connectionNumber = 0;
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const connection = ++connectionNumber;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-recovery"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume" && connection === 1) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "thread-recovery", turns: [] } },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify(faultFixture.reconnect.liveNotification),
            () => socket.close(),
          );
        });
      } else if (request.method === "thread/resume" && connection === 2) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                ...faultFixture.reconnect.recoveredThread,
                turns: [
                  ...faultFixture.reconnect.recoveredThread.turns,
                  {
                    id: "later-unrelated-turn",
                    status: "completed",
                    itemsView: "full",
                    error: null,
                    items: [
                      {
                        id: "later-unrelated-message",
                        type: "agentMessage",
                        text: "must-not-switch-skill-runs-during-recovery",
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Connection interruption detected/);
  assert.match(result.stdout, /Attempting history recovery/);
  assert.match(result.stdout, /Available item history recovery complete/);
  assert.match(result.stdout, /recovered output/);
  assert.equal(result.stdout.match(/recover this trace/g)?.length, 1);
  assert.doesNotMatch(
    result.stdout,
    /must-not-switch-skill-runs-during-recovery/,
  );
  assert.match(result.stdout, /Skill Run terminal outcome: completed/);
  assert.match(
    result.stdout,
    /Incomplete Trace:.*sources=thread-recovery.*notification-only activity is unavailable from resumed history/,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "initialize",
      "initialized",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
});

test("marks a recovered terminal run incomplete when reconnect history has a known gap", async (t) => {
  let connectionNumber = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const connection = ++connectionNumber;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-gap"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume" && connection === 1) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "thread-gap", turns: [] } },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "thread-gap",
                turnId: "turn-gap",
                item: {
                  id: "user-gap",
                  type: "userMessage",
                  content: [{ type: "text", text: "trace before gap" }],
                },
              },
            }),
            () => socket.close(),
          );
        });
      } else if (request.method === "thread/resume" && connection === 2) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-gap",
                turns: [
                  {
                    id: "turn-gap",
                    status: "completed",
                    itemsView: "summary",
                    error: null,
                    items: [],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Skill Run terminal outcome: completed/);
  assert.match(
    result.stdout,
    /Incomplete Trace:.*interval=after thread-gap\/turn-gap\/user-gap\/started through reconnect history.*sources=thread-gap.*itemsView=summary/,
  );
  assert.doesNotMatch(result.stdout, /Skill Run terminal outcome: failed/);
  assert.doesNotMatch(result.stdout, /Trace integrity: complete/);
});

test("marks partial initial history as an Incomplete Trace", async (t) => {
  let connectionNumber = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const itemsView = connectionNumber++ === 0 ? "notLoaded" : "full";
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-initial-gap"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-initial-gap",
                turns: [
                  {
                    id: "turn-initial-gap",
                    status: "completed",
                    itemsView,
                    error: null,
                    items: [],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Skill Run terminal outcome: completed/);
  assert.match(
    result.stdout,
    /Incomplete Trace:.*interval=observation start through initial history.*sources=thread-initial-gap.*itemsView=notLoaded/,
  );
  assert.doesNotMatch(result.stdout, /Trace integrity: complete/);

  const fullItemHistory = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );
  assert.equal(fullItemHistory.exitCode, 0, fullItemHistory.stderr);
  assert.match(
    fullItemHistory.stdout,
    /Incomplete Trace:.*interval=observation start through initial history.*sources=thread-initial-gap.*notification-only activity before attachment is unavailable from resumed history/,
  );
  assert.doesNotMatch(fullItemHistory.stdout, /Trace integrity: complete/);
});

test("reports an Incomplete Trace when history recovery fails", async (t) => {
  let connectionNumber = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    const connection = ++connectionNumber;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-recovery-fails"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume" && connection === 1) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "thread-recovery-fails", turns: [] } },
          }),
        );
        setImmediate(() => socket.close());
      } else if (request.method === "thread/resume" && connection === 2) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32000, message: "history unavailable" },
          }),
        );
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(
    result.stdout,
    /Incomplete Trace:.*interval=observation start through failed history recovery.*sources=thread-recovery-fails.*history unavailable/,
  );
  assert.match(result.stderr, /history unavailable/);
  assert.doesNotMatch(result.stdout, /Trace integrity: complete/);
});

test("requires an explicit selection when multiple threads are loaded", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)",
            },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              data: ["thread-most-recent", "thread-intended"],
              nextCursor: null,
            },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id,
            result: { thread: { id: "thread-intended", turns: [] } },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-intended",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: { status: "unsubscribed" } }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0", stdin: "2\n" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /1\. thread-most-recent/);
  assert.match(result.stdout, /2\. thread-intended/);
  assert.match(result.stdout, /Select a loaded thread \[1-2\]:/);
  assert.match(result.stdout, /Selected loaded thread: thread-intended/);
  assert.deepEqual(requests[3]?.params, { threadId: "thread-intended" });
  assert.equal(
    requests.some((request) =>
      ["turn/start", "turn/steer", "turn/interrupt"].includes(
        String(request.method),
      ),
    ),
    false,
  );
});

test("replays history before live activity without duplicating Events", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              startedAtMs: 100,
              item: {
                type: "userMessage",
                id: "user-history",
                clientId: "client-one",
                content: [{ type: "text", text: "historical prompt" }],
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 120,
              item: {
                type: "commandExecution",
                id: "command-history",
                command: "echo historical-secret",
                cwd: "/workspace",
                status: "completed",
                aggregatedOutput: "historical-secret\n",
                exitCode: 0,
                durationMs: 10,
              },
            },
          }),
        );
        for (const [itemId, method, completedAtMs] of [
          ["concurrent-a", "item/started", 124],
          ["concurrent-b", "item/completed", 126],
          ["concurrent-a", "item/completed", 127],
        ] as const) {
          socket.send(
            JSON.stringify({
              method,
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                ...(method === "item/started"
                  ? { startedAtMs: completedAtMs }
                  : { completedAtMs }),
                item: {
                  type: "mcpToolCall",
                  id: itemId,
                  server: "example",
                  tool: "concurrent",
                  status: method === "item/started" ? "inProgress" : "completed",
                  arguments: { itemId },
                  result: { content: [{ type: "text", text: itemId }] },
                  durationMs: 15,
                },
              },
            }),
          );
        }
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 125,
              item: {
                type: "mcpToolCall",
                id: "tool-progress",
                server: "example",
                tool: "long-running",
                status: "completed",
                arguments: { value: "finished-live" },
                result: {
                  content: [{ type: "text", text: "finished result" }],
                },
                durationMs: 20,
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 130,
              item: {
                type: "mcpToolCall",
                id: "tool-live",
                server: "example",
                tool: "lookup",
                status: "completed",
                arguments: { value: "live-secret" },
                result: { content: [{ type: "text", text: "live result" }] },
                durationMs: 5,
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id,
            result: {
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "inProgress",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-history",
                        clientId: "client-one",
                        content: [
                          { type: "text", text: "historical prompt" },
                        ],
                      },
                      {
                        type: "commandExecution",
                        id: "command-history",
                        command: "echo historical-secret",
                        cwd: "/workspace",
                        status: "completed",
                        aggregatedOutput: "historical-secret\n",
                        exitCode: 0,
                        durationMs: 10,
                      },
                      {
                        type: "mcpToolCall",
                        id: "tool-progress",
                        server: "example",
                        tool: "long-running",
                        status: "inProgress",
                        arguments: { value: "started-in-history" },
                        result: null,
                        durationMs: null,
                      },
                      ...["concurrent-a", "concurrent-b"].map((itemId) => ({
                        type: "mcpToolCall",
                        id: itemId,
                        server: "example",
                        tool: "concurrent",
                        status: "completed",
                        arguments: { itemId },
                        result: { content: [{ type: "text", text: itemId }] },
                        durationMs: 15,
                      })),
                    ],
                  },
                ],
              },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-one",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: { status: "unsubscribed" } }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const historicalPromptIndex = result.stdout.indexOf("historical prompt");
  const liveActivityIndex = result.stdout.indexOf("live-secret");
  assert.notEqual(historicalPromptIndex, -1, result.stdout);
  assert.notEqual(liveActivityIndex, -1, result.stdout);
  assert.ok(historicalPromptIndex < liveActivityIndex, result.stdout);
  assert.equal(result.stdout.match(/echo historical-secret/g)?.length, 1);
  assert.equal(result.stdout.match(/historical prompt/g)?.length, 1);
  assert.match(result.stdout, /"completedAtMs":120/);
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/user-history\/started source=thread-one sequence=1 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/command-history\/completed source=thread-one sequence=2 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-progress\/started source=thread-one sequence=3 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-a\/started source=thread-one sequence=4 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-b\/completed source=thread-one sequence=5 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-a\/completed source=thread-one sequence=6 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-progress\/completed source=thread-one sequence=7 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-live\/completed source=thread-one sequence=8 parent=thread-one\/turn-one/,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
});

test("finishes from terminal history when completion raced attachment", async (t) => {
  const methods: string[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      methods.push(String(request.method));
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "completed",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-one",
                        content: [{ type: "text", text: "finished in history" }],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { status: "unsubscribed" },
          }),
        );
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /finished in history/);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/loaded/list",
    "thread/resume",
    "thread/unsubscribe",
  ]);
});

test("rejects an unsupported App Server before listing threads", async (t) => {
  const methods: string[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof request.method === "string") methods.push(request.method);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              userAgent: "agent-tracer/0.146.0 (Mac OS; arm64)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /requires exactly Codex App Server 0\.145\.0/);
  assert.deepEqual(methods, ["initialize"]);
});

test("starts and owns a foreground shared App Server", async () => {
  const result = await runCli(
    ["server", "--listen", "ws://127.0.0.1:4555"],
    {
      codexVersion: "codex-cli 0.145.0",
      codexBehavior:
        'if [ "$1" = "app-server" ]; then\n  echo "fake app server: $*"\n  exit 23\nfi',
    },
  );

  assert.equal(result.exitCode, 23, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /Connect the interactive Codex TUI with:\ncodex --remote ws:\/\/127\.0\.0\.1:4555/,
  );
  assert.match(
    result.stdout,
    /fake app server: app-server --listen ws:\/\/127\.0\.0\.1:4555/,
  );
});

test("uses exact live Root Skill metadata to construct the recursive execution-only Skill Contract", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "trace-fixture",
    "SKILL.md",
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              startedAtMs: 100,
              item: {
                type: "userMessage",
                id: "user-one",
                content: [
                  { type: "skill", name: "trace-fixture", path: skillPath },
                  { type: "text", text: "Please run the selected skill." },
                ],
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-one",
                cwd: repositoryRoot,
                turns: [
                  {
                    id: "turn-one",
                    status: "inProgress",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-one",
                        content: [
                          {
                            type: "text",
                            text: "Please run $trace-fixture.",
                            text_elements: [],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-one",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
      } else if (
        respondToEvaluationRun(socket, request, {
          obligations: traceFixtureObligations(skillPath),
        })
      ) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Root Skill Attribution: exact.*trace-fixture/);
  assert.doesNotMatch(result.stdout, /Confirm inferred Root Skill/);
  assert.match(result.stdout, /Implement the work described by the developer\./);
  assert.match(result.stdout, /Inspect the requested change before editing it\./);
  assert.match(result.stdout, /Before sending the final output, run the tests\./);
  assert.match(result.stdout, /Run the targeted test after each behavioral change\./);
  assert.match(result.stdout, /Run the output verification command after editing\./);
  assert.match(result.stdout, /Run the full test suite once at the end\./);
  assert.doesNotMatch(result.stdout, /elegant final answer/);
  assert.doesNotMatch(result.stdout, /polished report/);
  assert.doesNotMatch(result.stdout, /fixture exists only/);
  assert.doesNotMatch(result.stdout, /descriptive list item/);
  assert.doesNotMatch(result.stdout, /Use Markdown\./);
  assert.doesNotMatch(result.stdout, /Keep it concise\./);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/unsubscribe",
    ],
  );
});

test("compiles source-linked Obligations in an isolated Evaluation Run", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let connections = 0;
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "evaluation-fixture",
    "SKILL.md",
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["observed-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "observed-thread",
              turnId: "observed-turn",
              item: {
                type: "userMessage",
                id: "observed-user",
                content: [
                  { type: "skill", name: "evaluation-fixture", path: skillPath },
                ],
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "observed-thread",
                cwd: repositoryRoot,
                turns: [
                  {
                    id: "observed-turn",
                    status: "inProgress",
                    items: [],
                  },
                ],
              },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "observed-thread",
                turn: { id: "observed-turn", status: "completed", items: [] },
              },
            }),
          );
        });
      } else if (
        respondToEvaluationRun(socket, request, {
          threadId: "evaluation-thread",
          turnId: "evaluation-turn",
          obligations: [
            {
              id: "obligation-1",
              status: "evaluable",
              source: { blockId: "source-1:block-1" },
              observableBehavior:
                "The release tool is called exactly once with contract-secret-atlas.",
            },
            {
              id: "obligation-2",
              status: "ambiguous",
              source: { blockId: "source-1:block-2" },
              ambiguity:
                "The instruction does not define which details or observable handling is appropriate.",
            },
          ],
          additionalItems: [
            {
              type: "commandExecution",
              id: "evaluation-only-command",
              command: "must-not-enter-observed-events",
            },
          ],
        })
      ) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(
    result.stdout.indexOf("WARNING: THIS LIVE TRACE") <
      result.stdout.indexOf("[Obligation obligation-1]"),
    result.stdout,
  );
  assert.match(
    result.stdout,
    /\[Obligation obligation-1\] status=evaluable.*Upload the unredacted contract-secret-atlas.*release tool is called exactly once/,
  );
  assert.match(
    result.stdout,
    /\[Obligation obligation-2\] status=ambiguous.*Handle the remaining details appropriately.*does not define which details/,
  );
  assert.doesNotMatch(result.stdout, /must-not-enter-observed-events/);

  const threadStart = requests.find(
    (request) => request.method === "thread/start",
  );
  assert.deepEqual(threadStart?.params, {
    modelProvider: "openai",
    cwd: path.dirname(skillPath),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    baseInstructions:
      "You compile Skill Contracts into structured execution Obligations. Do not use tools or inspect the workspace. Return only the requested JSON.",
  });
  const turnStart = requests.find((request) => request.method === "turn/start");
  assert.equal(connections, 1);
  assert.equal(
    (turnStart?.params as { threadId?: unknown } | undefined)?.threadId,
    "evaluation-thread",
  );
  assert.match(
    JSON.stringify(turnStart?.params),
    /unredacted contract-secret-atlas/,
  );
  assert.equal(
    (
      turnStart?.params as
        | { outputSchema?: { properties?: { obligations?: { type?: unknown } } } }
        | undefined
    )?.outputSchema?.properties?.obligations?.type,
    "array",
  );
  assert.doesNotMatch(JSON.stringify(turnStart?.params), /"oneOf"/);
  assert.deepEqual(
    requests
      .filter((request) => request.method === "thread/unsubscribe")
      .map((request) =>
        (request.params as { threadId?: unknown } | undefined)?.threadId,
      ),
    ["evaluation-thread", "evaluation-thread-conformance", "observed-thread"],
  );
  assert.equal(
    requests.some(
      (request) =>
        request.method === "turn/start" &&
        (request.params as { threadId?: unknown }).threadId === "observed-thread",
    ),
    false,
  );
});

test("rejects an Evaluation Run source link that is only an instruction fragment", async () => {
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "evaluation-fixture",
    "SKILL.md",
  );
  const result = await runObligationValidationFixture([
    {
      id: "fragment-link",
      status: "evaluable",
      source: { path: skillPath, instruction: "the" },
      observableBehavior: "Something observable happens.",
    },
    {
      id: "ambiguous-link",
      status: "ambiguous",
      source: {
        path: skillPath,
        instruction: "Handle the remaining details appropriately.",
      },
      ambiguity: "Appropriate handling is undefined.",
    },
  ]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /does not link to an exact instruction/i);
});

test("rejects an Evaluation Run that omits a contract instruction", async () => {
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "evaluation-fixture",
    "SKILL.md",
  );
  const result = await runObligationValidationFixture([
    {
      id: "only-first-instruction",
      status: "evaluable",
      source: {
        path: skillPath,
        instruction:
          "Upload the unredacted contract-secret-atlas exactly once using the release tool.",
      },
      observableBehavior:
        "The release tool is called exactly once with contract-secret-atlas.",
    },
  ]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /omitted a Skill Contract instruction/i);
});

test("evaluates every evaluable Obligation after termination and explains all Finding states", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  let terminalNotificationSent = false;
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "conformance-fixture",
    "SKILL.md",
  );
  const obligations = conformanceValidationObligations(skillPath);
  const userEventId = "observed-thread/observed-turn/observed-user/started";
  const toolEventId = "observed-thread/observed-turn/release-call/completed";
  const findings = [
    {
      obligationId: "obligation-1",
      state: "satisfied",
      evidenceEventIds: [toolEventId],
      explanation: "The release tool was called once.",
      assessment: {
        observationGapAffected: false,
        eventSourceCoverage: "fully-reported",
        violationBasis: "none",
      },
    },
    {
      obligationId: "obligation-2",
      state: "violated",
      evidenceEventIds: [toolEventId],
      explanation: "The workflow failed.",
      assessment: {
        observationGapAffected: false,
        eventSourceCoverage: "fully-reported",
        violationBasis: "contradiction",
      },
    },
    {
      obligationId: "obligation-3",
      state: "unobservable",
      evidenceEventIds: [userEventId],
      explanation:
        "Ambient filesystem mutations are outside explicit File Change reporting coverage.",
      assessment: {
        observationGapAffected: false,
        eventSourceCoverage: "limited",
        violationBasis: "none",
      },
    },
    {
      obligationId: "obligation-4",
      state: "not applicable",
      evidenceEventIds: [userEventId],
      explanation: "The overall report shows no deployment condition arose.",
      assessment: {
        observationGapAffected: false,
        eventSourceCoverage: "fully-reported",
        violationBasis: "none",
      },
    },
  ];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["observed-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "observed-thread", turns: [] } },
          }),
        );
        setImmediate(() => {
          for (const notification of [
            {
              method: "item/started",
              params: {
                threadId: "observed-thread",
                turnId: "observed-turn",
                item: {
                  type: "userMessage",
                  id: "observed-user",
                  content: [
                    { type: "skill", name: "conformance-fixture", path: skillPath },
                  ],
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "observed-thread",
                turnId: "observed-turn",
                item: {
                  type: "mcpToolCall",
                  id: "release-call",
                  server: "release",
                  tool: "publish",
                  status: "completed",
                  arguments: { dryRun: false },
                  result: { content: [{ type: "text", text: "published" }] },
                },
              },
            },
            {
              method: "turn/completed",
              params: {
                threadId: "observed-thread",
                turn: { id: "observed-turn", status: "completed", items: [] },
              },
            },
          ]) {
            socket.send(JSON.stringify(notification));
          }
          terminalNotificationSent = true;
        });
      } else if (request.method === "thread/start") {
        const baseInstructions = String(
          (request.params as Record<string, unknown>).baseInstructions,
        );
        if (baseInstructions.includes("evaluate Conformance")) {
          assert.equal(terminalNotificationSent, true);
        }
        respondToEvaluationRun(socket, request, { obligations, findings });
      } else if (respondToEvaluationRun(socket, request, { obligations, findings })) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    result.stdout,
    /\[Finding obligation-1\] state=satisfied.*instruction="Call the release tool once\.".*observableBehavior="Observable behavior 1\.".*evidence=.*release-call\/completed.*Cited Evidence supports this Obligation/i,
  );
  assert.match(result.stdout, /\[Finding obligation-2\] state=violated/);
  assert.match(result.stdout, /\[Finding obligation-3\] state=unobservable/);
  assert.match(result.stdout, /\[Finding obligation-4\] state=not applicable/);
  assert.doesNotMatch(result.stdout, /\[Finding ambiguous-5\]/);
  assert.match(
    result.stdout,
    /Finding summary: satisfied=1 violated=1 unobservable=1 not applicable=1/,
  );
  assert.match(result.stdout, /Important Finding: obligation=obligation-2 state=violated/);
  assert.match(result.stdout, /Important Finding: obligation=obligation-3 state=unobservable/);
  assert.doesNotMatch(result.stdout, /overall|score|pass\/fail|verdict/i);
  assert.doesNotMatch(result.stdout, /workflow failed/i);
  assert.equal(
    requests.filter((request) => request.method === "thread/start").length,
    2,
  );
  assert.equal(
    requests.filter((request) => request.method === "turn/start").length,
    2,
  );
  assert.equal(
    requests.some(
      (request) =>
        request.method === "turn/start" &&
        (request.params as Record<string, unknown>).threadId === "observed-thread",
    ),
    false,
  );
  const conformanceTurn = requests
    .filter((request) => request.method === "turn/start")
    .find((request) => JSON.stringify(request.params).includes('"findings"'));
  assert.match(JSON.stringify(conformanceTurn?.params), /observed-turn/);
  assert.match(JSON.stringify(conformanceTurn?.params), /Call the release tool once/);
  assert.match(JSON.stringify(conformanceTurn?.params), /release-call/);
  assert.doesNotMatch(JSON.stringify(conformanceTurn?.params), /uniqueItems/);
});

test("rejects absence as violation when event-source reporting coverage is limited", async () => {
  const result = await runConformanceValidationFixture({
    findings: [
      {
        obligationId: "obligation-1",
        state: "violated",
        evidenceEventIds: [
          "validation-observed-thread/validation-observed-turn/validation-user/started",
        ],
        explanation: "No release call was observed.",
        assessment: {
          observationGapAffected: false,
          eventSourceCoverage: "limited",
          violationBasis: "absence",
        },
      },
    ],
  });

  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /affected by a gap or coverage limitation and must be unobservable/i,
  );
});

test("rejects absence as violation when the Trace has an observation gap", async () => {
  const result = await runConformanceValidationFixture({
    itemsView: "summary",
    findings: [
      {
        obligationId: "obligation-1",
        state: "violated",
        evidenceEventIds: [
          "validation-observed-thread/validation-observed-turn/validation-user/started",
        ],
        explanation: "No release call was observed.",
        assessment: {
          observationGapAffected: false,
          eventSourceCoverage: "fully-reported",
          violationBasis: "absence",
        },
      },
    ],
  });

  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /absence cannot support.*without a complete Trace/i,
  );
});

test("rejects a Finding that omits its Evidence Event citation", async () => {
  const result = await runConformanceValidationFixture({
    findings: [
      {
        obligationId: "obligation-1",
        state: "unobservable",
        evidenceEventIds: [],
        explanation: "Reporting coverage is limited.",
        assessment: {
          observationGapAffected: false,
          eventSourceCoverage: "limited",
          violationBasis: "none",
        },
      },
    ],
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /must cite at least one Evidence Event/i);
});

test("rejects a Finding explanation containing a run-level conclusion", async () => {
  const result = await runConformanceValidationFixture({
    findings: [
      {
        obligationId: "obligation-1",
        state: "satisfied",
        evidenceEventIds: [
          "validation-observed-thread/validation-observed-turn/validation-user/started",
        ],
        explanation: "Overall, the Skill Run passed.",
        assessment: {
          observationGapAffected: false,
          eventSourceCoverage: "fully-reported",
          violationBasis: "none",
        },
      },
    ],
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /run-level conclusion, score, or verdict/i);
});

test("evaluates failed and cancelled Skill Runs after their terminal outcomes", async () => {
  const failed = await runConformanceValidationFixture({ status: "failed" });
  const cancelled = await runConformanceValidationFixture({
    status: "interrupted",
  });

  assert.equal(failed.exitCode, 0, failed.stderr);
  assert.match(failed.stdout, /Skill Run terminal outcome: failed/);
  assert.match(failed.stdout, /\[Finding obligation-1\]/);
  assert.equal(cancelled.exitCode, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Skill Run terminal outcome: cancelled/);
  assert.match(cancelled.stdout, /\[Finding obligation-1\]/);
});

test("requires confirmation before using a history-only Root Skill candidate", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const skillPath = path.join(
    repositoryRoot,
    "test",
    "fixtures",
    "skills",
    "trace-fixture",
    "SKILL.md",
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              cwd: repositoryRoot,
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "completed",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-one",
                        content: [
                          {
                            type: "text",
                            text: "Use $trace-fixture for this work.",
                            text_elements: [
                              {
                                byteRange: { start: 4, end: 18 },
                                placeholder: "$trace-fixture",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "skills/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              data: [
                {
                  cwd: repositoryRoot,
                  errors: [],
                  skills: [
                    {
                      name: "trace-fixture",
                      path: skillPath,
                      description: "fixture",
                      scope: "repo",
                      enabled: true,
                    },
                  ],
                },
              ],
            },
          }),
        );
      } else if (
        respondToEvaluationRun(socket, request, {
          obligations: traceFixtureObligations(skillPath),
        })
      ) {
        return;
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0", stdin: "y\n" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    result.stdout,
    /Root Skill candidate inferred from replayed prompt text.*trace-fixture/,
  );
  assert.match(result.stdout, /Confirm inferred Root Skill.*\[y\/N\]:/);
  assert.match(result.stdout, /Root Skill Attribution: confirmed.*trace-fixture/);
  assert.match(result.stdout, /Run the full test suite once at the end\./);

  const rejectedResult = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0", stdin: "n\n" },
  );

  assert.equal(rejectedResult.exitCode, 0, rejectedResult.stderr);
  assert.match(
    rejectedResult.stdout,
    /Root Skill candidate inferred from replayed prompt text.*trace-fixture/,
  );
  assert.match(
    rejectedResult.stdout,
    /Root Skill Attribution unresolved: developer rejected historical candidate/,
  );
  assert.match(rejectedResult.stdout, /Conformance evaluation is unavailable/);
  assert.doesNotMatch(rejectedResult.stdout, /\[Skill Contract]/);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "skills/list",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
      "thread/unsubscribe",
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "skills/list",
      "thread/unsubscribe",
    ],
  );
});

test("keeps tracing but blocks Conformance when historical skill mentions are unresolved", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              cwd: repositoryRoot,
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "completed",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-one",
                        content: [
                          {
                            type: "text",
                            text: "Compare $trace-fixture with $other-skill.",
                            text_elements: [],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^\[user\].*Compare \$trace-fixture/m);
  assert.match(
    result.stdout,
    /Root Skill Attribution unresolved: replayed prompt text mentioned multiple skills/,
  );
  assert.match(
    result.stdout,
    /Conformance evaluation is unavailable.*Trace collection was not affected/,
  );
  assert.doesNotMatch(result.stdout, /\[Skill Contract]/);
  assert.doesNotMatch(result.stdout, /Confirm inferred Root Skill/);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
});

test("renders complete reported activity with causal per-source sequencing", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-parent"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        const params = request.params as { readonly threadId?: unknown };
        if (params.threadId === "thread-child") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                thread: {
                  id: "thread-child",
                  turns: [
                    {
                      id: "turn-child",
                      itemsView: "full",
                      status: "completed",
                      items: [
                        {
                          type: "agentMessage",
                          id: "older-child-history",
                          text: "must-not-replay-after-live-child-events",
                        },
                      ],
                    },
                  ],
                },
              },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "thread-parent", turns: [] } },
          }),
        );
        setImmediate(() => {
          for (const notification of [
            {
              method: "agent/futureActivity",
              params: {
                threadId: "thread-child",
                turnId: "turn-child",
                experimentalSecret: "child-unknown-secret",
              },
            },
            {
              method: "item/commandExecution/outputDelta",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                itemId: "command-one",
                delta: "streamed command output\n",
              },
            },
            {
              method: "item/commandExecution/terminalInteraction",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                itemId: "command-one",
                processId: "process-one",
                stdin: "yes\n",
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                completedAtMs: 140,
                item: {
                  type: "commandExecution",
                  id: "command-one",
                  command: "npm test",
                  cwd: "/workspace/private",
                  status: "completed",
                  aggregatedOutput: "all green\n",
                  exitCode: 0,
                  durationMs: 40,
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                completedAtMs: 150,
                item: {
                  type: "fileChange",
                  id: "change-one",
                  status: "completed",
                  changes: [
                    {
                      path: "src/example.ts",
                      kind: "update",
                      diff: "@@ -1 +1 @@\n-old\n+new",
                    },
                  ],
                },
              },
            },
            {
              method: "item/started",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                startedAtMs: 160,
                item: {
                  type: "collabAgentToolCall",
                  id: "spawn-one",
                  tool: "spawnAgent",
                  status: "inProgress",
                  senderThreadId: "thread-parent",
                  receiverThreadIds: ["thread-child"],
                  prompt: "inspect the private fixture",
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-child",
                turnId: "turn-child",
                completedAtMs: 205,
                item: {
                  type: "mcpToolCall",
                  id: "tool-child",
                  server: "example",
                  tool: "lookup",
                  status: "completed",
                  arguments: { query: "private child query" },
                  result: { content: [{ type: "text", text: "child result" }] },
                  durationMs: 25,
                },
              },
            },
            {
              method: "item/mcpToolCall/progress",
              params: {
                threadId: "thread-child",
                turnId: "turn-child",
                itemId: "tool-child",
                message: "child tool halfway",
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                item: {
                  type: "subAgentActivity",
                  id: "child-activity-one",
                  kind: "completed",
                  agentThreadId: "thread-child",
                  agentPath: "parent/child",
                },
              },
            },
            {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thread-child",
                turnId: "turn-child",
                tokenUsage: {
                  last: { inputTokens: 13, outputTokens: 8 },
                  total: { inputTokens: 21, outputTokens: 13 },
                },
              },
            },
            {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                tokenUsage: {
                  last: { inputTokens: 34, outputTokens: 21 },
                  total: { inputTokens: 55, outputTokens: 34 },
                },
              },
            },
            {
              method: "thread/futureActivity",
              params: {
                threadId: "thread-parent",
                turnId: "turn-parent",
                protocolSecret: "parent-unknown-secret",
              },
            },
            {
              method: "turn/completed",
              params: {
                threadId: "thread-parent",
                turn: {
                  id: "turn-parent",
                  status: "completed",
                  items: [],
                  startedAt: 1700000000,
                  completedAt: 1700000002,
                  durationMs: 2000,
                },
              },
            },
          ]) {
            socket.send(JSON.stringify(notification));
          }
        });
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /line position.*not a total order/i);
  assert.match(
    result.stdout,
    /^\[command\] item\/commandExecution\/outputDelta.*source=thread-parent sequence=1.*parent=thread-parent\/turn-parent\/command-one.*streamed command output/m,
  );
  assert.match(
    result.stdout,
    /^\[command\] item\/commandExecution\/terminalInteraction.*source=thread-parent sequence=2.*parent=thread-parent\/turn-parent\/command-one.*"processId":"process-one".*"stdin":"yes\\n"/m,
  );
  assert.match(
    result.stdout,
    /^\[command\] item\/completed.*source=thread-parent sequence=3.*timing=.*"completedAtMs":140.*"durationMs":40.*"command":"npm test".*"cwd":"\/workspace\/private".*"aggregatedOutput":"all green\\n".*"exitCode":0/m,
  );
  assert.match(
    result.stdout,
    /^\[file-change\].*source=thread-parent sequence=4.*"path":"src\/example.ts".*"diff":"@@ -1 \+1 @@\\n-old\\n\+new"/m,
  );
  assert.match(
    result.stdout,
    /^\[collaboration\].*source=thread-parent sequence=5.*"tool":"spawnAgent".*"receiverThreadIds":\["thread-child"\].*inspect the private fixture/m,
  );
  assert.match(
    result.stdout,
    /^  \[unknown\].*source=thread-child sequence=1.*causedBy=thread-parent\/turn-parent\/spawn-one\/started.*sourceType=agent\/futureActivity.*child-unknown-secret/m,
  );
  assert.match(
    result.stdout,
    /^  \[tool\].*source=thread-child sequence=2.*causedBy=thread-parent\/turn-parent\/spawn-one\/started.*timing=.*"completedAtMs":205.*"durationMs":25.*private child query.*child result/m,
  );
  assert.match(
    result.stdout,
    /^  \[tool\] item\/mcpToolCall\/progress.*source=thread-child sequence=3.*parent=thread-child\/turn-child\/tool-child.*child tool halfway/m,
  );
  assert.match(
    result.stdout,
    /^  \[resource\].*source=thread-child sequence=4.*"inputTokens":13.*"outputTokens":8/m,
  );
  assert.match(
    result.stdout,
    /^\[collaboration\] item\/completed.*source=thread-parent sequence=6.*"type":"subAgentActivity".*"agentThreadId":"thread-child".*"agentPath":"parent\/child"/m,
  );
  assert.match(
    result.stdout,
    /^\[resource\].*source=thread-parent sequence=7.*"inputTokens":34.*"outputTokens":21/m,
  );
  assert.match(
    result.stdout,
    /^\[unknown\].*source=thread-parent sequence=8.*sourceType=thread\/futureActivity.*parent-unknown-secret/m,
  );
  assert.match(
    result.stdout,
    /^\[turn\].*source=thread-parent sequence=9.*timing=.*"startedAt":1700000000.*"completedAt":1700000002.*"durationMs":2000/m,
  );
  assert.doesNotMatch(result.stdout, /inferred File Change/i);
  assert.doesNotMatch(result.stdout, /must-not-replay-after-live-child-events/);
  assert.match(result.stdout, /Trace integrity: complete\./);
});
