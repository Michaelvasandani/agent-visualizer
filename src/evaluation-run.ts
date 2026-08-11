import { AppServerClient } from "./app-server-client.js";
import type { JsonObject } from "./trace-event.js";

interface ThreadStartResponse {
  readonly thread: { readonly id: string };
}

interface TurnStartResponse {
  readonly turn: { readonly id: string; readonly status?: string };
}

export async function runStructuredEvaluation(
  client: AppServerClient,
  input: {
    readonly cwd: string;
    readonly baseInstructions: string;
    readonly prompt: string;
    readonly outputSchema: JsonObject;
    readonly label: string;
  },
): Promise<string> {
  const bufferedNotifications: JsonObject[] = [];
  let evaluationThreadId: string | null = null;
  let evaluationTurnId: string | null = null;
  let agentMessage: string | null = null;
  let terminalError: Error | null = null;
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const processNotification = (notification: JsonObject): void => {
    if (evaluationThreadId === null) {
      bufferedNotifications.push(notification);
      return;
    }
    const params = asObject(notification.params);
    if (params?.threadId !== evaluationThreadId) return;
    if (
      notification.method === "item/completed" &&
      (evaluationTurnId === null || params.turnId === evaluationTurnId)
    ) {
      const item = asObject(params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        agentMessage = item.text;
      }
    }
    if (notification.method !== "turn/completed") return;
    const turn = asObject(params.turn);
    if (evaluationTurnId !== null && turn?.id !== evaluationTurnId) return;
    if (turn?.status !== "completed") {
      const errorDetail = turn?.error === undefined
        ? ""
        : `: ${JSON.stringify(turn.error)}`;
      terminalError = new Error(
        `${input.label} ended with status ${JSON.stringify(turn?.status)}${errorDetail}.`,
      );
    }
    resolveCompletion();
  };

  const removeHandler = client.onNotification(processNotification);
  try {
    const threadResponse = await client.request<ThreadStartResponse>(
      "thread/start",
      {
        modelProvider: "openai",
        cwd: input.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        baseInstructions: input.baseInstructions,
      },
    );
    evaluationThreadId = threadResponse.thread.id;
    for (const notification of bufferedNotifications.splice(0)) {
      processNotification(notification);
    }

    try {
      const turnResponse = await client.request<TurnStartResponse>("turn/start", {
        threadId: evaluationThreadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: [],
          },
        ],
        outputSchema: input.outputSchema,
      });
      evaluationTurnId = turnResponse.turn.id;
      if (turnResponse.turn.status === "completed") resolveCompletion();
      await completion;
      if (terminalError !== null) throw terminalError;
      if (agentMessage === null) {
        throw new Error(
          `${input.label} completed without a structured agent message.`,
        );
      }
      return agentMessage;
    } finally {
      await client.request("thread/unsubscribe", {
        threadId: evaluationThreadId,
      });
    }
  } finally {
    removeHandler();
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
