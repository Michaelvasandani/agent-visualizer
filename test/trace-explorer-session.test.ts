import assert from "node:assert/strict";
import test from "node:test";

import {
  createTraceExplorerSessionManager,
  type TraceExplorerSessionDependencies,
} from "../src/trace-explorer-session.js";
import type {
  ObserveSkillRunOptions,
  SkillRunObservation,
} from "../src/trace-observation.js";
import { completedObservation } from "./trace-explorer-fixtures.js";

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

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("requires an explicit browser choice for multiple sessions and exposes Armed State", async (t) => {
  let observedOptions: ObserveSkillRunOptions | undefined;
  const dependencies: TraceExplorerSessionDependencies = {
    observeSkillRun: async (options) => {
      observedOptions = options;
      options.onUpdate?.({ kind: "lifecycle", state: "connecting" });
      options.onUpdate?.({ kind: "lifecycle", state: "selecting-thread" });
      options.onUpdate?.({
        kind: "loaded-threads",
        threadIds: ["session-one", "session-two"],
      });
      const selected = await options.selectThread?.([
        "session-one",
        "session-two",
      ]);
      assert.equal(selected, "session-two");
      options.onUpdate?.({
        kind: "thread-selected",
        threadId: selected,
        automatic: false,
      });
      options.onUpdate?.({ kind: "lifecycle", state: "armed" });
      return await new Promise<SkillRunObservation>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
    },
  };
  const manager = createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies,
  });
  t.after(async () => manager.close());
  manager.start();
  await nextTask();

  assert.equal(observedOptions?.turnSelection, "active-or-next");
  assert.equal(manager.snapshot().phase, "selecting-session");
  assert.equal(manager.snapshot().selectedSessionId, null);
  assert.equal(
    manager.dispatch({ kind: "select-session", sessionId: "session-two" }),
    true,
  );
  await nextTask();

  assert.equal(manager.snapshot().phase, "armed");
  assert.equal(manager.snapshot().selectedSessionId, "session-two");
  assert.deepEqual(manager.snapshot().runs, []);
  assert.equal(manager.snapshot().sessionSwitchingLocked, false);
});

test("retains active and completed runs until explicit Trace Next Run", async (t) => {
  const first = deferred<SkillRunObservation>();
  let invocationCount = 0;
  let secondOptions: ObserveSkillRunOptions | undefined;
  const dependencies: TraceExplorerSessionDependencies = {
    observeSkillRun: async (options) => {
      invocationCount += 1;
      options.onUpdate?.({ kind: "lifecycle", state: "connecting" });
      options.onUpdate?.({
        kind: "loaded-threads",
        threadIds: ["only-session"],
      });
      options.onUpdate?.({
        kind: "thread-selected",
        threadId: "only-session",
        automatic: true,
      });
      if (invocationCount === 1) {
        options.onUpdate?.({ kind: "lifecycle", state: "observing" });
        options.onUpdate?.({
          kind: "evaluation-state",
          state: "compiling-obligations",
        });
        return await first.promise;
      }
      secondOptions = options;
      options.onUpdate?.({ kind: "lifecycle", state: "armed" });
      return await new Promise<SkillRunObservation>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
    },
  };
  const manager = createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies,
  });
  t.after(async () => manager.close());
  manager.start();
  await nextTask();

  let snapshot = manager.snapshot();
  assert.equal(snapshot.phase, "evaluating");
  assert.equal(snapshot.evaluationState, "compiling-obligations");
  assert.equal(snapshot.sessionSwitchingLocked, true);
  assert.equal(snapshot.activeRunId, "run-1");
  assert.deepEqual(snapshot.runs.map((run) => run.status), ["evaluating"]);
  assert.equal(
    manager.dispatch({ kind: "select-session", sessionId: "only-session" }),
    false,
  );

  first.resolve(completedObservation("only-session"));
  await nextTask();
  snapshot = manager.snapshot();
  assert.equal(snapshot.phase, "completed");
  assert.equal(snapshot.evaluationState, "skipped");
  assert.equal(snapshot.activeRunId, null);
  assert.equal(snapshot.viewedRunId, "run-1");
  assert.deepEqual(snapshot.runs.map((run) => run.status), ["completed"]);
  assert.equal(invocationCount, 1, "a new run must not be traced implicitly");

  assert.equal(manager.dispatch({ kind: "trace-next-run" }), true);
  await nextTask();
  assert.equal(invocationCount, 2);
  assert.equal(secondOptions?.turnSelection, "active-or-next");
  snapshot = manager.snapshot();
  assert.equal(snapshot.phase, "armed");
  assert.equal(snapshot.viewedRunId, null);
  assert.deepEqual(snapshot.runs.map((run) => run.id), ["run-1"]);
});

