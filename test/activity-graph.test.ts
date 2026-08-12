import assert from "node:assert/strict";
import test from "node:test";

import {
  projectActivityGraph,
  updateActivityGraphProjection,
  type ActivityGraphProjectionInput,
} from "../src/activity-graph.js";
import {
  createNormalizedEvent,
  type JsonObject,
  type NormalizedEvent,
  type TraceEventKind,
} from "../src/trace-event.js";

function event(input: {
  readonly id: string;
  readonly sequence: number;
  readonly method: string;
  readonly kind: TraceEventKind;
  readonly payload: JsonObject;
  readonly sourceId?: string;
  readonly sourceParentId?: string | null;
  readonly sourceDepth?: number;
  readonly causalParentId?: string | null;
  readonly timing?: NormalizedEvent["timing"];
  readonly observationSources?: NormalizedEvent["observationSources"];
}): NormalizedEvent {
  return createNormalizedEvent({
    id: input.id,
    sourceId: input.sourceId ?? "root",
    sourceSequence: input.sequence,
    causalParentId: input.causalParentId ?? "root/turn-1",
    sourceParentId: input.sourceParentId ?? null,
    sourceDepth: input.sourceDepth ?? 0,
    method: input.method,
    kind: input.kind,
    timing: input.timing ?? null,
    observationSources: input.observationSources ?? ["live"],
    payload: input.payload,
  });
}

function input(events: readonly NormalizedEvent[]): ActivityGraphProjectionInput {
  return { rootSourceId: "root", events, gaps: [], terminalOutcome: null };
}

test("folds streamed command lifecycle Events into one immutable Activity Node", () => {
  const events = [
    event({
      id: "root/turn-1/command-1/started",
      sequence: 1,
      method: "item/started",
      kind: "command",
      timing: { startedAtMs: 100 },
      payload: {
        threadId: "root",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm test",
          status: "inProgress",
        },
      },
    }),
    event({
      id: "root/event/2",
      sequence: 2,
      method: "item/commandExecution/outputDelta",
      kind: "command",
      causalParentId: "root/turn-1/command-1",
      payload: {
        threadId: "root",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "passing\n",
      },
    }),
    event({
      id: "root/turn-1/command-1/completed",
      sequence: 3,
      method: "item/completed",
      kind: "command",
      timing: { completedAtMs: 140, durationMs: 40 },
      payload: {
        threadId: "root",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm test",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "passing\n",
        },
      },
    }),
  ];

  const graph = projectActivityGraph(input(events));

  assert.equal(Object.keys(graph.nodesById).length, 1);
  assert.deepEqual(graph.nodesById["root/turn-1/command-1"], {
    id: "root/turn-1/command-1",
    type: "command",
    state: "completed",
    sourceId: "root",
    sourceSequence: 1,
    causalParentNodeId: "root/turn-1",
    eventIds: [
      "root/turn-1/command-1/started",
      "root/event/2",
      "root/turn-1/command-1/completed",
    ],
    summary: "npm test",
    durationMs: 40,
    coverageWarning: null,
  });
  assert.deepEqual(graph.eventsBySource.root, events);
  assert.equal(Object.isFrozen(graph), true);
  assert.equal(Object.isFrozen(graph.nodesById), true);
  assert.equal(Object.isFrozen(graph.nodesById["root/turn-1/command-1"]), true);
  assert.equal(
    Object.isFrozen(graph.nodesById["root/turn-1/command-1"]?.eventIds),
    true,
  );
  assert.equal(Object.isFrozen(graph.eventsBySource), true);
});

