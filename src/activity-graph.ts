import {
  unknownEventSourceType,
  type NormalizedEvent,
} from "./trace-event.js";
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";

export type ActivityNodeType =
  | "agent"
  | "turn"
  | "tool"
  | "command"
  | "file-change"
  | "unknown";

export type ActivityNodeState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ActivityNode {
  readonly id: string;
  readonly type: ActivityNodeType;
  readonly state: ActivityNodeState;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly causalParentNodeId: string | null;
  readonly eventIds: readonly string[];
  readonly summary: string;
  readonly durationMs: number | null;
  readonly coverageWarning: string | null;
}

export interface SourceLane {
  readonly sourceId: string;
  readonly sourceDepth: number;
  readonly sourceParentActivityNodeId: string | null;
  readonly nodeIds: readonly string[];
}

export interface ActivityCausalEdge {
  readonly fromActivityNodeId: string;
  readonly toActivityNodeId: string;
  readonly relationship: "causal" | "spawn";
}

export interface ReportedTokenValues {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly modelContextWindow?: number;
}

export interface SourceTokenView {
  readonly sourceId: string;
  readonly availability: "reported" | "unavailable" | "not-reported";
  readonly values: ReportedTokenValues | null;
}

export interface TokenProjection {
  readonly skillRun: SourceTokenView;
  readonly bySource: Readonly<Record<string, SourceTokenView>>;
}

export interface SecondaryActivityProjection {
  readonly reasoningEventIdsBySource: Readonly<Record<string, readonly string[]>>;
  readonly resourceEventIdsBySource: Readonly<Record<string, readonly string[]>>;
}

export interface ActivityGraphProjectionInput {
  readonly rootSourceId: string;
  readonly events: readonly NormalizedEvent[];
  readonly gaps: readonly TraceGap[];
  readonly terminalOutcome: TerminalOutcome | null;
}

export interface ActivityGraphProjection {
  readonly rootSourceId: string;
  readonly ordering: "per-source-only";
  readonly eventsById: Readonly<Record<string, NormalizedEvent>>;
  readonly eventsBySource: Readonly<Record<string, readonly NormalizedEvent[]>>;
  readonly nodesById: Readonly<Record<string, ActivityNode>>;
  readonly lanesBySource: Readonly<Record<string, SourceLane>>;
  readonly causalEdgesById: Readonly<Record<string, ActivityCausalEdge>>;
  readonly secondary: SecondaryActivityProjection;
  readonly tokens: TokenProjection;
  readonly gaps: readonly TraceGap[];
  readonly integrity: "complete" | "incomplete";
  readonly terminalOutcome: TerminalOutcome | null;
}

export type ActivityGraphProjectionUpdate =
  | { readonly kind: "event"; readonly event: NormalizedEvent }
  | { readonly kind: "gap"; readonly gap: TraceGap }
  | { readonly kind: "terminal-outcome"; readonly outcome: TerminalOutcome };

export function updateActivityGraphProjection(
  projection: ActivityGraphProjection,
  update: ActivityGraphProjectionUpdate,
): ActivityGraphProjection {
  if (update.kind === "terminal-outcome") {
    return Object.freeze({
      ...projection,
      terminalOutcome: freezeTerminalOutcome(update.outcome),
    });
  }
  if (update.kind === "gap") return projectGapUpdate(projection, update.gap);
  if (projection.eventsById[update.event.id] !== undefined) return projection;
  return projectEventUpdate(projection, update.event);
}