test("switches sessions while Armed by replacing only the process-owned subscription", async (t) => {
  const selectedSessions: string[] = [];
  let invocationCount = 0;
  const dependencies: TraceExplorerSessionDependencies = {
    observeSkillRun: async (options) => {
      invocationCount += 1;
      options.onUpdate?.({
        kind: "loaded-threads",
        threadIds: ["session-one", "session-two"],
      });
      const selected = await options.selectThread?.([
        "session-one",
        "session-two",
      ]);
      assert.ok(selected !== undefined);
      selectedSessions.push(selected);
      options.onUpdate?.({
        kind: "thread-selected",
        threadId: selected,
        automatic: false,
      });
      options.onUpdate?.({ kind: "lifecycle", state: "armed" });
      return await new Promise<SkillRunObservation>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
    },
  };
  const manager = createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies,
  });
  t.after(async () => manager.close());
  manager.start();
  await nextTask();
  manager.dispatch({ kind: "select-session", sessionId: "session-one" });
  await nextTask();
  assert.equal(manager.snapshot().phase, "armed");

  assert.equal(
    manager.dispatch({ kind: "select-session", sessionId: "session-two" }),
    true,
  );
  await nextTask();
  await nextTask();

  assert.equal(invocationCount, 2);
  assert.deepEqual(selectedSessions, ["session-one", "session-two"]);
  assert.equal(manager.snapshot().selectedSessionId, "session-two");
  assert.equal(manager.snapshot().phase, "armed");
});

test("preserves failed and cancelled terminal outcomes in the Run List status", async () => {
  const outcomes = [
    { kind: "failed", error: "fixture failure" } as const,
    { kind: "cancelled" } as const,
  ];
  for (const [index, outcome] of outcomes.entries()) {
    const manager = createTraceExplorerSessionManager({
      serverUrl: "ws://fixture.test",
      dependencies: {
        observeSkillRun: async (options) => {
          options.onUpdate?.({
            kind: "thread-selected",
            threadId: `session-${index}`,
            automatic: true,
          });
          options.onUpdate?.({ kind: "lifecycle", state: "observing" });
          return completedObservation(`session-${index}`, outcome);
        },
      },
    });
    manager.start();
    await nextTask();

    assert.equal(manager.snapshot().runs[0]?.status, outcome.kind);
    await manager.close();
  }
});

test("retains run updates that race active-turn attachment before observing is reported", async () => {
  const manager = createTraceExplorerSessionManager({
    serverUrl: "ws://fixture.test",
    dependencies: {
      observeSkillRun: async (options) => {
        options.onUpdate?.({
          kind: "thread-selected",
          threadId: "race-session",
          automatic: true,
        });
        options.onUpdate?.({
          kind: "root-skill-candidate",
          rootSkill: { name: "fixture", path: "/fixture/SKILL.md" },
        });
        options.onUpdate?.({ kind: "lifecycle", state: "observing" });
        return completedObservation("race-session");
      },
    },
  });
  manager.start();
  await nextTask();

  assert.equal(
    manager.snapshot().runs[0]?.updates.some(
      (update) => update.kind === "root-skill-candidate",
    ),
    true,
  );
  await manager.close();
});