test("projects causal source lanes without ordering concurrent descendants", () => {
  const spawn = event({
    id: "root/turn-1/spawn/started",
    sequence: 1,
    method: "item/started",
    kind: "collaboration",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["child-b", "child-a"],
      },
    },
  });
  const childB = event({
    id: "child-b/turn-b/tool/completed",
    sourceId: "child-b",
    sourceParentId: spawn.id,
    sourceDepth: 1,
    sequence: 1,
    method: "item/completed",
    kind: "tool",
    causalParentId: "child-b/turn-b",
    payload: {
      threadId: "child-b",
      turnId: "turn-b",
      item: { id: "tool", type: "mcpToolCall", tool: "lookup", status: "completed" },
    },
  });
  const childAFirst = event({
    id: "child-a/turn-a/change/completed",
    sourceId: "child-a",
    sourceParentId: spawn.id,
    sourceDepth: 1,
    sequence: 1,
    method: "item/completed",
    kind: "file-change",
    causalParentId: "child-a/turn-a",
    payload: {
      threadId: "child-a",
      turnId: "turn-a",
      item: {
        id: "change",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: "update" }],
      },
    },
  });
  const childASecond = event({
    id: "child-a/turn-a/future/completed",
    sourceId: "child-a",
    sourceParentId: spawn.id,
    sourceDepth: 1,
    sequence: 2,
    method: "item/completed",
    kind: "unknown",
    causalParentId: "child-a/turn-a",
    payload: {
      threadId: "child-a",
      turnId: "turn-a",
      item: { id: "future", type: "futureActivity", status: "completed" },
    },
  });

  const graph = projectActivityGraph(
    input([spawn, childB, childASecond, childAFirst]),
  );

  assert.equal(graph.ordering, "per-source-only");
  assert.deepEqual(graph.lanesBySource, {
    root: {
      sourceId: "root",
      sourceDepth: 0,
      sourceParentActivityNodeId: null,
      nodeIds: ["root/turn-1/spawn"],
    },
    "child-a": {
      sourceId: "child-a",
      sourceDepth: 1,
      sourceParentActivityNodeId: "root/turn-1/spawn",
      nodeIds: ["child-a/turn-a/change", "child-a/turn-a/future"],
    },
    "child-b": {
      sourceId: "child-b",
      sourceDepth: 1,
      sourceParentActivityNodeId: "root/turn-1/spawn",
      nodeIds: ["child-b/turn-b/tool"],
    },
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(graph.nodesById).map(
        ([id, { type, summary, coverageWarning }]) => [
          id,
          { type, summary, coverageWarning },
        ],
      ),
    ),
    {
      "root/turn-1/spawn": {
        type: "agent",
        summary: "Spawn agent",
        coverageWarning: null,
      },
      "child-a/turn-a/change": {
        type: "file-change",
        summary: "src/a.ts",
        coverageWarning: null,
      },
      "child-a/turn-a/future": {
        type: "unknown",
        summary: "Unknown activity: futureActivity",
        coverageWarning: "Unsupported Event semantics: futureActivity",
      },
      "child-b/turn-b/tool": {
        type: "tool",
        summary: "lookup",
        coverageWarning: null,
      },
    },
  );
  assert.deepEqual(graph.causalEdgesById, {
    "spawn:root/turn-1/spawn->child-a/turn-a/change": {
      fromActivityNodeId: "root/turn-1/spawn",
      toActivityNodeId: "child-a/turn-a/change",
      relationship: "spawn",
    },
    "spawn:root/turn-1/spawn->child-b/turn-b/tool": {
      fromActivityNodeId: "root/turn-1/spawn",
      toActivityNodeId: "child-b/turn-b/tool",
      relationship: "spawn",
    },
  });
  assert.deepEqual(
    graph.eventsBySource["child-a"]?.map(({ sourceSequence }) => sourceSequence),
    [1, 2],
  );
  assert.equal(
    Object.values(graph.nodesById).some((node) => "globalSequence" in node),
    false,
  );
});

