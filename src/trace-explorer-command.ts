import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

import {
  observeSkillRun,
  type ObserveSkillRunOptions,
  type SkillRunObservation,
} from "./trace-observation.js";
import {
  startTraceExplorerServer,
  type TraceExplorerServer,
} from "./trace-explorer-server.js";

const DEFAULT_APP_SERVER_URL = "ws://127.0.0.1:4500";

export interface OwnedAppServer {
  stop(signal: NodeJS.Signals): Promise<void>;
}

export interface TraceExplorerDependencies {
  readonly startOwnedAppServer: (url: string) => Promise<OwnedAppServer>;
  readonly observeSkillRun: (
    options: ObserveSkillRunOptions,
  ) => Promise<SkillRunObservation>;
  readonly openBrowser: (url: string) => Promise<void>;
}

export interface TraceExplorerRuntime {
  readonly browserUrl: string;
  interrupt(): void;
  whenExited(): Promise<number>;
}

export interface LaunchTraceExplorerOptions {
  readonly serverUrl?: string;
  readonly browserPort?: number;
  readonly noOpen?: boolean;
  readonly writeLine: (line: string) => void;
}

const DEFAULT_DEPENDENCIES: TraceExplorerDependencies = {
  startOwnedAppServer: startOwnedCodexAppServer,
  observeSkillRun,
  openBrowser: openSystemBrowser,
};

export async function launchTraceExplorer(
  options: LaunchTraceExplorerOptions,
  dependencies: TraceExplorerDependencies = DEFAULT_DEPENDENCIES,
): Promise<TraceExplorerRuntime> {
  const appServerUrl = options.serverUrl ?? DEFAULT_APP_SERVER_URL;
  const ownsAppServer = options.serverUrl === undefined;
  const owner = ownsAppServer
    ? await dependencies.startOwnedAppServer(appServerUrl)
    : null;
  let server: TraceExplorerServer;
  try {
    server = await startTraceExplorerServer({
      ...(options.browserPort === undefined
        ? {}
        : { port: options.browserPort }),
    });
  } catch (error) {
    await owner?.stop("SIGTERM");
    throw error;
  }

  options.writeLine(`Trace Explorer: ${server.browserUrl}`);
  options.writeLine("Connect the interactive Codex TUI with:");
  options.writeLine(`codex --remote ${appServerUrl}`);

  const abortController = new AbortController();
  let observationSettled = false;
  let shutdownRequested = false;
  let closing = false;
  let resolveExit: (exitCode: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const close = async (
    exitCode: number,
    ownerSignal: NodeJS.Signals,
  ): Promise<void> => {
    if (closing) return;
    closing = true;
    abortController.abort(new Error("Trace Explorer stopped."));
    await server.close();
    await owner?.stop(ownerSignal);
    resolveExit(exitCode);
  };

  const observation = dependencies.observeSkillRun({
    serverUrl: appServerUrl,
    signal: abortController.signal,
    shouldStartConformance: () => !shutdownRequested,
    onUpdate: (update) => server.publish(update),
  });
  void observation.then(
    () => {
      observationSettled = true;
      if (shutdownRequested) void close(0, "SIGTERM");
    },
    (error: unknown) => {
      observationSettled = true;
      if (closing) return;
      const message = error instanceof Error ? error.message : String(error);
      options.writeLine(`Trace Explorer collection failed: ${message}`);
      void close(1, "SIGTERM");
    },
  );

  if (options.noOpen !== true) {
    try {
      await dependencies.openBrowser(server.browserUrl);
    } catch (error) {
      await close(1, "SIGTERM");
      throw error;
    }
  }

  return Object.freeze({
    browserUrl: server.browserUrl,
    interrupt(): void {
      if (closing) return;
      if (observationSettled) {
        void close(0, "SIGTERM");
        return;
      }
      if (!shutdownRequested) {
        shutdownRequested = true;
        options.writeLine(
          "Shutdown requested; waiting until observation and started Conformance work settle. Press Ctrl-C again to force shutdown.",
        );
        return;
      }
      options.writeLine(
        "Forcing shutdown; this can interrupt Codex when the App Server is owned by this command.",
      );
      void close(130, "SIGKILL");
    },
    whenExited(): Promise<number> {
      return exited;
    },
  });
}

export async function startOwnedCodexAppServer(
  url: string,
): Promise<OwnedAppServer> {
  const endpoint = appServerEndpoint(url);
  if (await probe(endpoint.host, endpoint.port)) {
    throw new Error(
      `Cannot start the owned Codex App Server because ${url} is already in use. Use --server ${url} to attach without ownership.`,
    );
  }
  const child = spawn("codex", ["app-server", "--listen", url], {
    stdio: "inherit",
  });
  const exited = childExit(child);
  try {
    await waitUntilListening(url, exited);
  } catch (error) {
    child.kill("SIGTERM");
    await exited.catch(() => undefined);
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    stop(signal: NodeJS.Signals): Promise<void> {
      stopPromise ??= stopChild(child, exited, signal);
      return stopPromise;
    },
  });
}

async function openSystemBrowser(url: string): Promise<void> {
  const child = spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function childExit(child: ChildProcess): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function stopChild(
  child: ChildProcess,
  exited: Promise<number>,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  await exited;
}

async function waitUntilListening(
  serverUrl: string,
  exited: Promise<number>,
): Promise<void> {
  const { host, port } = appServerEndpoint(serverUrl);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      probe(host, port),
      exited.then((exitCode) => {
        throw new Error(
          `The owned Codex App Server exited before becoming ready (${exitCode}).`,
        );
      }),
    ]);
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for the Codex App Server at ${serverUrl}.`);
}

function appServerEndpoint(serverUrl: string): {
  readonly host: string;
  readonly port: number;
} {
  const url = new URL(serverUrl);
  const port = Number(url.port);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || port === 0) {
    throw new Error(`Invalid Codex App Server URL ${JSON.stringify(serverUrl)}.`);
  }
  return { host: url.hostname, port };
}

async function probe(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
