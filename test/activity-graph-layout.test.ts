import assert from "node:assert/strict";
import test from "node:test";

import {
  layoutActivityGraph,
  type ActivityGraphLayout,
} from "../src/activity-graph-layout.js";
import {
  projectActivityGraph,
  updateActivityGraphProjection,
} from "../src/activity-graph.js";
import { createNormalizedEvent, type NormalizedEvent } from "../src/trace-event.js";

function activity(input: {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly sourceDepth?: number;
  readonly sourceParentId?: string | null;
  readonly causalParentId: string;
  readonly item: Record<string, unknown>;
}): NormalizedEvent {
  return createNormalizedEvent({
    id: input.id,
    sourceId: input.sourceId,
    sourceSequence: input.sourceSequence,
    sourceDepth: input.sourceDepth ?? 0,
    sourceParentId: input.sourceParentId ?? null,
    causalParentId: input.causalParentId,
    method: "item/completed",
    kind: input.item.type === "collabAgentToolCall" ? "collaboration" : "tool",
    timing: null,
    observationSources: ["live"],
    payload: {
      threadId: input.sourceId,
      turnId: "turn",
      item: input.item,
    },
  });
}

test("lays out authoritative source sequence left to right and spawned sources in child lanes", () => {
  const spawn = activity({
    id: "root/turn/spawn/completed",
    sourceId: "root",
    sourceSequence: 1,
    causalParentId: "root/turn",
    item: {
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      receiverThreadIds: ["child"],
      status: "completed",
    },
  });
  const rootTool = activity({
    id: "root/turn/tool/completed",
    sourceId: "root",
    sourceSequence: 2,
    causalParentId: "root/turn",
    item: { id: "tool", type: "mcpToolCall", tool: "finish", status: "completed" },
  });
  const childTool = activity({
    id: "child/turn/tool/completed",
    sourceId: "child",
    sourceSequence: 1,
    sourceDepth: 1,
    sourceParentId: spawn.id,
    causalParentId: "root/turn/tool/completed",
    item: { id: "tool", type: "mcpToolCall", tool: "review", status: "completed" },
  });

  const graph = projectActivityGraph({
    rootSourceId: "root",
    events: [rootTool, childTool, spawn],
    gaps: [],
    terminalOutcome: null,
  });
  const layout = layoutActivityGraph(graph);

  assert.ok(layout.positionsByNodeId["root/turn/spawn"]!.x < layout.positionsByNodeId["root/turn/tool"]!.x);
  assert.ok(layout.laneYBySource.child! > layout.laneYBySource.root!);
  assert.ok(layout.positionsByNodeId["child/turn/tool"]!.x > layout.positionsByNodeId["root/turn/tool"]!.x);
  assert.equal(layout.positionsByNodeId["child/turn/tool"]!.y, layout.laneYBySource.child);
});

test("preserves live node positions until an explicit full re-layout", () => {
  const lateAlphabeticalSource = activity({
    id: "z-child/turn/tool/completed",
    sourceId: "z-child",
    sourceSequence: 1,
    sourceDepth: 1,
    causalParentId: "z-child/turn",
    item: { id: "tool", type: "mcpToolCall", tool: "first", status: "completed" },
  });
  let graph = projectActivityGraph({
    rootSourceId: "root",
    events: [lateAlphabeticalSource],
    gaps: [],
    terminalOutcome: null,
  });
  const initial = layoutActivityGraph(graph);
  const stablePosition = initial.positionsByNodeId["z-child/turn/tool"];
  const earlierSource = activity({
    id: "a-child/turn/tool/completed",
    sourceId: "a-child",
    sourceSequence: 1,
    sourceDepth: 1,
    causalParentId: "a-child/turn",
    item: { id: "tool", type: "mcpToolCall", tool: "second", status: "completed" },
  });
  graph = updateActivityGraphProjection(graph, { kind: "event", event: earlierSource });

  const live = layoutActivityGraph(graph, initial);
  const relaid = layoutActivityGraph(graph);

  assert.deepEqual(live.positionsByNodeId["z-child/turn/tool"], stablePosition);
  assert.notEqual(live.laneYBySource["a-child"], live.laneYBySource["z-child"]);
  assert.ok(relaid.laneYBySource["a-child"]! < relaid.laneYBySource["z-child"]!);
  assert.equal(Object.isFrozen(live), true);
  assert.equal(Object.isFrozen(live.positionsByNodeId), true);
});

void ({} as ActivityGraphLayout);