test("keeps reasoning and reported resource values in secondary presentations", () => {
  const rootReasoning = event({
    id: "root/event/1",
    sequence: 1,
    method: "item/reasoning/textDelta",
    kind: "reasoning",
    causalParentId: "root/turn-1/reasoning-1",
    payload: { threadId: "root", turnId: "turn-1", itemId: "reasoning-1", delta: "secret" },
  });
  const rootTokens = event({
    id: "root/event/2",
    sequence: 2,
    method: "thread/tokenUsage/updated",
    kind: "resource",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 100,
          inputTokens: 60,
          outputTokens: 40,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  const childTokens = event({
    id: "child/event/1",
    sourceId: "child",
    sourceParentId: "root/turn-1/spawn/started",
    sourceDepth: 1,
    sequence: 1,
    method: "thread/tokenUsage/updated",
    kind: "resource",
    causalParentId: "child/turn-1",
    payload: {
      threadId: "child",
      turnId: "turn-child",
      tokenUsage: {
        total: {
          totalTokens: 75,
          inputTokens: 50,
          cachedInputTokens: 20,
          outputTokens: 25,
        },
      },
    },
  });
  const gap = {
    afterEventId: rootTokens.id,
    historyBoundary: "reconnect history" as const,
    sources: ["child"],
    reason: "notification-only activity is unavailable from resumed history",
  };

  const graph = projectActivityGraph({
    rootSourceId: "root",
    events: [rootReasoning, childTokens, rootTokens],
    gaps: [gap],
    terminalOutcome: null,
  });

  assert.deepEqual(graph.nodesById, {});
  assert.deepEqual(graph.secondary, {
    reasoningEventIdsBySource: { root: [rootReasoning.id] },
    resourceEventIdsBySource: {
      child: [childTokens.id],
      root: [rootTokens.id],
    },
  });
  assert.deepEqual(graph.tokens, {
    skillRun: {
      sourceId: "root",
      availability: "reported",
      values: {
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        modelContextWindow: 200_000,
      },
    },
    bySource: {
      root: {
        sourceId: "root",
        availability: "reported",
        values: {
          totalTokens: 100,
          inputTokens: 60,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          modelContextWindow: 200_000,
        },
      },
      child: {
        sourceId: "child",
        availability: "unavailable",
        values: {
          totalTokens: 75,
          inputTokens: 50,
          cachedInputTokens: 20,
          outputTokens: 25,
        },
      },
    },
  });
  assert.equal(JSON.stringify(graph.tokens).includes("175"), false);
  assert.deepEqual(graph.gaps, [gap]);
  assert.equal(graph.integrity, "incomplete");
});

test("live updates and Saved Trace replay produce the same late-attachment graph", () => {
  const completedTool = event({
    id: "root/turn-late/tool-late/completed",
    sequence: 1,
    method: "item/completed",
    kind: "tool",
    causalParentId: "root/turn-late",
    observationSources: ["history"],
    timing: { completedAtMs: 500, durationMs: 20 },
    payload: {
      threadId: "root",
      turnId: "turn-late",
      item: {
        id: "tool-late",
        type: "mcpToolCall",
        tool: "read_fixture",
        status: "failed",
        error: { message: "fixture unavailable" },
      },
    },
  });
  const failedTurn = event({
    id: "root/turn-late/turn/completed",
    sequence: 2,
    method: "turn/completed",
    kind: "turn",
    causalParentId: "root/turn-late",
    observationSources: ["history"],
    timing: { completedAt: 10, durationMs: 200 },
    payload: {
      threadId: "root",
      turn: {
        id: "turn-late",
        status: "failed",
        error: { message: "run failed" },
      },
    },
  });
  const gap = {
    afterEventId: null,
    historyBoundary: "initial history" as const,
    sources: ["root"],
    reason:
      "turn turn-late itemsView=summary; notification-only activity before attachment is unavailable from resumed history",
  };
  const terminalOutcome = {
    kind: "failed" as const,
    error: { message: "run failed" },
  };

  let live = projectActivityGraph(input([]));
  live = updateActivityGraphProjection(live, {
    kind: "event",
    event: completedTool,
  });
  live = updateActivityGraphProjection(live, { kind: "gap", gap });
  live = updateActivityGraphProjection(live, {
    kind: "event",
    event: failedTurn,
  });
  live = updateActivityGraphProjection(live, {
    kind: "terminal-outcome",
    outcome: terminalOutcome,
  });

  const replay = projectActivityGraph({
    rootSourceId: "root",
    events: [completedTool, failedTurn],
    gaps: [gap],
    terminalOutcome,
  });

  assert.deepEqual(live, replay);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(replay.nodesById).map(
        ([id, { state, causalParentNodeId }]) => [
          id,
          { state, causalParentNodeId },
        ],
      ),
    ),
    {
      "root/turn-late/tool-late": {
        state: "failed",
        causalParentNodeId: "root/turn-late",
      },
      "root/turn-late": {
        state: "failed",
        causalParentNodeId: null,
      },
    },
  );
  assert.deepEqual(replay.causalEdgesById, {
    "causal:root/turn-late->root/turn-late/tool-late": {
      fromActivityNodeId: "root/turn-late",
      toActivityNodeId: "root/turn-late/tool-late",
      relationship: "causal",
    },
  });
  assert.equal(replay.integrity, "incomplete");
  assert.equal(replay.tokens.skillRun.availability, "unavailable");
  assert.deepEqual(replay.terminalOutcome, terminalOutcome);
});

