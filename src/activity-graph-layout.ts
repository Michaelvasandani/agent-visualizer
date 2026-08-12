import type { ActivityGraphProjection } from "./activity-graph.js";

export interface ActivityNodePosition {
  readonly x: number;
  readonly y: number;
}

export interface ActivityGraphLayout {
  readonly laneYBySource: Readonly<Record<string, number>>;
  readonly positionsByNodeId: Readonly<Record<string, ActivityNodePosition>>;
  readonly width: number;
  readonly height: number;
}

const LANE_TOP = 96;
const LANE_GAP = 168;
const NODE_START_X = 164;
const NODE_GAP = 232;
const CHILD_OFFSET_X = 232;
const CANVAS_PADDING = 180;

/**
 * Produces browser-neutral SVG coordinates. Passing the previous layout is the
 * live-layout contract: coordinates already assigned to Activity Nodes and
 * source lanes are retained while newly observed activity is appended.
 */
export function layoutActivityGraph(
  graph: ActivityGraphProjection,
  previous?: ActivityGraphLayout,
): ActivityGraphLayout {
  const laneYBySource: Record<string, number> = {
    ...(previous?.laneYBySource ?? {}),
  };
  const positionsByNodeId: Record<string, ActivityNodePosition> = {
    ...(previous?.positionsByNodeId ?? {}),
  };
  const orderedSources = sourceLayoutOrder(graph);
  let nextLaneY = Math.max(
    LANE_TOP,
    ...Object.values(laneYBySource).map((value) => value + LANE_GAP),
  );

  for (const [index, sourceId] of orderedSources.entries()) {
    if (laneYBySource[sourceId] === undefined) {
      laneYBySource[sourceId] = previous === undefined
        ? LANE_TOP + index * LANE_GAP
        : nextLaneY;
      nextLaneY = Math.max(nextLaneY, laneYBySource[sourceId] + LANE_GAP);
    }
  }

  for (const sourceId of orderedSources) {
    const lane = graph.lanesBySource[sourceId];
    if (lane === undefined) continue;
    const laneY = laneYBySource[sourceId] ?? LANE_TOP;
    const parentPosition = lane.sourceParentActivityNodeId === null
      ? undefined
      : positionsByNodeId[lane.sourceParentActivityNodeId];
    const laneStart = Math.max(
      NODE_START_X,
      parentPosition === undefined ? NODE_START_X : parentPosition.x + CHILD_OFFSET_X,
    );
    for (const [nodeIndex, nodeId] of lane.nodeIds.entries()) {
      if (positionsByNodeId[nodeId] !== undefined) continue;
      const priorPosition = [...lane.nodeIds]
        .slice(0, nodeIndex)
        .reverse()
        .map((priorNodeId) => positionsByNodeId[priorNodeId])
        .find((position) => position !== undefined);
      positionsByNodeId[nodeId] = Object.freeze({
        x: priorPosition === undefined
          ? laneStart + nodeIndex * NODE_GAP
          : priorPosition.x + NODE_GAP,
        y: laneY,
      });
    }
  }

  const positions = Object.values(positionsByNodeId);
  const width = Math.max(
    900,
    ...positions.map(({ x }) => x + CANVAS_PADDING),
  );
  const height = Math.max(
    420,
    ...Object.values(laneYBySource).map((y) => y + CANVAS_PADDING),
  );
  return Object.freeze({
    laneYBySource: Object.freeze(laneYBySource),
    positionsByNodeId: Object.freeze(positionsByNodeId),
    width,
    height,
  });
}

function sourceLayoutOrder(graph: ActivityGraphProjection): readonly string[] {
  return Object.keys(graph.lanesBySource).sort((leftId, rightId) => {
    if (leftId === graph.rootSourceId) return -1;
    if (rightId === graph.rootSourceId) return 1;
    const left = graph.lanesBySource[leftId]!;
    const right = graph.lanesBySource[rightId]!;
    return left.sourceDepth - right.sourceDepth || leftId.localeCompare(rightId);
  });
}
