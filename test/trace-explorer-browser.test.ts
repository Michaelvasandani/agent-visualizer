import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

import {
  TRACE_EXPLORER_HTML,
  TRACE_EXPLORER_SCRIPT,
} from "../src/trace-explorer-assets.js";

class BrowserSocket extends EventTarget {
  static readonly OPEN = 1;
  static latest: BrowserSocket;
  readonly sent: string[] = [];
  readyState = BrowserSocket.OPEN;

  constructor(_url: string) {
    super();
    BrowserSocket.latest = this;
  }

  send(value: string): void {
    this.sent.push(value);
  }

  publish(snapshot: object): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ kind: "snapshot", snapshot }),
    }));
  }
}

test("executes SVG Activity Graph navigation and keeps camera pause browser-local", () => {
  const window = new Window({ url: "http://127.0.0.1:4310/" });
  window.document.write(TRACE_EXPLORER_HTML);
  Object.assign(window, { WebSocket: BrowserSocket });
  window.eval(TRACE_EXPLORER_SCRIPT);
  const socket = BrowserSocket.latest;
  socket.publish(activitySnapshot());

  const document = window.document;
  assert.equal(document.querySelectorAll(".source-lane").length, 2);
  assert.equal(document.querySelectorAll(".activity-node").length, 2);
  assert.equal(document.querySelectorAll(".integrity-gap").length, 1);

  const search: any = document.querySelector("#activity-search");
  search.value = "future";
  search.dispatchEvent(new window.Event("input"));
  assert.equal(document.querySelectorAll(".activity-node").length, 1);
  assert.match(document.querySelector(".activity-node")?.getAttribute("class") ?? "", /type-unknown/);
  search.value = "";
  search.dispatchEvent(new window.Event("input"));

  const spawn = document.querySelector('[data-node-id="root/turn/spawn"]')!;
  spawn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.match(document.querySelector("#selected-activity")?.textContent ?? "", /Spawn agent/);
  const collapse: any = document.querySelector("#collapse-branch");
  assert.equal(collapse.disabled, false);
  collapse.click();
  assert.equal(document.querySelectorAll(".source-lane").length, 1);
  assert.match(collapse.textContent, /Expand/);

  const filter: any = document.querySelector("#activity-filter");
  filter.value = "unknown";
  filter.dispatchEvent(new window.Event("change"));
  assert.equal(document.querySelectorAll(".activity-node").length, 0);
  collapse.click();
  assert.equal(document.querySelectorAll(".activity-node").length, 1);

  const viewport = document.querySelector("#activity-viewport")!;
  const initialTransform = viewport.getAttribute("transform");
  (document.querySelector("#zoom-in") as any).click();
  assert.notEqual(viewport.getAttribute("transform"), initialTransform);
  (document.querySelector("#reset-view") as any).click();
  assert.equal(viewport.getAttribute("transform"), "translate(36 36) scale(1)");

  const follow: any = document.querySelector("#camera-follow");
  const actionsBeforePause = socket.sent.length;
  follow.click();
  assert.equal(follow.ariaPressed, "true");
  assert.equal(follow.textContent, "Resume follow");
  assert.equal(socket.sent.length, actionsBeforePause, "viewport pause must not dispatch a collection action");

  (document.querySelector("#re-layout") as any).click();
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { kind: "re-layout" });
  window.close();
});

function activitySnapshot(): object {
  const spawn = {
    id: "root/turn/spawn",
    type: "agent",
    state: "completed",
    sourceId: "root",
    sourceSequence: 1,
    causalParentNodeId: null,
    eventIds: ["spawn-event"],
    summary: "Spawn agent",
    durationMs: 5,
    coverageWarning: null,
  };
  const unknown = {
    id: "child/turn/future",
    type: "unknown",
    state: "running",
    sourceId: "child",
    sourceSequence: 1,
    causalParentNodeId: "root/turn/spawn",
    eventIds: ["future-event"],
    summary: "Unknown activity: futureActivity",
    durationMs: null,
    coverageWarning: "Unsupported Event semantics: futureActivity",
  };
  const activityGraph = {
    rootSourceId: "root",
    ordering: "per-source-only",
    eventsById: {
      "spawn-event": { id: "spawn-event", sourceId: "root", sourceSequence: 1 },
      "future-event": { id: "future-event", sourceId: "child", sourceSequence: 1 },
    },
    eventsBySource: { root: [], child: [] },
    nodesById: { [spawn.id]: spawn, [unknown.id]: unknown },
    lanesBySource: {
      root: { sourceId: "root", sourceDepth: 0, sourceParentActivityNodeId: null, nodeIds: [spawn.id] },
      child: { sourceId: "child", sourceDepth: 1, sourceParentActivityNodeId: spawn.id, nodeIds: [unknown.id] },
    },
    causalEdgesById: {
      edge: { fromActivityNodeId: spawn.id, toActivityNodeId: unknown.id, relationship: "spawn" },
    },
    secondary: { reasoningEventIdsBySource: {}, resourceEventIdsBySource: {} },
    tokens: { skillRun: { sourceId: "root", availability: "not-reported", values: null }, bySource: {} },
    gaps: [{ afterEventId: "future-event", historyBoundary: "failed history recovery", sources: ["child"], reason: "history unavailable" }],
    integrity: "incomplete",
    terminalOutcome: null,
  };
  return {
    revision: 1,
    phase: "observing",
    sessions: ["root"],
    selectedSessionId: "root",
    sessionSwitchingLocked: true,
    activeRunId: "run-1",
    viewedRunId: "run-1",
    evaluationState: "not-started",
    error: null,
    runs: [{
      id: "run-1",
      sessionId: "root",
      status: "observing",
      updates: [{ kind: "event", event: { id: "future-event" } }],
      observation: null,
      activityGraph,
      activityLayout: {
        laneYBySource: { root: 96, child: 264 },
        positionsByNodeId: {
          [spawn.id]: { x: 164, y: 96 },
          [unknown.id]: { x: 396, y: 264 },
        },
        width: 900,
        height: 444,
      },
      details: {
        integrity: "incomplete",
        tokens: activityGraph.tokens,
        conformance: { attribution: null, contract: null, obligations: [], findings: [] },
      },
    }],
  };
}
