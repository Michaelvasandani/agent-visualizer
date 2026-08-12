import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import type {
  TraceExplorerBrowserAction,
  TraceExplorerSessionManager,
  TraceExplorerSnapshot,
} from "./trace-explorer-session.js";

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
      <label for="sessions">Observable Session</label>
      <select id="sessions"></select>
      <p>State: <strong id="phase">Connecting</strong></p>
      <p>Conformance: <strong id="evaluation">not-started</strong></p>
      <button id="trace-next" type="button" hidden>Trace Next Run</button>
      <h2>Run List</h2>
      <ol id="runs"></ol>
    </main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;

const SCRIPT = `const status = document.querySelector("#connection");
const sessionSelect = document.querySelector("#sessions");
const phase = document.querySelector("#phase");
const evaluation = document.querySelector("#evaluation");
const traceNext = document.querySelector("#trace-next");
const runList = document.querySelector("#runs");
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
let socket;

function send(action) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(action));
}

function render(snapshot) {
  phase.textContent = snapshot.phase;
  evaluation.textContent = snapshot.evaluationState;
  sessionSelect.replaceChildren();
  if (snapshot.sessions.length !== 1 && snapshot.selectedSessionId === null) {
    const prompt = document.createElement("option");
    prompt.textContent = "Choose a session…";
    prompt.value = "";
    sessionSelect.append(prompt);
  }
  for (const sessionId of snapshot.sessions) {
    const option = document.createElement("option");
    option.value = sessionId;
    option.textContent = sessionId;
    option.selected = sessionId === snapshot.selectedSessionId;
    sessionSelect.append(option);
  }
  sessionSelect.disabled = snapshot.sessionSwitchingLocked;
  traceNext.hidden = snapshot.phase !== "completed";
  runList.replaceChildren();
  for (const run of snapshot.runs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = run.id + " · " + run.sessionId + " · " + run.status;
    button.ariaPressed = String(run.id === snapshot.viewedRunId);
    button.addEventListener("click", () => send({ kind: "select-run", runId: run.id }));
    item.append(button);
    runList.append(item);
  }
}

sessionSelect.addEventListener("change", () => {
  if (sessionSelect.value !== "") {
    send({ kind: "select-session", sessionId: sessionSelect.value });
  }
});
traceNext.addEventListener("click", () => send({ kind: "trace-next-run" }));

function connect() {
  socket = new WebSocket(protocol + "//" + location.host + "/live");
  socket.addEventListener("open", () => { status.textContent = "Connected to the local Tracer."; });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.kind === "snapshot" || message.kind === "update") render(message.snapshot);
  });
  socket.addEventListener("close", () => {
    status.textContent = "Disconnected from the local Tracer; reconnecting…";
    setTimeout(connect, 500);
  });
}
connect();`;

const STYLE = `:root { color-scheme: light dark; font-family: ui-monospace, monospace; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(42rem, calc(100% - 4rem)); padding: 2rem; }
h1 { margin-block: 0 0.75rem; }
select, button { font: inherit; }
#runs { padding-inline-start: 1.5rem; }
#runs button { margin-block: 0.25rem; }`;

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
  if (value.kind === "trace-next-run") return { kind: value.kind };
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
