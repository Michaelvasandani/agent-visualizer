import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSavedTrace } from "../src/saved-trace.js";

function savedTraceFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolCompatibility: {
      codexCli: "0.145.0",
      codexAppServer: "0.145.0",
    },
    run: { threadId: "thread-one", cwd: "/private/workspace" },
    terminalOutcome: { kind: "completed" },
    traceIntegrity: { complete: true, gaps: [] },
    skillAttribution: {
      kind: "unresolved",
      reason: "fixture attribution unavailable",
    },
    skillContract: null,
    obligations: [],
    events: [
      {
        id: "thread-one/turn-one/item-one/completed",
        sourceId: "thread-one",
        sourceSequence: 1,
        causalParentId: "thread-one/turn-one",
        sourceParentId: null,
        sourceDepth: 0,
        method: "item/completed",
        kind: "unknown",
        timing: null,
        observationSources: ["live"],
        payload: {
          threadId: "thread-one",
          nested: { secret: "exact-secret-atlas" },
        },
      },
    ],
    findings: [],
  };
}

test("loads a Saved Trace as a deeply immutable Event snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "saved-trace-load-"));
  const savedTracePath = path.join(directory, "trace.json");
  await writeFile(savedTracePath, JSON.stringify(savedTraceFixture()));

  const savedTrace = await loadSavedTrace(savedTracePath);
  const event = savedTrace.events[0];

  assert.ok(event);
  assert.equal(Object.isFrozen(savedTrace), true);
  assert.equal(Object.isFrozen(savedTrace.events), true);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.nested), true);
  assert.throws(() => {
    (event.payload.nested as { secret: string }).secret = "rewritten";
  }, TypeError);
});

test("rejects a schema-version-1 bundle missing a required section", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "saved-trace-invalid-"));
  const savedTracePath = path.join(directory, "trace.json");
  const { events: _events, ...missingEvents } = savedTraceFixture();
  await writeFile(savedTracePath, JSON.stringify(missingEvents));

  await assert.rejects(
    loadSavedTrace(savedTracePath),
    /Saved Trace is missing required property events/i,
  );
});

test("rejects a schema-version-1 bundle with a malformed Event field", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "saved-trace-event-"));
  const savedTracePath = path.join(directory, "trace.json");
  const fixture = savedTraceFixture();
  const [event] = fixture.events as Record<string, unknown>[];
  assert.ok(event);
  event.sourceSequence = "first";
  await writeFile(savedTracePath, JSON.stringify(fixture));

  await assert.rejects(
    loadSavedTrace(savedTracePath),
    /events\[0\]\.sourceSequence must be an integer/i,
  );
});
