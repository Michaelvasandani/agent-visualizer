export type JsonObject = Record<string, unknown>;
export type ImmutableJsonValue =
  | string
  | number
  | boolean
  | null
  | ImmutableJsonObject
  | readonly ImmutableJsonValue[];
export interface ImmutableJsonObject {
  readonly [key: string]: ImmutableJsonValue;
}

export interface EventTiming {
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly durationMs?: number;
}

export type TraceEventKind =
  | "agent"
  | "collaboration"
  | "command"
  | "duration"
  | "error"
  | "file-change"
  | "plan"
  | "reasoning"
  | "resource"
  | "thread"
  | "tool"
  | "turn"
  | "unknown"
  | "user";

export interface NormalizedEvent {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly causalParentId: string | null;
  readonly sourceParentId: string | null;
  readonly sourceDepth: number;
  readonly method: string;
  readonly kind: TraceEventKind;
  readonly timing: EventTiming | null;
  readonly observationSources: readonly ("history" | "live")[];
  readonly payload: ImmutableJsonObject;
}

interface NormalizedEventInput extends Omit<NormalizedEvent, "payload"> {
  readonly payload: JsonObject;
}

export function createNormalizedEvent(
  input: NormalizedEventInput,
): NormalizedEvent {
  return deepFreeze({
    ...input,
    timing: input.timing === null ? null : { ...input.timing },
    observationSources: [...input.observationSources],
    payload: cloneJson(input.payload) as ImmutableJsonObject,
  });
}

export function renderTraceEvent(event: NormalizedEvent): string {
  const indentation = "  ".repeat(event.sourceDepth);
  const sourceParent =
    event.sourceParentId === null ? "" : ` causedBy=${event.sourceParentId}`;
  const timing = event.timing === null ? "" : ` timing=${JSON.stringify(event.timing)}`;
  const sourceType =
    event.kind === "unknown" ? ` sourceType=${unknownSourceType(event)}` : "";
  const causalParent =
    event.causalParentId === null ? "none" : event.causalParentId;
  return (
    `${indentation}[${event.kind}] ${event.method} event=${event.id} ` +
    `source=${event.sourceId} sequence=${event.sourceSequence} ` +
    `parent=${causalParent}${sourceParent}${timing}${sourceType} ` +
    JSON.stringify(event.payload)
  );
}

function unknownSourceType(event: NormalizedEvent): string {
  const item = event.payload.item;
  if (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item)
  ) {
    const itemType = (item as ImmutableJsonObject).type;
    if (typeof itemType === "string") return itemType;
  }
  return event.method;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value !== "object" || value === null) return value;

  const clone: JsonObject = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneJson(child);
  return clone;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