export function projectActivityGraph(
  input: ActivityGraphProjectionInput,
): ActivityGraphProjection {
  const eventsById: Record<string, NormalizedEvent> = {};
  const eventsBySource: Record<string, readonly NormalizedEvent[]> = {};
  for (const sourceId of [...new Set(input.events.map((event) => event.sourceId))].sort()) {
    const sourceEvents = input.events
      .filter((event) => event.sourceId === sourceId)
      .sort((left, right) => left.sourceSequence - right.sourceSequence);
    eventsBySource[sourceId] = Object.freeze(sourceEvents);
    for (const event of sourceEvents) eventsById[event.id] = event;
  }

  const grouped = new Map<
    string,
    { readonly type: ActivityNodeType; readonly events: NormalizedEvent[] }
  >();
  for (const event of input.events) {
    const type = activityNodeType(event);
    if (type === null) continue;
    const id = activityNodeId(event);
    const group = grouped.get(id) ?? { type, events: [] };
    group.events.push(event);
    grouped.set(id, group);
  }
  const nodes = [...grouped.entries()].map(([id, group]) =>
    createActivityNode(id, group.type, group.events, eventsById),
  );
  const laneMetadata = new Map<
    string,
    {
      readonly sourceDepth: number;
      readonly sourceParentActivityNodeId: string | null;
    }
  >();
  for (const event of input.events) {
    if (!laneMetadata.has(event.sourceId)) {
      laneMetadata.set(event.sourceId, {
        sourceDepth: event.sourceDepth,
        sourceParentActivityNodeId:
          event.sourceParentId === null
            ? null
            : resolveActivityReference(event.sourceParentId, eventsById),
      });
    }
    for (const sourceId of spawnedSourceIds(event)) {
      if (laneMetadata.has(sourceId)) continue;
      laneMetadata.set(sourceId, {
        sourceDepth: event.sourceDepth + 1,
        sourceParentActivityNodeId: activityNodeId(event),
      });
    }
  }
  if (!laneMetadata.has(input.rootSourceId)) {
    laneMetadata.set(input.rootSourceId, {
      sourceDepth: 0,
      sourceParentActivityNodeId: null,
    });
  }
  for (const gap of input.gaps) {
    for (const sourceId of gap.sources) {
      if (laneMetadata.has(sourceId)) continue;
      laneMetadata.set(sourceId, {
        sourceDepth: 0,
        sourceParentActivityNodeId: null,
      });
    }
  }
  const lanesBySource: Record<string, SourceLane> = {};
  for (const sourceId of [...laneMetadata.keys()].sort()) {
    const metadata = laneMetadata.get(sourceId)!;
    lanesBySource[sourceId] = Object.freeze({
      sourceId,
      sourceDepth: metadata.sourceDepth,
      sourceParentActivityNodeId: metadata.sourceParentActivityNodeId,
      nodeIds: Object.freeze(
        nodes
          .filter((node) => node.sourceId === sourceId)
          .sort((left, right) => left.sourceSequence - right.sourceSequence)
          .map((node) => node.id),
      ),
    });
  }
  const nodesById: Record<string, ActivityNode> = {};
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    nodesById[node.id] = node;
  }
  const causalEdgesById = createCausalEdges(nodesById, lanesBySource);
  const sourceOrder = Object.keys(lanesBySource).sort();
  const reasoningEventIdsBySource: Record<string, readonly string[]> = {};
  const resourceEventIdsBySource: Record<string, readonly string[]> = {};
  for (const sourceId of sourceOrder) {
    const sourceEvents = eventsBySource[sourceId] ?? [];
    const reasoningIds = sourceEvents
      .filter((event) => event.kind === "reasoning")
      .map((event) => event.id);
    const resourceIds = sourceEvents
      .filter((event) => event.kind === "resource")
      .map((event) => event.id);
    if (reasoningIds.length > 0) {
      reasoningEventIdsBySource[sourceId] = Object.freeze(reasoningIds);
    }
    if (resourceIds.length > 0) {
      resourceEventIdsBySource[sourceId] = Object.freeze(resourceIds);
    }
  }
  const unavailableSources = new Set(
    input.gaps.flatMap((gap) => [...gap.sources]),
  );
  const tokensBySource: Record<string, SourceTokenView> = {};
  for (const sourceId of sourceOrder) {
    tokensBySource[sourceId] = sourceTokenView(
      sourceId,
      eventsBySource[sourceId] ?? [],
      unavailableSources.has(sourceId),
    );
  }
  const skillRun =
    tokensBySource[input.rootSourceId] ??
    sourceTokenView(input.rootSourceId, [], unavailableSources.has(input.rootSourceId));
  const gaps = input.gaps.map((gap) =>
    Object.freeze({
      ...gap,
      sources: Object.freeze([...gap.sources]),
    }),
  );

  return Object.freeze({
    rootSourceId: input.rootSourceId,
    ordering: "per-source-only",
    eventsById: Object.freeze(eventsById),
    eventsBySource: Object.freeze(eventsBySource),
    nodesById: Object.freeze(nodesById),
    lanesBySource: Object.freeze(lanesBySource),
    causalEdgesById: Object.freeze(causalEdgesById),
    secondary: Object.freeze({
      reasoningEventIdsBySource: Object.freeze(reasoningEventIdsBySource),
      resourceEventIdsBySource: Object.freeze(resourceEventIdsBySource),
    }),
    tokens: Object.freeze({
      skillRun,
      bySource: Object.freeze(tokensBySource),
    }),
    gaps: Object.freeze(gaps),
    integrity: gaps.length === 0 ? "complete" : "incomplete",
    terminalOutcome: freezeTerminalOutcome(input.terminalOutcome),
  });
}

