import { AppServerClient } from "./app-server-client.js";

type JsonObject = Record<string, unknown>;

interface LoadedThreadsResponse {
  readonly data: readonly string[];
  readonly nextCursor: string | null;
}

interface ThreadResumeResponse {
  readonly thread: {
    readonly id: string;
    readonly turns: readonly HistoryTurn[];
  };
}

interface HistoryTurn {
  readonly id: string;
  readonly items: readonly JsonObject[];
  readonly status?: string;
}

interface TraceEvent {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly causalParentId: string;
  readonly method: string;
  readonly kind: string;
  readonly payload: JsonObject;
}

type LifecycleMethod = "item/started" | "item/completed";

interface IndexedNotification {
  readonly index: number;
  readonly notification: JsonObject;
}

interface ReplayCandidate {
  readonly method: LifecycleMethod;
  readonly payload: JsonObject;
  readonly bufferRank: number | null;
}

const SENSITIVE_DATA_WARNING =
  "WARNING: THIS LIVE TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Prompts, credentials, paths, proprietary content, and personal data may be " +
  "exposed in terminal output; the Skill Contract and Trace are sent unredacted " +
  "to OpenAI by later Evaluation Runs.";

export async function traceLoadedThread(
  serverUrl: string,
  writeLine: (line: string) => void,
  selectThread: (threadIds: readonly string[]) => Promise<string> =
    rejectMultipleThreads,
): Promise<void> {
  writeLine(SENSITIVE_DATA_WARNING);
  const client = await AppServerClient.connect(serverUrl);

  try {
    const threadIds = await listAllLoadedThreads(client);
    const threadId = await chooseLoadedThread(threadIds, writeLine, selectThread);

    await observeResumedThread(client, threadId, writeLine);
    await client.request("thread/unsubscribe", { threadId });
  } finally {
    client.close();
  }
}

async function chooseLoadedThread(
  threadIds: readonly string[],
  writeLine: (line: string) => void,
  selectThread: (threadIds: readonly string[]) => Promise<string>,
): Promise<string> {
  const onlyThreadId = threadIds[0];
  if (threadIds.length === 1 && onlyThreadId !== undefined) {
    writeLine(`Automatically selected the only loaded thread: ${onlyThreadId}`);
    return onlyThreadId;
  }
  if (threadIds.length === 0) {
    throw new Error("No loaded threads are available to trace.");
  }

  writeLine("Multiple loaded threads are available:");
  threadIds.forEach((threadId, index) => {
    writeLine(`${index + 1}. ${threadId}`);
  });
  const selectedThreadId = await selectThread(threadIds);
  if (!threadIds.includes(selectedThreadId)) {
    throw new Error("The selected thread is not loaded.");
  }
  writeLine(`Selected loaded thread: ${selectedThreadId}`);
  return selectedThreadId;
}

async function rejectMultipleThreads(): Promise<never> {
  throw new Error("Multiple loaded threads require an explicit selection.");
}

async function listAllLoadedThreads(
  client: AppServerClient,
): Promise<readonly string[]> {
  const threadIds: string[] = [];
  let cursor: string | null = null;
  do {
    const response: LoadedThreadsResponse =
      await client.request<LoadedThreadsResponse>(
        "thread/loaded/list",
        cursor === null ? {} : { cursor },
      );
    threadIds.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null);
  return threadIds;
}

async function observeResumedThread(
  client: AppServerClient,
  threadId: string,
  writeLine: (line: string) => void,
): Promise<void> {
  const pipeline = new EventPipeline(threadId, writeLine);
  const bufferedNotifications: JsonObject[] = [];
  let replayingHistory = true;
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const processNotification = (notification: JsonObject): void => {
    const params = asObject(notification.params);
    if (params?.threadId !== threadId) return;
    const method = notification.method;
    if (typeof method !== "string") return;
    pipeline.append(method, params);
    if (method === "turn/completed") resolveCompletion();
  };

  const removeHandler = client.onNotification((notification) => {
    if (replayingHistory) {
      bufferedNotifications.push(notification);
      return;
    }
    processNotification(notification);
  });

  try {
    const response = await client.request<ThreadResumeResponse>(
      "thread/resume",
      { threadId },
    );
    pipeline.replay(response.thread.turns, bufferedNotifications);
    if (latestTurnIsTerminal(response.thread.turns)) resolveCompletion();
    replayingHistory = false;
    for (const notification of bufferedNotifications) {
      processNotification(notification);
    }
    await completion;
  } finally {
    removeHandler();
  }
}

class EventPipeline {
  readonly #threadId: string;
  readonly #writeLine: (line: string) => void;
  readonly #seenEventIds = new Set<string>();
  #nextSourceSequence = 1;

  constructor(threadId: string, writeLine: (line: string) => void) {
    this.#threadId = threadId;
    this.#writeLine = writeLine;
  }

