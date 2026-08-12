import WebSocket, { type RawData } from "ws";

import { SUPPORTED_CODEX_VERSION } from "./codex-version.js";

type JsonObject = Record<string, unknown>;
type NotificationHandler = (message: JsonObject) => void;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AppServerClient {
  readonly #socket: WebSocket;
  readonly #pendingRequests = new Map<number, PendingRequest>();
  readonly #notificationHandlers = new Set<NotificationHandler>();
  readonly #closed: Promise<Error>;
  #nextRequestId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) => {
      socket.once("close", (code, reason) => {
        const detail = reason.length === 0 ? "" : `: ${reason.toString()}`;
        resolve(new Error(`The App Server connection closed (${code})${detail}.`));
      });
    });
    socket.on("message", (data) => this.#handleMessage(data));
    socket.on("error", (error) => this.#rejectPending(error));
    socket.on("close", () =>
      this.#rejectPending(new Error("The App Server connection closed.")),
    );
  }

  static async connect(
    url: string,
    signal?: AbortSignal,
  ): Promise<AppServerClient> {
    signal?.throwIfAborted();
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        cleanup();
        socket.once("error", () => undefined);
        socket.terminate();
        reject(signal?.reason);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    const client = new AppServerClient(socket);
    const abortInitialization = (): void => socket.terminate();
    signal?.addEventListener("abort", abortInitialization, { once: true });
    try {
      const response = await client.request<{ readonly userAgent: string }>(
        "initialize",
        {
          clientInfo: {
            name: "agent-tracer",
            title: "Agent Tracer",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      );
      requireSupportedServerVersion(response.userAgent);
      client.notify("initialized");
      return client;
    } catch (error) {
      client.close();
      if (signal?.aborted === true) throw signal.reason;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortInitialization);
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  async request<T>(method: string, params: JsonObject): Promise<T> {
    const id = this.#nextRequestId++;
    const response = new Promise<T>((resolve, reject) => {
      this.#pendingRequests.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });
    });
    this.#socket.send(JSON.stringify({ method, id, params }));
    return await response;
  }

  notify(method: string): void {
    this.#socket.send(JSON.stringify({ method }));
  }

  close(): void {
    this.#socket.close();
  }

  whenClosed(): Promise<Error> {
    return this.#closed;
  }

  #handleMessage(data: RawData): void {
    let message: JsonObject;
    try {
      message = JSON.parse(data.toString()) as JsonObject;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !("method" in message)) {
      const pending = this.#pendingRequests.get(message.id);
      if (pending === undefined) return;
      this.#pendingRequests.delete(message.id);
      if ("error" in message) {
        pending.reject(
          new Error(`App Server request failed: ${JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && !("id" in message)) {
      for (const handler of this.#notificationHandlers) handler(message);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pendingRequests.values()) pending.reject(error);
    this.#pendingRequests.clear();
  }
}

function requireSupportedServerVersion(userAgent: string): void {
  const version = /^[^/]+\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent)?.[1];
  if (version !== SUPPORTED_CODEX_VERSION) {
    throw new Error(
      `Agent Tracer requires exactly Codex App Server ${SUPPORTED_CODEX_VERSION}; server reported ${JSON.stringify(userAgent)}.`,
    );
  }
}