function projectEventUpdate(
  projection: ActivityGraphProjection,
  event: NormalizedEvent,
): ActivityGraphProjection {
  const eventsById = Object.freeze({
    ...projection.eventsById,
    [event.id]: event,
  });
  const sourceEvents = [...(projection.eventsBySource[event.sourceId] ?? []), event]
    .sort((left, right) => left.sourceSequence - right.sourceSequence);
  const eventsBySource = Object.freeze({
    ...projection.eventsBySource,
    [event.sourceId]: Object.freeze(sourceEvents),
  });

  const nodesById: Record<string, ActivityNode> = {
    ...projection.nodesById,
  };
  const type = activityNodeType(event);
  let updatedNodeId: string | null = null;
  if (type !== null) {
    updatedNodeId = activityNodeId(event);
    const previousNode = nodesById[updatedNodeId];
    const nodeEvents = [
      ...(previousNode?.eventIds.flatMap((eventId) => {
        const previousEvent = projection.eventsById[eventId];
        return previousEvent === undefined ? [] : [previousEvent];
      }) ?? []),
      event,
    ];
    nodesById[updatedNodeId] = createActivityNode(
      updatedNodeId,
      previousNode?.type ?? type,
      nodeEvents,
      eventsById,
    );
  }

  const lanesBySource: Record<string, SourceLane> = {
    ...projection.lanesBySource,
  };
  const currentLane = lanesBySource[event.sourceId];
  const sourceParentActivityNodeId =
    event.sourceParentId === null
      ? null
      : resolveActivityReference(event.sourceParentId, eventsById);
  const nodeIds = new Set(currentLane?.nodeIds ?? []);
  if (updatedNodeId !== null) nodeIds.add(updatedNodeId);
  lanesBySource[event.sourceId] = createSourceLane(
    event.sourceId,
    event.sourceDepth,
    currentLane?.sourceParentActivityNodeId ?? sourceParentActivityNodeId,
    [...nodeIds],
    nodesById,
  );
  for (const sourceId of spawnedSourceIds(event)) {
    const existingLane = lanesBySource[sourceId];
    const spawnedDepth = event.sourceDepth + 1;
    const laneHasObservedEvents =
      (projection.eventsBySource[sourceId]?.length ?? 0) > 0;
    if (
      existingLane !== undefined &&
      laneHasObservedEvents &&
      existingLane.sourceDepth < spawnedDepth
    ) {
      continue;
    }
    lanesBySource[sourceId] = createSourceLane(
      sourceId,
      laneHasObservedEvents ? (existingLane?.sourceDepth ?? spawnedDepth) : spawnedDepth,
      activityNodeId(event),
      existingLane?.nodeIds ?? [],
      nodesById,
    );
  }

  const reasoningEventIdsBySource = {
    ...projection.secondary.reasoningEventIdsBySource,
  };
  const resourceEventIdsBySource = {
    ...projection.secondary.resourceEventIdsBySource,
  };
  if (event.kind === "reasoning") {
    reasoningEventIdsBySource[event.sourceId] = Object.freeze(
      sourceEvents
        .filter((sourceEvent) => sourceEvent.kind === "reasoning")
        .map((sourceEvent) => sourceEvent.id),
    );
  }
  if (event.kind === "resource") {
    resourceEventIdsBySource[event.sourceId] = Object.freeze(
      sourceEvents
        .filter((sourceEvent) => sourceEvent.kind === "resource")
        .map((sourceEvent) => sourceEvent.id),
    );
  }

  const unavailableSources = unavailableSourceIds(projection.gaps);
  const tokensBySource: Record<string, SourceTokenView> = {
    ...projection.tokens.bySource,
    [event.sourceId]: sourceTokenView(
      event.sourceId,
      sourceEvents,
      unavailableSources.has(event.sourceId),
    ),
  };
  for (const sourceId of Object.keys(lanesBySource)) {
    tokensBySource[sourceId] ??= sourceTokenView(
      sourceId,
      [],
      unavailableSources.has(sourceId),
    );
  }
  const skillRun =
    tokensBySource[projection.rootSourceId] ??
    sourceTokenView(
      projection.rootSourceId,
      [],
      unavailableSources.has(projection.rootSourceId),
    );
  const newlyResolvableNodeIds =
    updatedNodeId === null
      ? []
      : (lanesBySource[event.sourceId]?.nodeIds ?? []).filter((nodeId) => {
          const node = nodesById[nodeId];
          if (node?.causalParentNodeId !== updatedNodeId) return false;
          const edgeId = causalEdgeId(updatedNodeId, nodeId, "causal");
          return projection.causalEdgesById[edgeId] === undefined;
        });
  const affectedNodeIds = [
    ...(updatedNodeId === null ? [] : [updatedNodeId]),
    ...newlyResolvableNodeIds,
  ];

  return Object.freeze({
    ...projection,
    eventsById,
    eventsBySource,
    nodesById: Object.freeze(nodesById),
    lanesBySource: Object.freeze(lanesBySource),
    causalEdgesById: updateCausalEdges(
      projection.causalEdgesById,
      nodesById,
      lanesBySource,
      affectedNodeIds,
      [event.sourceId, ...spawnedSourceIds(event)],
    ),
    secondary: Object.freeze({
      reasoningEventIdsBySource: Object.freeze(reasoningEventIdsBySource),
      resourceEventIdsBySource: Object.freeze(resourceEventIdsBySource),
    }),
    tokens: Object.freeze({
      skillRun,
      bySource: Object.freeze(tokensBySource),
    }),
  });
}

