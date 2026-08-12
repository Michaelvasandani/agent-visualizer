import assert from "node:assert/strict";
import path from "node:path";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  observeSkillRun,
  type ObservationUpdate,
} from "../src/trace-observation.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const skillPath = path.join(
  repositoryRoot,
  "test",
  "fixtures",
  "skills",
  "conformance-fixture",
  "SKILL.md",
);

const instructions = [
  "Call the release tool once.",
  "Do not call the release tool with dry-run disabled.",
  "Record every ambient filesystem mutation.",
  "If a deployment occurs, notify the release channel.",
  "Handle any exceptional circumstances appropriately.",
] as const;

test("emits one structured lifecycle for collection and post-run evaluation", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  let evaluationNumber = 0;
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      const params = request.params as Record<string, unknown> | undefined;
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
            result: {
              cwd: repositoryRoot,
              thread: { id: "observed-thread", turns: [] },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "observed-thread",
                turnId: "observed-turn",
                item: {
                  id: "root-skill-input",
                  type: "userMessage",
                  content: [
                    {
                      type: "skill",
                      name: "conformance-fixture",
                      path: skillPath,
                    },
                  ],
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "observed-thread",
                turn: {
                  id: "observed-turn",
                  status: "completed",
                  items: [],
                },
              },
            }),
          );
        });
      } else if (request.method === "thread/start") {
        evaluationNumber += 1;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: `evaluation-${evaluationNumber}` } },
          }),
        );
      } else if (request.method === "turn/start") {
        const threadId = String(params?.threadId);
        const turnId = `${threadId}-turn`;
        const isFindingRun =
          (JSON.stringify(params?.outputSchema) ?? "").includes('"findings"');
        const response = isFindingRun
          ? {
              findings: instructions.map((_instruction, index) => ({
                obligationId: `obligation-${index + 1}`,
                state: "satisfied",
                evidenceEventIds: [
                  "observed-thread/observed-turn/root-skill-input/started",
                ],
                explanation: "The cited event supports the obligation.",
                assessment: {
                  observationGapAffected: false,
                  eventSourceCoverage: "fully-reported",
                  violationBasis: "none",
                },
              })),
            }
          : {
              obligations: instructions.map((instruction, index) => ({
                id: `obligation-${index + 1}`,
                status: "evaluable",
                source: { blockId: `source-1:block-${index + 1}` },
                observableBehavior: instruction,
                ambiguity: "",
              })),
            };
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { turn: { id: turnId, status: "inProgress", items: [] } },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  id: `${threadId}-message`,
                  type: "agentMessage",
                  text: JSON.stringify(response),
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "completed", items: [] },
              },
            }),
          );
        });
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });

  const updates: ObservationUpdate[] = [];
  let consumerDisconnected = false;
  const address = server.address() as AddressInfo;
  const observation = await observeSkillRun({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    onUpdate: (update) => {
      updates.push(update);
      if (!consumerDisconnected && update.kind === "lifecycle") {
        consumerDisconnected = true;
        throw new Error("browser connection closed");
      }
    },
  });

  assert.equal(observation.lifecycleState, "completed");
  assert.equal(observation.evaluationState, "completed");
  assert.equal(observation.threadId, "observed-thread");
  assert.equal(observation.events.length, 2);
  assert.deepEqual(observation.gaps, []);
  assert.deepEqual(observation.terminalOutcome, { kind: "completed" });
  assert.equal(observation.skillAttribution.kind, "exact");
  assert.equal(observation.skillContract?.rootSkill.path, skillPath);
  assert.equal(observation.obligations.length, instructions.length);
  assert.equal(observation.findings.length, instructions.length);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.events), true);

  assert.deepEqual(
    updates
      .filter((update) => update.kind === "lifecycle")
      .map((update) => update.state),
    ["connecting", "selecting-thread", "observing", "evaluating", "completed"],
  );
  assert.deepEqual(
    updates
      .filter((update) => update.kind === "evaluation-state")
      .map((update) => update.state),
    ["not-started", "compiling-obligations", "evaluating-findings", "completed"],
  );
  assert.equal(
    updates.filter((update) => update.kind === "event").length,
    observation.events.length,
  );
  assert.equal(
    updates.filter((update) => update.kind === "terminal-outcome").length,
    1,
  );
  assert.equal(
    updates.filter((update) => update.kind === "skill-attribution").length,
    1,
  );
  assert.equal(updates.filter((update) => update.kind === "obligations").length, 1);
  assert.equal(updates.filter((update) => update.kind === "findings").length, 1);
});

test("returns a completed Trace when evaluation is skipped", async (t) => {
  const { server, serverUrl } = await startTerminalObservationServer({
    includeRootSkill: false,
  });
  t.after(() => server.close());
  const updates: ObservationUpdate[] = [];

  const observation = await observeSkillRun({
    serverUrl,
    onUpdate: (update) => updates.push(update),
  });

  assert.equal(observation.lifecycleState, "completed");
  assert.equal(observation.evaluationState, "skipped");
  assert.equal(observation.evaluationError, null);
  assert.equal(observation.skillAttribution.kind, "unresolved");
  assert.deepEqual(observation.obligations, []);
  assert.deepEqual(observation.findings, []);
  assert.equal(
    updates.some(
      (update) =>
        update.kind === "evaluation-state" && update.state === "skipped",
    ),
    true,
  );
});