test("projects cancellation independently from Trace completeness", () => {
  const cancelledTurn = event({
    id: "root/turn-cancelled/turn/completed",
    sequence: 1,
    method: "turn/completed",
    kind: "turn",
    causalParentId: "root/turn-cancelled",
    payload: {
      threadId: "root",
      turn: { id: "turn-cancelled", status: "interrupted" },
    },
  });

  const graph = projectActivityGraph({
    rootSourceId: "root",
    events: [cancelledTurn],
    gaps: [],
    terminalOutcome: { kind: "cancelled" },
  });

  assert.equal(graph.nodesById["root/turn-cancelled"]?.type, "turn");
  assert.equal(graph.nodesById["root/turn-cancelled"]?.state, "cancelled");
  assert.deepEqual(graph.terminalOutcome, { kind: "cancelled" });
  assert.equal(graph.integrity, "complete");
});

test("keeps an item-scoped Unknown Event as an explicit coverage warning", () => {
  const command = event({
    id: "root/turn-1/command-1/completed",
    sequence: 1,
    method: "item/completed",
    kind: "command",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "completed" },
    },
  });
  const unknown = event({
    id: "root/event/2",
    sequence: 2,
    method: "item/commandExecution/futureDelta",
    kind: "unknown",
    causalParentId: "root/turn-1/command-1",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      itemId: "command-1",
      protocolValue: "preserved",
    },
  });

  const graph = projectActivityGraph(input([command, unknown]));

  assert.deepEqual(graph.lanesBySource.root?.nodeIds, [
    "root/turn-1/command-1",
    unknown.id,
  ]);
  assert.equal(graph.nodesById[unknown.id]?.type, "unknown");
  assert.equal(
    graph.nodesById[unknown.id]?.coverageWarning,
    "Unsupported Event semantics: item/commandExecution/futureDelta",
  );
  assert.deepEqual(graph.nodesById[unknown.id]?.eventIds, [unknown.id]);
  assert.deepEqual(Object.keys(graph.causalEdgesById), [
    `causal:${command.id.replace(/\/completed$/, "")}->${unknown.id}`,
  ]);
});

test("keeps a gap-only spawned child lane and unavailable token view", () => {
  const spawn = event({
    id: "root/turn-1/spawn/started",
    sequence: 1,
    method: "item/started",
    kind: "collaboration",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["missing-child"],
      },
    },
  });
  const gap = {
    afterEventId: spawn.id,
    historyBoundary: "failed history recovery" as const,
    sources: ["missing-child"],
    reason: "descendant history unavailable",
  };

  const graph = projectActivityGraph({
    rootSourceId: "root",
    events: [spawn],
    gaps: [gap],
    terminalOutcome: null,
  });

  assert.deepEqual(graph.lanesBySource["missing-child"], {
    sourceId: "missing-child",
    sourceDepth: 1,
    sourceParentActivityNodeId: "root/turn-1/spawn",
    nodeIds: [],
  });
  assert.deepEqual(graph.tokens.bySource["missing-child"], {
    sourceId: "missing-child",
    availability: "unavailable",
    values: null,
  });
});

test("derives agent lifecycle state and bounded summaries from reported activity", () => {
  const startedAgent = event({
    id: "root/turn-1/agent-start/completed",
    sequence: 1,
    method: "item/completed",
    kind: "collaboration",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: {
        id: "agent-start",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/reviewer",
      },
    },
  });
  const message = event({
    id: "root/turn-1/message/completed",
    sequence: 2,
    method: "item/completed",
    kind: "agent",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: {
        id: "message",
        type: "agentMessage",
        text: "x".repeat(200),
      },
    },
  });

  const graph = projectActivityGraph(input([startedAgent, message]));

  assert.equal(graph.nodesById["root/agent/child"]?.state, "running");
  assert.equal(
    graph.nodesById["root/agent/child"]?.summary,
    "Agent started: /root/reviewer",
  );
  assert.equal(graph.nodesById["root/turn-1/message"]?.summary.length, 120);
  assert.match(graph.nodesById["root/turn-1/message"]?.summary ?? "", /…$/);
});