function projectGapUpdate(
  projection: ActivityGraphProjection,
  gap: TraceGap,
): ActivityGraphProjection {
  const frozenGap = Object.freeze({
    ...gap,
    sources: Object.freeze([...gap.sources]),
  });
  const lanesBySource: Record<string, SourceLane> = {
    ...projection.lanesBySource,
  };
  const tokensBySource: Record<string, SourceTokenView> = {
    ...projection.tokens.bySource,
  };
  for (const sourceId of gap.sources) {
    lanesBySource[sourceId] ??= createSourceLane(
      sourceId,
      0,
      null,
      [],
      projection.nodesById,
    );
    const existingTokens = tokensBySource[sourceId];
    tokensBySource[sourceId] = Object.freeze({
      sourceId,
      availability: "unavailable",
      values: existingTokens?.values ?? null,
    });
  }
  const skillRun =
    tokensBySource[projection.rootSourceId] ?? projection.tokens.skillRun;
  const gaps = Object.freeze([...projection.gaps, frozenGap]);
  return Object.freeze({
    ...projection,
    lanesBySource: Object.freeze(lanesBySource),
    tokens: Object.freeze({
      skillRun,
      bySource: Object.freeze(tokensBySource),
    }),
    gaps,
    integrity: "incomplete",
  });
}

function createSourceLane(
  sourceId: string,
  sourceDepth: number,
  sourceParentActivityNodeId: string | null,
  nodeIds: readonly string[],
  nodesById: Readonly<Record<string, ActivityNode>>,
): SourceLane {
  return Object.freeze({
    sourceId,
    sourceDepth,
    sourceParentActivityNodeId,
    nodeIds: Object.freeze(
      [...nodeIds].sort(
        (left, right) =>
          (nodesById[left]?.sourceSequence ?? Number.MAX_SAFE_INTEGER) -
            (nodesById[right]?.sourceSequence ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right),
      ),
    ),
  });
}

