import { AppServerClient } from "./app-server-client.js";

type JsonObject = Record<string, unknown>;

interface LoadedThreadsResponse {
  readonly data: readonly string[];
  readonly nextCursor: string | null;
}

const SENSITIVE_DATA_WARNING =
  "WARNING: THIS LIVE TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Prompts, credentials, paths, proprietary content, and personal data may be " +
  "exposed in terminal output; the Skill Contract and Trace are sent unredacted " +
  "to OpenAI by later Evaluation Runs.";

export async function traceOnlyLoadedThread(
  serverUrl: string,
  writeLine: (line: string) => void,
): Promise<void> {
  writeLine(SENSITIVE_DATA_WARNING);
  const client = await AppServerClient.connect(serverUrl);

  try {
    const threadIds = await listAllLoadedThreads(client);
    if (threadIds.length !== 1) {
      throw new Error(
        `Expected exactly one loaded thread; found ${threadIds.length}.`,
      );
    }

    const threadId = threadIds[0];
    if (threadId === undefined) throw new Error("The loaded thread had no id.");
    writeLine(`Automatically selected the only loaded thread: ${threadId}`);

    const completed = waitForTurnCompletion(client, threadId, writeLine);
    await client.request("thread/resume", { threadId });
    await completed;
    await client.request("thread/unsubscribe", { threadId });
  } finally {
    client.close();
  }
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

function waitForTurnCompletion(
  client: AppServerClient,
  threadId: string,
  writeLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const removeHandler = client.onNotification((notification) => {
      const params = asObject(notification.params);
      if (params?.threadId !== threadId) return;

      const method = notification.method;
      if (typeof method !== "string") return;
      const kind = traceKind(method, params);
      if (kind !== null) {
        writeLine(`[${kind}] ${method} ${JSON.stringify(params)}`);
      }

      if (method === "turn/completed") {
        removeHandler();
        resolve();
      }
    });
  });
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
