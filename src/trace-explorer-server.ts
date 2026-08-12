import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import type { ObservationUpdate } from "./trace-observation.js";

const LOOPBACK_HOST = "127.0.0.1";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Trace Explorer</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <main>
      <h1>Trace Explorer</h1>
      <p id="connection">Connecting to the local Tracer…</p>
    </main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;

const SCRIPT = `const status = document.querySelector("#connection");
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(protocol + "//" + location.host + "/live");
socket.addEventListener("open", () => { status.textContent = "Connected to the local Tracer."; });
socket.addEventListener("close", () => { status.textContent = "Disconnected from the local Tracer."; });`;

const STYLE = `:root { color-scheme: light dark; font-family: ui-monospace, monospace; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { max-width: 38rem; padding: 2rem; }
h1 { margin-block: 0 0.75rem; }`;

export interface TraceExplorerSnapshot {
  readonly revision: number;
  readonly updates: readonly ObservationUpdate[];
}

export type TraceExplorerBrowserMessage =
  | { readonly kind: "snapshot"; readonly snapshot: TraceExplorerSnapshot }
  | {
      readonly kind: "update";
      readonly revision: number;
      readonly update: ObservationUpdate;
    };

export interface TraceExplorerServer {
  readonly browserUrl: string;
  publish(update: ObservationUpdate): void;
  close(): Promise<void>;
}

export async function startTraceExplorerServer(options: {
  readonly port?: number;
} = {}): Promise<TraceExplorerServer> {
  const updates: ObservationUpdate[] = [];
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
    send(socket, {
      kind: "snapshot",
      snapshot: freezeSnapshot(updates),
    });
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    browserUrl,
    publish(update: ObservationUpdate): void {
      updates.push(update);
      const message: TraceExplorerBrowserMessage = Object.freeze({
        kind: "update",
        revision: updates.length,
        update,
      });
      for (const socket of sockets) send(socket, message);
    },
    close(): Promise<void> {
      closePromise ??= closeServers(httpServer, socketServer, sockets);
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
    return { contentType: "text/html; charset=utf-8", body: HTML };
  }
  if (url === "/assets/app.js") {
    return { contentType: "text/javascript; charset=utf-8", body: SCRIPT };
  }
  if (url === "/assets/app.css") {
    return { contentType: "text/css; charset=utf-8", body: STYLE };
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

function freezeSnapshot(
  updates: readonly ObservationUpdate[],
): TraceExplorerSnapshot {
  return Object.freeze({
    revision: updates.length,
    updates: Object.freeze([...updates]),
  });
}

function send(socket: WebSocket, message: TraceExplorerBrowserMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
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