function createCausalEdges(
  nodesById: Readonly<Record<string, ActivityNode>>,
  lanesBySource: Readonly<Record<string, SourceLane>>,
): Readonly<Record<string, ActivityCausalEdge>> {
  const causalEdgesById: Record<string, ActivityCausalEdge> = {};
  for (const node of Object.values(nodesById)) {
    if (node.causalParentNodeId !== null) {
      addCausalEdge(
        causalEdgesById,
        nodesById,
        node.causalParentNodeId,
        node.id,
        "causal",
      );
    }
  }
  for (const lane of Object.values(lanesBySource)) {
    const firstNodeId = lane.nodeIds[0];
    if (lane.sourceParentActivityNodeId !== null && firstNodeId !== undefined) {
      addCausalEdge(
        causalEdgesById,
        nodesById,
        lane.sourceParentActivityNodeId,
        firstNodeId,
        "spawn",
      );
    }
  }
  return Object.freeze(causalEdgesById);
}

function updateCausalEdges(
  currentEdges: Readonly<Record<string, ActivityCausalEdge>>,
  nodesById: Readonly<Record<string, ActivityNode>>,
  lanesBySource: Readonly<Record<string, SourceLane>>,
  affectedNodeIds: readonly string[],
  affectedSourceIds: readonly string[],
): Readonly<Record<string, ActivityCausalEdge>> {
  const affectedTargets = new Set(affectedNodeIds);
  for (const sourceId of affectedSourceIds) {
    const firstNodeId = lanesBySource[sourceId]?.nodeIds[0];
    if (firstNodeId !== undefined) affectedTargets.add(firstNodeId);
  }
  const edges: Record<string, ActivityCausalEdge> = { ...currentEdges };
  for (const [edgeId, edge] of Object.entries(edges)) {
    if (affectedTargets.has(edge.toActivityNodeId)) delete edges[edgeId];
  }
  for (const nodeId of affectedNodeIds) {
    const node = nodesById[nodeId];
    if (node?.causalParentNodeId !== null && node?.causalParentNodeId !== undefined) {
      addCausalEdge(
        edges,
        nodesById,
        node.causalParentNodeId,
        node.id,
        "causal",
      );
    }
  }
  for (const sourceId of affectedSourceIds) {
    const lane = lanesBySource[sourceId];
    const firstNodeId = lane?.nodeIds[0];
    if (lane?.sourceParentActivityNodeId !== null &&
      lane?.sourceParentActivityNodeId !== undefined &&
      firstNodeId !== undefined) {
      addCausalEdge(
        edges,
        nodesById,
        lane.sourceParentActivityNodeId,
        firstNodeId,
        "spawn",
      );
    }
  }
  return Object.freeze(edges);
}

function addCausalEdge(
  edges: Record<string, ActivityCausalEdge>,
  nodesById: Readonly<Record<string, ActivityNode>>,
  fromActivityNodeId: string,
  toActivityNodeId: string,
  relationship: ActivityCausalEdge["relationship"],
): void {
  if (
    fromActivityNodeId === toActivityNodeId ||
    nodesById[fromActivityNodeId] === undefined ||
    nodesById[toActivityNodeId] === undefined
  ) {
    return;
  }
  const edgeId = causalEdgeId(
    fromActivityNodeId,
    toActivityNodeId,
    relationship,
  );
  edges[edgeId] = Object.freeze({
    fromActivityNodeId,
    toActivityNodeId,
    relationship,
  });
}

function unavailableSourceIds(gaps: readonly TraceGap[]): ReadonlySet<string> {
  return new Set(gaps.flatMap((gap) => [...gap.sources]));
}

function activityNodeType(event: NormalizedEvent): ActivityNodeType | null {
  if (event.kind === "collaboration" || event.kind === "agent") return "agent";
  if (event.kind === "turn") return "turn";
  if (event.kind === "tool") return "tool";
  if (event.kind === "command") return "command";
  if (event.kind === "file-change") return "file-change";
  if (event.kind === "unknown" || event.kind === "error") return "unknown";
  return null;
}