  replay(
    turns: readonly HistoryTurn[],
    bufferedNotifications: JsonObject[],
  ): void {
    const candidates: ReplayCandidate[] = [];
    const consumedNotificationIndexes = new Set<number>();
    for (const turn of turns) {
      for (const item of turn.items) {
        const historyParams = {
          threadId: this.#threadId,
          turnId: turn.id,
          item,
        };
        const method = historyMethod(item);
        const overlapping = findItemNotifications(
          bufferedNotifications,
          this.#threadId,
          turn.id,
          item.id,
          method,
        );
        const predecessors =
          method === "item/completed"
            ? findItemNotifications(
                bufferedNotifications,
                this.#threadId,
                turn.id,
                item.id,
                "item/started",
              )
            : [];
        const predecessorPayload = mergeNotificationPayloads(
          predecessors.map(({ notification }) => notification),
        );
        if (predecessorPayload !== null) {
          candidates.push({
            method: "item/started",
            payload: predecessorPayload,
            bufferRank: minimumIndex(predecessors),
          });
        }
        const payload = overlapping.reduce<JsonObject>(
          (combined, { notification }) => {
            const params = asObject(notification.params);
            return params === null
              ? combined
              : mergeEventPayload(combined, params);
          },
          historyParams,
        );
        candidates.push({
          method,
          payload,
          bufferRank: minimumIndex(overlapping),
        });
        for (const { index } of overlapping.concat(predecessors)) {
          consumedNotificationIndexes.add(index);
        }
      }
    }

    const anchoredCandidates = candidates
      .filter((candidate) => candidate.bufferRank !== null)
      .sort(
        (left, right) =>
          (left.bufferRank ?? Number.MAX_SAFE_INTEGER) -
          (right.bufferRank ?? Number.MAX_SAFE_INTEGER),
      );
    let anchoredIndex = 0;
    const orderedCandidates = candidates.map((candidate) =>
      candidate.bufferRank === null
        ? candidate
        : (anchoredCandidates[anchoredIndex++] ?? candidate),
    );
    for (const candidate of orderedCandidates) {
      this.append(candidate.method, candidate.payload);
    }

    const remainingNotifications = bufferedNotifications.filter(
      (_notification, index) => !consumedNotificationIndexes.has(index),
    );
    bufferedNotifications.splice(
      0,
      bufferedNotifications.length,
      ...remainingNotifications,
    );
  }

  append(method: string, params: JsonObject): void {
    if (params.threadId !== this.#threadId) return;
    const kind = traceKind(method, params);
    if (kind === null) return;

    const item = asObject(params.item);
    const itemId = item?.id;
    const turnId = params.turnId;
    if (typeof itemId !== "string" || typeof turnId !== "string") return;
    const lifecycle = method === "item/started" ? "started" : "completed";
    const eventId = `${this.#threadId}/${turnId}/${itemId}/${lifecycle}`;
    if (this.#seenEventIds.has(eventId)) return;
    this.#seenEventIds.add(eventId);

    const event: TraceEvent = Object.freeze({
      id: eventId,
      sourceId: this.#threadId,
      sourceSequence: this.#nextSourceSequence++,
      causalParentId: `${this.#threadId}/${turnId}`,
      method,
      kind,
      payload: params,
    });
    this.#writeLine(renderEvent(event));
  }
}

function historyMethod(item: JsonObject): LifecycleMethod {
  return item.status === "inProgress" || item.type === "userMessage"
    ? "item/started"
    : "item/completed";
}

function findItemNotifications(
  notifications: readonly JsonObject[],
  threadId: string,
  turnId: string,
  itemId: unknown,
  method: LifecycleMethod,
): IndexedNotification[] {
  if (typeof itemId !== "string") return [];
  const matches: IndexedNotification[] = [];
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];
    const params = asObject(notification?.params);
    const item = asObject(params?.item);
    if (
      notification?.method === method &&
      params?.threadId === threadId &&
      params.turnId === turnId &&
      item?.id === itemId
    ) {
      if (notification !== undefined) matches.push({ index, notification });
    }
  }
  return matches;
}

function minimumIndex(
  notifications: readonly IndexedNotification[],
): number | null {
  if (notifications.length === 0) return null;
  return Math.min(...notifications.map(({ index }) => index));
}

function mergeNotificationPayloads(
  notifications: readonly JsonObject[],
): JsonObject | null {
  let combined: JsonObject | null = null;
  for (const notification of notifications) {
    const params = asObject(notification.params);
    if (params === null) continue;
    combined = combined === null ? params : mergeEventPayload(combined, params);
  }
  return combined;
}

function mergeEventPayload(
  earlierPayload: JsonObject,
  laterPayload: JsonObject,
): JsonObject {
  const earlierItem = asObject(earlierPayload.item) ?? {};
  const laterItem = asObject(laterPayload.item) ?? {};
  return {
    ...earlierPayload,
    ...laterPayload,
    item: { ...earlierItem, ...laterItem },
  };
}

function latestTurnIsTerminal(turns: readonly HistoryTurn[]): boolean {
  const status = turns.at(-1)?.status;
  return status === "completed" || status === "failed" || status === "interrupted";
}

function renderEvent(event: TraceEvent): string {
  return (
    `[${event.kind}] ${event.method} event=${event.id} ` +
    `source=${event.sourceId} sequence=${event.sourceSequence} ` +
    `parent=${event.causalParentId} ${JSON.stringify(event.payload)}`
  );
}

function traceKind(method: string, params: JsonObject): string | null {
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = asObject(params.item);
  const itemType = item?.type;
  if (itemType === "userMessage") return "user";
  if (itemType === "commandExecution") return "command";
  if (
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "collabAgentToolCall" ||
    itemType === "webSearch" ||
    itemType === "imageView" ||
    itemType === "imageGeneration"
  ) {
    return "tool";
  }
  return null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : null;
}