test("incremental updates retain unaffected keyed graph state", () => {
  const childTool = event({
    id: "child/turn-child/tool/completed",
    sourceId: "child",
    sourceDepth: 1,
    sourceParentId: "root/turn-1/spawn/started",
    sequence: 1,
    method: "item/completed",
    kind: "tool",
    causalParentId: "child/turn-child",
    payload: {
      threadId: "child",
      turnId: "turn-child",
      item: { id: "tool", type: "mcpToolCall", tool: "lookup", status: "completed" },
    },
  });
  const initial = projectActivityGraph(input([childTool]));
  const unaffectedNode = initial.nodesById["child/turn-child/tool"];
  const unaffectedEvents = initial.eventsBySource.child;
  const rootMessage = event({
    id: "root/turn-1/message/completed",
    sequence: 1,
    method: "item/completed",
    kind: "agent",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "message", type: "agentMessage", text: "done" },
    },
  });

  const updated = updateActivityGraphProjection(initial, {
    kind: "event",
    event: rootMessage,
  });

  assert.equal(updated.nodesById["child/turn-child/tool"], unaffectedNode);
  assert.equal(updated.eventsBySource.child, unaffectedEvents);
  assert.equal(updated.eventsById[childTool.id], childTool);
  assert.equal(updated.eventsById[rootMessage.id], rootMessage);
});

test("late spawn causality resolves identically for live updates and replay", () => {
  const spawn = event({
    id: "root/turn-1/spawn/started",
    sequence: 1,
    method: "item/started",
    kind: "collaboration",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["child"],
        status: "inProgress",
      },
    },
  });
  const childTool = event({
    id: "child/turn-child/tool/completed",
    sourceId: "child",
    sourceDepth: 1,
    sourceParentId: spawn.id,
    sequence: 1,
    method: "item/completed",
    kind: "tool",
    causalParentId: "child/turn-child",
    payload: {
      threadId: "child",
      turnId: "turn-child",
      item: { id: "tool", type: "mcpToolCall", tool: "lookup", status: "completed" },
    },
  });

  let live = projectActivityGraph(input([]));
  live = updateActivityGraphProjection(live, { kind: "event", event: childTool });
  live = updateActivityGraphProjection(live, { kind: "event", event: spawn });
  const replay = projectActivityGraph(input([childTool, spawn]));

  assert.deepEqual(live, replay);
  assert.equal(
    live.lanesBySource.child?.sourceParentActivityNodeId,
    "root/turn-1/spawn",
  );
  assert.deepEqual(live.causalEdgesById, {
    "spawn:root/turn-1/spawn->child/turn-child/tool": {
      fromActivityNodeId: "root/turn-1/spawn",
      toActivityNodeId: "child/turn-child/tool",
      relationship: "spawn",
    },
  });
});

test("gap placeholders adopt authoritative source depth when live activity arrives", () => {
  const childTool = event({
    id: "child/turn-child/tool/completed",
    sourceId: "child",
    sourceDepth: 2,
    sequence: 1,
    method: "item/completed",
    kind: "tool",
    causalParentId: "child/turn-child",
    payload: {
      threadId: "child",
      turnId: "turn-child",
      item: { id: "tool", type: "mcpToolCall", tool: "lookup", status: "completed" },
    },
  });
  const gap = {
    afterEventId: null,
    historyBoundary: "initial history" as const,
    sources: ["child"],
    reason: "child unavailable before attachment",
  };

  let live = projectActivityGraph(input([]));
  live = updateActivityGraphProjection(live, { kind: "gap", gap });
  live = updateActivityGraphProjection(live, { kind: "event", event: childTool });
  const replay = projectActivityGraph({
    rootSourceId: "root",
    events: [childTool],
    gaps: [gap],
    terminalOutcome: null,
  });

  assert.deepEqual(live, replay);
  assert.equal(live.lanesBySource.child?.sourceDepth, 2);
});

test("folds an Unknown item lifecycle while preserving its warning", () => {
  const started = event({
    id: "root/turn-1/future/started",
    sequence: 1,
    method: "item/started",
    kind: "unknown",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "future", type: "futureActivity", status: "inProgress" },
    },
  });
  const completed = event({
    id: "root/turn-1/future/completed",
    sequence: 2,
    method: "item/completed",
    kind: "unknown",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "future", type: "futureActivity", status: "completed" },
    },
  });

  const graph = projectActivityGraph(input([started, completed]));

  assert.deepEqual(graph.nodesById["root/turn-1/future"]?.eventIds, [
    started.id,
    completed.id,
  ]);
  assert.equal(graph.nodesById["root/turn-1/future"]?.state, "completed");
  assert.equal(
    graph.nodesById["root/turn-1/future"]?.coverageWarning,
    "Unsupported Event semantics: futureActivity",
  );
});