function activityNodeId(event: NormalizedEvent): string {
  if (
    (event.kind === "unknown" || event.kind === "error") &&
    event.method !== "item/started" &&
    event.method !== "item/completed"
  ) {
    return event.id;
  }
  const turnId = eventTurnId(event);
  const item = asObject(event.payload.item);
  if (
    event.kind === "collaboration" &&
    item?.type === "subAgentActivity" &&
    typeof item.agentThreadId === "string"
  ) {
    return `${event.sourceId}/agent/${item.agentThreadId}`;
  }
  const itemId =
    typeof item?.id === "string"
      ? item.id
      : typeof event.payload.itemId === "string"
        ? event.payload.itemId
        : null;
  if (turnId !== null && itemId !== null) {
    return `${event.sourceId}/${turnId}/${itemId}`;
  }
  if (
    turnId !== null &&
    (event.method === "turn/started" || event.method === "turn/completed")
  ) {
    return `${event.sourceId}/${turnId}`;
  }
  return event.id;
}

function eventTurnId(event: NormalizedEvent): string | null {
  if (typeof event.payload.turnId === "string") return event.payload.turnId;
  const turn = asObject(event.payload.turn);
  return typeof turn?.id === "string" ? turn.id : null;
}

function createActivityNode(
  id: string,
  type: ActivityNodeType,
  sourceEvents: readonly NormalizedEvent[],
  eventsById: Readonly<Record<string, NormalizedEvent>>,
): ActivityNode {
  const events = [...sourceEvents].sort(
    (left, right) => left.sourceSequence - right.sourceSequence,
  );
  const first = events[0]!;
  return Object.freeze({
    id,
    type,
    state: nodeState(events),
    sourceId: first.sourceId,
    sourceSequence: first.sourceSequence,
    causalParentNodeId: nodeParent(id, events, eventsById),
    eventIds: Object.freeze(events.map((event) => event.id)),
    summary: nodeSummary(type, events),
    durationMs: latestDuration(events),
    coverageWarning: coverageWarning(type, events),
  });
}

function nodeState(events: readonly NormalizedEvent[]): ActivityNodeState {
  const event = events.at(-1)!;
  const item = asObject(event.payload.item);
  if (item?.type === "subAgentActivity") {
    if (item.kind === "started") return "running";
    if (item.kind === "failed") return "failed";
    if (item.kind === "cancelled" || item.kind === "interrupted") {
      return "cancelled";
    }
    if (item.kind === "completed") return "completed";
    return "unknown";
  }
  if (event.method !== "item/completed" && event.method !== "turn/completed") {
    return "running";
  }
  const turn = asObject(event.payload.turn);
  const status = item?.status ?? turn?.status;
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  return "completed";
}

function nodeParent(
  nodeId: string,
  events: readonly NormalizedEvent[],
  eventsById: Readonly<Record<string, NormalizedEvent>>,
): string | null {
  const parent = events.find(
    (event) =>
      event.causalParentId !== null &&
      resolveActivityReference(event.causalParentId, eventsById) !== nodeId,
  )?.causalParentId;
  return parent === undefined || parent === null
    ? null
    : resolveActivityReference(parent, eventsById);
}

function resolveActivityReference(
  reference: string,
  eventsById: Readonly<Record<string, NormalizedEvent>>,
): string {
  const referencedEvent = eventsById[reference];
  return referencedEvent === undefined || activityNodeType(referencedEvent) === null
    ? reference
    : activityNodeId(referencedEvent);
}

