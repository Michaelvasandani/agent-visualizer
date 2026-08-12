import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { startTraceExplorerServer } from "../src/trace-explorer-server.js";
import type {
  ObservationUpdate,
} from "../src/trace-observation.js";

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
  const server = await startTraceExplorerServer({ port: 0 });
  t.after(async () => server.close());

  assert.match(server.browserUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const htmlResponse = await fetch(server.browserUrl);
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /src="\/assets\/app\.js"/);
  assert.match(html, /href="\/assets\/app\.css"/);
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

test("reconnects from a complete snapshot and receives structured incremental updates", async (t) => {
  const server = await startTraceExplorerServer({ port: 0 });
  t.after(async () => server.close());
  const connecting: ObservationUpdate = {
    kind: "lifecycle",
    state: "connecting",
  };
  const observing: ObservationUpdate = {
    kind: "lifecycle",
    state: "observing",
  };
  server.publish(connecting);

  const firstBrowser = await connectBrowser(server.browserUrl);
  assert.deepEqual(firstBrowser.firstMessage, {
    kind: "snapshot",
    snapshot: { revision: 1, updates: [connecting] },
  });

  const incrementalMessage = nextJsonMessage(firstBrowser.socket);
  server.publish(observing);
  assert.deepEqual(await incrementalMessage, {
    kind: "update",
    revision: 2,
    update: observing,
  });
  firstBrowser.socket.close();
  await new Promise<void>((resolve) => firstBrowser.socket.once("close", resolve));

  const completed: ObservationUpdate = {
    kind: "lifecycle",
    state: "completed",
  };
  server.publish(completed);
  const refreshedBrowser = await connectBrowser(server.browserUrl);
  t.after(() => refreshedBrowser.socket.close());
  assert.deepEqual(refreshedBrowser.firstMessage, {
    kind: "snapshot",
    snapshot: {
      revision: 3,
      updates: [connecting, observing, completed],
    },
  });
});