test("incremental updates preserve unaffected causal edge identity", () => {
  const turn = event({
    id: "root/turn-1/turn/completed",
    sequence: 1,
    method: "turn/completed",
    kind: "turn",
    causalParentId: "root/turn-1",
    payload: { threadId: "root", turn: { id: "turn-1", status: "completed" } },
  });
  const tool = event({
    id: "root/turn-1/tool/completed",
    sequence: 2,
    method: "item/completed",
    kind: "tool",
    causalParentId: "root/turn-1",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "tool", type: "mcpToolCall", tool: "lookup", status: "completed" },
    },
  });
  const initial = projectActivityGraph(input([turn, tool]));
  const edgeId = "causal:root/turn-1->root/turn-1/tool";
  const unaffectedEdge = initial.causalEdgesById[edgeId];
  const message = event({
    id: "root/turn-1/message/completed",
    sequence: 3,
    method: "item/completed",
    kind: "agent",
    payload: {
      threadId: "root",
      turnId: "turn-1",
      item: { id: "message", type: "agentMessage", text: "done" },
    },
  });

  const updated = updateActivityGraphProjection(initial, {
    kind: "event",
    event: message,
  });

  assert.equal(updated.causalEdgesById[edgeId], unaffectedEdge);
});

test("child interaction activity does not reverse spawn causality", () => {
  const spawn = event({
    id: "root/turn-root/spawn/started",
    sequence: 1,
    method: "item/started",
    kind: "collaboration",
    payload: {
      threadId: "root",
      turnId: "turn-root",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["child"],
        status: "inProgress",
      },
    },
  });
  const interaction = event({
    id: "child/turn-child/interact/completed",
    sourceId: "child",
    sourceDepth: 1,
    sourceParentId: spawn.id,
    sequence: 1,
    method: "item/completed",
    kind: "collaboration",
    causalParentId: "child/turn-child",
    payload: {
      threadId: "child",
      turnId: "turn-child",
      item: {
        id: "interact",
        type: "subAgentActivity",
        kind: "interacted",
        agentThreadId: "root",
        agentPath: "/root",
      },
    },
  });

  let live = projectActivityGraph(input([]));
  live = updateActivityGraphProjection(live, { kind: "event", event: spawn });
  live = updateActivityGraphProjection(live, { kind: "event", event: interaction });
  const replay = projectActivityGraph(input([spawn, interaction]));

  assert.deepEqual(live, replay);
  assert.equal(live.lanesBySource.root?.sourceParentActivityNodeId, null);
  assert.equal(live.lanesBySource.root?.sourceDepth, 0);
  assert.equal(
    Object.values(live.causalEdgesById).some(
      (edge) => edge.toActivityNodeId === "root/turn-root/spawn",
    ),
    false,
  );
});

test("gap-only child placeholder adopts later authoritative spawn causality", () => {
  const spawn = event({
    id: "parent/turn-parent/spawn/started",
    sourceId: "parent",
    sourceDepth: 1,
    sequence: 1,
    method: "item/started",
    kind: "collaboration",
    causalParentId: "parent/turn-parent",
    payload: {
      threadId: "parent",
      turnId: "turn-parent",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["grandchild"],
        status: "inProgress",
      },
    },
  });
  const gap = {
    afterEventId: null,
    historyBoundary: "initial history" as const,
    sources: ["grandchild"],
    reason: "grandchild history unavailable",
  };

  let live = projectActivityGraph(input([]));
  live = updateActivityGraphProjection(live, { kind: "gap", gap });
  live = updateActivityGraphProjection(live, { kind: "event", event: spawn });
  const replay = projectActivityGraph({
    rootSourceId: "root",
    events: [spawn],
    gaps: [gap],
    terminalOutcome: null,
  });

  assert.deepEqual(live, replay);
  assert.equal(live.lanesBySource.grandchild?.sourceDepth, 2);
  assert.equal(
    live.lanesBySource.grandchild?.sourceParentActivityNodeId,
    "parent/turn-parent/spawn",
  );
});