function nodeSummary(
  type: ActivityNodeType,
  events: readonly NormalizedEvent[],
): string {
  for (const event of [...events].reverse()) {
    const item = asObject(event.payload.item);
    if (type === "command" && typeof item?.command === "string") {
      return conciseSummary(item.command);
    }
    if (type === "tool" && typeof item?.tool === "string") {
      return conciseSummary(item.tool);
    }
    if (type === "file-change") {
      const changes = item?.changes;
      if (Array.isArray(changes)) {
        const paths = changes
          .map((change) => asObject(change)?.path)
          .filter((path): path is string => typeof path === "string");
        if (paths.length > 0) return conciseSummary(paths.join(", "));
      }
    }
    if (type === "unknown") {
      return conciseSummary(`Unknown activity: ${unknownEventSourceType(event)}`);
    }
    if (type === "agent" && event.kind === "collaboration") {
      if (item?.type === "subAgentActivity") {
        const lifecycle = typeof item.kind === "string" ? item.kind : "activity";
        const identity =
          typeof item.agentPath === "string"
            ? item.agentPath
            : typeof item.agentThreadId === "string"
              ? item.agentThreadId
              : "agent";
        return conciseSummary(`Agent ${lifecycle}: ${identity}`);
      }
      return "Spawn agent";
    }
    if (type === "agent" && typeof item?.text === "string") {
      return conciseSummary(item.text);
    }
    if (type === "turn") {
      const turn = asObject(event.payload.turn);
      if (typeof turn?.id === "string") return conciseSummary(`Turn ${turn.id}`);
    }
  }
  const labels: Record<ActivityNodeType, string> = {
    agent: "Agent activity",
    turn: "Turn",
    tool: "Tool call",
    command: "Command",
    "file-change": "File Change",
    unknown: "Unknown activity",
  };
  return labels[type];
}

function coverageWarning(
  type: ActivityNodeType,
  events: readonly NormalizedEvent[],
): string | null {
  if (type !== "unknown") return null;
  return `Unsupported Event semantics: ${unknownEventSourceType(events.at(-1)!)}`;
}

function latestDuration(events: readonly NormalizedEvent[]): number | null {
  for (const event of [...events].reverse()) {
    if (typeof event.timing?.durationMs === "number") {
      return event.timing.durationMs;
    }
  }
  return null;
}

function conciseSummary(summary: string): string {
  const maximumLength = 120;
  return summary.length <= maximumLength
    ? summary
    : `${summary.slice(0, maximumLength - 1)}…`;
}

function spawnedSourceIds(event: NormalizedEvent): readonly string[] {
  if (event.kind !== "collaboration") return [];
  const item = asObject(event.payload.item);
  if (item === null) return [];
  const receiverIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds
    : [];
  const subagentStartId =
    item.type === "subAgentActivity" && item.kind === "started"
      ? item.agentThreadId
      : undefined;
  return [
    ...receiverIds,
    item.newThreadId,
    item.receiverThreadId,
    subagentStartId,
  ].filter(
    (sourceId): sourceId is string =>
      typeof sourceId === "string" && sourceId !== event.sourceId,
  );
}

function causalEdgeId(
  fromActivityNodeId: string,
  toActivityNodeId: string,
  relationship: ActivityCausalEdge["relationship"],
): string {
  return `${relationship}:${fromActivityNodeId}->${toActivityNodeId}`;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sourceTokenView(
  sourceId: string,
  events: readonly NormalizedEvent[],
  unavailable: boolean,
): SourceTokenView {
  const latestResource = [...events]
    .reverse()
    .find((event) => event.kind === "resource");
  const values =
    latestResource === undefined ? null : reportedTokenValues(latestResource);
  return Object.freeze({
    sourceId,
    availability: unavailable
      ? "unavailable"
      : values === null
        ? "not-reported"
        : "reported",
    values,
  });
}

function reportedTokenValues(
  event: NormalizedEvent,
): ReportedTokenValues | null {
  const tokenUsage = asObject(event.payload.tokenUsage);
  const total = asObject(tokenUsage?.total);
  const values: Record<string, number> = {};
  for (const property of [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const) {
    const value = total?.[property];
    if (typeof value === "number") values[property] = value;
  }
  const modelContextWindow = tokenUsage?.modelContextWindow;
  if (typeof modelContextWindow === "number") {
    values.modelContextWindow = modelContextWindow;
  }
  return Object.keys(values).length === 0
    ? null
    : Object.freeze(values) as ReportedTokenValues;
}

function freezeTerminalOutcome(
  terminalOutcome: TerminalOutcome | null,
): TerminalOutcome | null {
  if (terminalOutcome === null) return null;
  return terminalOutcome.kind === "failed"
    ? Object.freeze({ kind: "failed", error: terminalOutcome.error })
    : Object.freeze({ kind: terminalOutcome.kind });
}
