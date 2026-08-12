import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import {
  TRACE_EXPLORER_HTML,
  TRACE_EXPLORER_SCRIPT,
  TRACE_EXPLORER_STYLE,
} from "./trace-explorer-assets.js";

import type {
  TraceExplorerBrowserAction,
  TraceExplorerSessionManager,
  TraceExplorerSnapshot,
} from "./trace-explorer-session.js";

const LOOPBACK_HOST = "127.0.0.1";

export type TraceExplorerBrowserMessage =
  | { readonly kind: "snapshot"; readonly snapshot: TraceExplorerSnapshot }
  | {
      readonly kind: "update";
      readonly revision: number;
      readonly snapshot: TraceExplorerSnapshot;
    };

export interface TraceExplorerServer {
  readonly browserUrl: string;
  close(): Promise<void>;
}

export async function startTraceExplorerServer(options: {
  readonly port?: number;
  readonly manager: TraceExplorerSessionManager;
}): Promise<TraceExplorerServer> {
  const sockets = new Set<WebSocket>();
  const httpServer = createHttpServer();
  const socketServer = new WebSocketServer({ noServer: true });

  await listen(httpServer, options.port ?? 4310);
  const address = httpServer.address() as AddressInfo;
  const browserUrl = `http://${LOOPBACK_HOST}:${address.port}`;

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/live" || request.headers.origin !== browserUrl) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      socketServer.emit("connection", browserSocket, request);
    });
  });

  socketServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const action = parseBrowserAction(data.toString());
      if (action !== null) options.manager.dispatch(action);
    });
    send(socket, {
      kind: "snapshot",
      snapshot: options.manager.snapshot(),
    });
  });

  const unsubscribe = options.manager.subscribe((snapshot) => {
    const message: TraceExplorerBrowserMessage = Object.freeze({
      kind: "update",
      revision: snapshot.revision,
      snapshot,
    });
    for (const socket of sockets) send(socket, message);
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    browserUrl,
    close(): Promise<void> {
      if (closePromise === undefined) {
        unsubscribe();
        closePromise = closeServers(httpServer, socketServer, sockets);
      }
      return closePromise;
    },
  });
}

function createHttpServer(): HttpServer {
  return createServer((request, response) => {
    const asset = localAsset(request.url);
    if (asset === null) {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, securityHeaders(asset.contentType));
    response.end(asset.body);
  });
}

function localAsset(
  url: string | undefined,
): { readonly contentType: string; readonly body: string } | null {
  if (url === "/" || url === "/index.html") {
    return { contentType: "text/html; charset=utf-8", body: TRACE_EXPLORER_HTML };
  }
  if (url === "/assets/app.js") {
    return {
      contentType: "text/javascript; charset=utf-8",
      body: TRACE_EXPLORER_SCRIPT,
    };
  }
  if (url === "/assets/app.css") {
    return { contentType: "text/css; charset=utf-8", body: TRACE_EXPLORER_STYLE };
  }
  return null;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

async function listen(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function send(socket: WebSocket, message: TraceExplorerBrowserMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function parseBrowserAction(source: string): TraceExplorerBrowserAction | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  if (value.kind === "trace-next-run" || value.kind === "re-layout") {
    return { kind: value.kind };
  }
  if (
    value.kind === "select-session" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  ) {
    return { kind: value.kind, sessionId: value.sessionId };
  }
  if (
    value.kind === "select-run" &&
    "runId" in value &&
    typeof value.runId === "string"
  ) {
    return { kind: value.kind, runId: value.runId };
  }
  return null;
}

async function closeServers(
  httpServer: HttpServer,
  socketServer: WebSocketServer,
  sockets: ReadonlySet<WebSocket>,
): Promise<void> {
  for (const socket of sockets) socket.terminate();
  await Promise.all([
    new Promise<void>((resolve) => socketServer.close(() => resolve())),
    new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  ]);
}