test("returns the completed Trace with a structured evaluation failure", async (t) => {
  const { server, serverUrl } = await startTerminalObservationServer({
    includeRootSkill: true,
    failEvaluation: true,
  });
  t.after(() => server.close());
  const updates: ObservationUpdate[] = [];

  const observation = await observeSkillRun({
    serverUrl,
    onUpdate: (update) => updates.push(update),
  });

  assert.equal(observation.lifecycleState, "completed");
  assert.equal(observation.evaluationState, "failed");
  assert.match(String(observation.evaluationError), /fixture evaluation failed/);
  assert.deepEqual(observation.terminalOutcome, { kind: "completed" });
  assert.equal(observation.events.length, 2);
  assert.equal(observation.skillAttribution.kind, "exact");
  const failedUpdate = updates.find(
    (update) =>
      update.kind === "evaluation-state" && update.state === "failed",
  );
  assert.ok(failedUpdate?.kind === "evaluation-state");
  assert.match(String(failedUpdate.error), /fixture evaluation failed/);
  const finalUpdate = updates.at(-1);
  assert.equal(
    finalUpdate?.kind === "lifecycle" && finalUpdate.state === "completed",
    true,
  );
});

test("does not start Conformance after deferred shutdown is requested", async (t) => {
  const { server, serverUrl } = await startTerminalObservationServer({
    includeRootSkill: true,
  });
  t.after(() => server.close());
  const updates: ObservationUpdate[] = [];

  const observation = await observeSkillRun({
    serverUrl,
    shouldStartConformance: () => false,
    onUpdate: (update) => updates.push(update),
  });

  assert.equal(observation.skillAttribution.kind, "exact");
  assert.equal(observation.evaluationState, "skipped");
  assert.equal(observation.skillContract, null);
  assert.deepEqual(observation.obligations, []);
  assert.deepEqual(observation.findings, []);
  assert.equal(
    updates.some(
      (update) => update.kind === "lifecycle" && update.state === "evaluating",
    ),
    false,
  );
  assert.equal(
    updates.some(
      (update) =>
        update.kind === "evaluation-state" &&
        update.state === "skipped" &&
        update.reason === "Shutdown was requested before Conformance began.",
    ),
    true,
  );
});

test("aborts active collection by closing only the Tracer subscription", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  let connections = 0;
  let resolveResumed: () => void = () => undefined;
  const resumed = new Promise<void>((resolve) => {
    resolveResumed = resolve;
  });
  server.on("connection", (socket) => {
    connections += 1;
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
            result: { data: ["active-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "active-thread", turns: [] } },
          }),
        );
        resolveResumed();
      }
    });
  });
  const address = server.address() as AddressInfo;
  const abortController = new AbortController();
  const observation = observeSkillRun({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    signal: abortController.signal,
  });
  await resumed;

  abortController.abort(new Error("forced fixture shutdown"));

  await assert.rejects(observation, /forced fixture shutdown/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(connections, 1, "an intentional abort must not reconnect");
});

test("aborts while the Tracer is still connecting", async (t) => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const abortController = new AbortController();
  const observation = observeSkillRun({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    signal: abortController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));

  abortController.abort(new Error("connecting fixture shutdown"));

  await assert.rejects(
    Promise.race([
      observation,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("abort timed out")), 500),
      ),
    ]),
    /connecting fixture shutdown/,
  );
});

test("aborts while initializing an App Server connection", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  let resolveInitialize: () => void = () => undefined;
  const initializeReceived = new Promise<void>((resolve) => {
    resolveInitialize = resolve;
  });
  server.on("connection", (socket) => {
    socket.on("message", () => resolveInitialize());
  });
  const address = server.address() as AddressInfo;
  const abortController = new AbortController();
  const observation = observeSkillRun({
    serverUrl: `ws://127.0.0.1:${address.port}`,
    signal: abortController.signal,
  });
  await initializeReceived;

  abortController.abort(new Error("initialization fixture shutdown"));

  await assert.rejects(observation, /initialization fixture shutdown/);
});

async function startTerminalObservationServer(options: {
  readonly includeRootSkill: boolean;
  readonly failEvaluation?: boolean;
}): Promise<{
  readonly server: WebSocketServer;
  readonly serverUrl: string;
}> {
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
            result: { data: ["terminal-thread"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              cwd: repositoryRoot,
              thread: { id: "terminal-thread", turns: [] },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "terminal-thread",
                turnId: "terminal-turn",
                item: {
                  id: "terminal-input",
                  type: "userMessage",
                  content: options.includeRootSkill
                    ? [
                        {
                          type: "skill",
                          name: "conformance-fixture",
                          path: skillPath,
                        },
                      ]
                    : [{ type: "text", text: "ordinary turn" }],
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "terminal-thread",
                turn: {
                  id: "terminal-turn",
                  status: "completed",
                  items: [],
                },
              },
            }),
          );
        });
      } else if (request.method === "thread/start") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "failing-evaluation" } },
          }),
        );
      } else if (request.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              turn: {
                id: "failing-evaluation-turn",
                status: "inProgress",
                items: [],
              },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "failing-evaluation",
                turn: {
                  id: "failing-evaluation-turn",
                  status: options.failEvaluation ? "failed" : "completed",
                  error: options.failEvaluation
                    ? { message: "fixture evaluation failed" }
                    : null,
                  items: [],
                },
              },
            }),
          );
        });
      } else if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      }
    });
  });
  const address = server.address() as AddressInfo;
  return { server, serverUrl: `ws://127.0.0.1:${address.port}` };
}
