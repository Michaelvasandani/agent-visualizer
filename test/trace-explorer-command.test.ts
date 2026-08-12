import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  launchTraceExplorer,
  startOwnedCodexAppServer,
  type OwnedAppServer,
  type TraceExplorerDependencies,
} from "../src/trace-explorer-command.js";
import type {
  ObserveSkillRunOptions,
  SkillRunObservation,
} from "../src/trace-observation.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function completedObservation(): SkillRunObservation {
  return {
    threadId: "thread-one",
    cwd: null,
    lifecycleState: "completed",
    evaluationState: "skipped",
    evaluationError: null,
    events: [],
    gaps: [],
    terminalOutcome: { kind: "completed" },
    skillAttribution: { kind: "unresolved", reason: "fixture" },
    skillContract: null,
    obligations: [],
    findings: [],
  };
}

function fakeOwner(stopSignals: NodeJS.Signals[]): OwnedAppServer {
  return {
    stop: async (signal) => {
      stopSignals.push(signal);
    },
  };
}

test("starts and owns a real foreground codex app-server child", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) =>
    probe.listen(0, "127.0.0.1", resolve),
  );
  const address = probe.address();
  assert.ok(typeof address === "object" && address !== null);
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );

  const binDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-tracer-owned-server-"),
  );
  const executable = path.join(binDirectory, "codex");
  await writeFile(
    executable,
    `#!/bin/sh
exec "${process.execPath}" -e 'const net = require("node:net"); const url = new URL(process.argv[1]); net.createServer().listen(Number(url.port), url.hostname);' "$3"
`,
  );
  await chmod(executable, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
  const serverUrl = `ws://127.0.0.1:${port}`;
  try {
    const owner = await startOwnedCodexAppServer(serverUrl);
    await owner.stop("SIGTERM");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("refuses to claim ownership of an occupied App Server endpoint", async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => listener.close(() => resolve())),
  );
  const address = listener.address();
  assert.ok(typeof address === "object" && address !== null);
  const url = `ws://127.0.0.1:${address.port}`;

  await assert.rejects(
    startOwnedCodexAppServer(url),
    new RegExp(`already in use.*--server ${url}`, "i"),
  );
});

test("owns the default shared App Server, prints launch commands, and opens the browser", async () => {
  const lines: string[] = [];
  const opened: string[] = [];
  const startedUrls: string[] = [];
  const observedUrls: string[] = [];
  const stopSignals: NodeJS.Signals[] = [];
  const dependencies: TraceExplorerDependencies = {
    startOwnedAppServer: async (url) => {
      startedUrls.push(url);
      return fakeOwner(stopSignals);
    },
    observeSkillRun: async (options) => {
      observedUrls.push(options.serverUrl);
      return completedObservation();
    },
    openBrowser: async (url) => {
      opened.push(url);
    },
  };

  const runtime = await launchTraceExplorer(
    { browserPort: 0, writeLine: (line) => lines.push(line) },
    dependencies,
  );

  assert.deepEqual(startedUrls, ["ws://127.0.0.1:4500"]);
  assert.deepEqual(observedUrls, ["ws://127.0.0.1:4500"]);
  assert.deepEqual(opened, [runtime.browserUrl]);
  assert.ok(lines.includes(`Trace Explorer: ${runtime.browserUrl}`));
  assert.ok(lines.includes("Connect the interactive Codex TUI with:"));
  assert.ok(lines.includes("codex --remote ws://127.0.0.1:4500"));

  await new Promise((resolve) => setImmediate(resolve));
  runtime.interrupt();
  assert.equal(await runtime.whenExited(), 0);
  assert.deepEqual(stopSignals, ["SIGTERM"]);
});

test("uses --server without ownership and honors --no-open", async () => {
  const externalUrl = "ws://127.0.0.1:5123";
  let ownershipStarts = 0;
  let browserOpens = 0;
  let observedOptions: ObserveSkillRunOptions | undefined;
  const runtime = await launchTraceExplorer(
    {
      serverUrl: externalUrl,
      noOpen: true,
      browserPort: 0,
      writeLine: () => undefined,
    },
    {
      startOwnedAppServer: async () => {
        ownershipStarts += 1;
        return fakeOwner([]);
      },
      observeSkillRun: async (options) => {
        observedOptions = options;
        return completedObservation();
      },
      openBrowser: async () => {
        browserOpens += 1;
      },
    },
  );

  assert.equal(ownershipStarts, 0);
  assert.equal(browserOpens, 0);
  assert.equal(observedOptions?.serverUrl, externalUrl);
  await new Promise((resolve) => setImmediate(resolve));
  runtime.interrupt();
  assert.equal(await runtime.whenExited(), 0);
});

test("defers an active interrupt until observation and Conformance settle", async () => {
  const observation = deferred<SkillRunObservation>();
  const stopSignals: NodeJS.Signals[] = [];
  const lines: string[] = [];
  let shouldStartConformance: (() => boolean) | undefined;
  const runtime = await launchTraceExplorer(
    { browserPort: 0, noOpen: true, writeLine: (line) => lines.push(line) },
    {
      startOwnedAppServer: async () => fakeOwner(stopSignals),
      observeSkillRun: async (options) => {
        shouldStartConformance = options.shouldStartConformance;
        return observation.promise;
      },
      openBrowser: async () => undefined,
    },
  );

  runtime.interrupt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopSignals, []);
  assert.match(lines.at(-1) ?? "", /shutdown requested.*settle/i);
  assert.equal(shouldStartConformance?.(), false);

  observation.resolve(completedObservation());
  assert.equal(await runtime.whenExited(), 0);
  assert.deepEqual(stopSignals, ["SIGTERM"]);
});

test("a second interrupt forces Tracer shutdown without stopping an external App Server", async () => {
  let aborted = false;
  const observation = deferred<SkillRunObservation>();
  const lines: string[] = [];
  const runtime = await launchTraceExplorer(
    {
      serverUrl: "ws://127.0.0.1:5123",
      browserPort: 0,
      noOpen: true,
      writeLine: (line) => lines.push(line),
    },
    {
      startOwnedAppServer: async () => {
        throw new Error("must not own the external server");
      },
      observeSkillRun: async (options) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          observation.resolve(completedObservation());
        });
        return observation.promise;
      },
      openBrowser: async () => undefined,
    },
  );

  runtime.interrupt();
  runtime.interrupt();

  assert.equal(await runtime.whenExited(), 130);
  assert.equal(aborted, true);
  assert.match(lines.at(-1) ?? "", /forcing.*interrupt Codex/i);
});

test("a second interrupt forcibly terminates an owned App Server", async () => {
  const observation = deferred<SkillRunObservation>();
  const stopSignals: NodeJS.Signals[] = [];
  const runtime = await launchTraceExplorer(
    { browserPort: 0, noOpen: true, writeLine: () => undefined },
    {
      startOwnedAppServer: async () => fakeOwner(stopSignals),
      observeSkillRun: async (options) => {
        options.signal?.addEventListener("abort", () => {
          observation.resolve(completedObservation());
        });
        return observation.promise;
      },
      openBrowser: async () => undefined,
    },
  );

  runtime.interrupt();
  runtime.interrupt();

  assert.equal(await runtime.whenExited(), 130);
  assert.deepEqual(stopSignals, ["SIGKILL"]);
});
