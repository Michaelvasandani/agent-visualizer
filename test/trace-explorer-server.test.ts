import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { startTraceExplorerServer } from "../src/trace-explorer-server.js";
import { createTraceExplorerSessionManager } from "../src/trace-explorer-session.js";
import type { SkillRunObservation } from "../src/trace-observation.js";
import { completedObservation } from "./trace-explorer-fixtures.js";

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function connectBrowser(
  browserUrl: string,
): Promise<{ readonly socket: WebSocket; readonly firstMessage: Record<string, unknown> }> {
  const socket = new WebSocket(browserUrl.replace("http:", "ws:") + "/live", {
    origin: browserUrl,
  });
  const firstMessagePromise = nextJsonMessage(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, firstMessage: await firstMessagePromise };
}

test("serves a fully local shell on loopback and accepts only same-origin browser sockets", async (t) => {
  const manager = createArmedManager();
  const server = await startTraceExplorerServer({ port: 0, manager });
  manager.start();
  t.after(async () => server.close());
  t.after(async () => manager.close());

  assert.match(server.browserUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const htmlResponse = await fetch(server.browserUrl);
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /src="\/assets\/app\.js"/);
  assert.match(html, /href="\/assets\/app\.css"/);
  assert.match(html, /Conformance:/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);

  const [scriptResponse, styleResponse] = await Promise.all([
    fetch(`${server.browserUrl}/assets/app.js`),
    fetch(`${server.browserUrl}/assets/app.css`),
  ]);
  assert.equal(scriptResponse.status, 200);
  assert.equal(styleResponse.status, 200);

  const browserSocketUrl = server.browserUrl.replace("http:", "ws:") + "/live";
  const accepted = new WebSocket(browserSocketUrl, {
    origin: server.browserUrl,
  });
  await new Promise<void>((resolve, reject) => {
    accepted.once("open", resolve);
    accepted.once("error", reject);
  });
  accepted.close();

  const rejected = new WebSocket(browserSocketUrl, {
    origin: "http://example.test",
  });
  const rejection = await new Promise<Error>((resolve) => {
    rejected.once("error", resolve);
  });
  assert.match(rejection.message, /403/);
});

test("reconnects from the complete process-owned Run List and accepts browser actions", async (t) => {
  let resolveObservation: (observation: SkillRunObservation) => void = () => undefined;
  const observation = new Promise<SkillRunObservation>((resolve) => {
    resolveObservation = resolve;
  });
  let invocationCount = 0;
  const manager = createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies: {
      observeSkillRun: async (options) => {
        invocationCount += 1;
        options.onUpdate?.({ kind: "lifecycle", state: "selecting-thread" });
        options.onUpdate?.({
          kind: "loaded-threads",
          threadIds: ["session-one", "session-two"],
        });
        const selected = await options.selectThread?.([
          "session-one",
          "session-two",
        ]);
        assert.ok(selected !== undefined);
        options.onUpdate?.({
          kind: "thread-selected",
          threadId: selected,
          automatic: false,
        });
        if (invocationCount === 1) {
          options.onUpdate?.({ kind: "lifecycle", state: "observing" });
          return await observation;
        }
        options.onUpdate?.({ kind: "lifecycle", state: "armed" });
        return await new Promise<SkillRunObservation>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        });
      },
    },
  });
  const server = await startTraceExplorerServer({ port: 0, manager });
  manager.start();
  t.after(async () => server.close());
  t.after(async () => manager.close());
  await new Promise((resolve) => setImmediate(resolve));

  const firstBrowser = await connectBrowser(server.browserUrl);
  assert.equal(firstBrowser.firstMessage.kind, "snapshot");
  assert.equal(
    (firstBrowser.firstMessage.snapshot as Record<string, unknown>).phase,
    "selecting-session",
  );

  const incrementalMessage = nextJsonMessage(firstBrowser.socket);
  firstBrowser.socket.send(JSON.stringify({
    kind: "select-session",
    sessionId: "session-two",
  }));
  const incremental = await incrementalMessage;
  assert.equal(incremental.kind, "update");
  firstBrowser.socket.close();
  await new Promise<void>((resolve) => firstBrowser.socket.once("close", resolve));

  resolveObservation(completedObservation("session-two"));
  await new Promise((resolve) => setImmediate(resolve));
  const refreshedBrowser = await connectBrowser(server.browserUrl);
  t.after(() => refreshedBrowser.socket.close());
  assert.equal(refreshedBrowser.firstMessage.kind, "snapshot");
  const snapshot = refreshedBrowser.firstMessage.snapshot as {
    readonly phase: string;
    readonly selectedSessionId: string;
    readonly runs: readonly { readonly id: string; readonly status: string }[];
  };
  assert.equal(snapshot.phase, "completed");
  assert.equal(snapshot.selectedSessionId, "session-two");
  assert.deepEqual(
    snapshot.runs.map(({ id, status }) => ({ id, status })),
    [{ id: "run-1", status: "completed" }],
  );

  refreshedBrowser.socket.send(JSON.stringify({ kind: "trace-next-run" }));
  for (let attempt = 0; attempt < 20 && invocationCount !== 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(invocationCount, 2);
});

function createArmedManager() {
  return createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies: {
      observeSkillRun: async (options) => {
        options.onUpdate?.({
          kind: "loaded-threads",
          threadIds: ["only-session"],
        });
        options.onUpdate?.({
          kind: "thread-selected",
          threadId: "only-session",
          automatic: true,
        });
        options.onUpdate?.({ kind: "lifecycle", state: "armed" });
        return await new Promise<SkillRunObservation>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        });
      },
    },
  });
}
