import assert from "node:assert/strict";
import test from "node:test";

import { createNormalizedEvent } from "../src/trace-event.js";

test("a normalized Event is a deeply immutable snapshot of source data", () => {
  const sourcePayload = {
    threadId: "thread-one",
    item: {
      type: "fileChange",
      changes: [
        {
          path: "src/private.ts",
          diff: "@@ -1 +1 @@\n-secret\n+preserved",
        },
      ],
    },
  };
  const event = createNormalizedEvent({
    id: "thread-one/turn-one/change-one/completed",
    sourceId: "thread-one",
    sourceSequence: 1,
    causalParentId: "thread-one/turn-one",
    sourceParentId: null,
    sourceDepth: 0,
    method: "item/completed",
    kind: "file-change",
    timing: { completedAtMs: 120, durationMs: 20 },
    observationSources: ["live"],
    payload: sourcePayload,
  });

  sourcePayload.item.changes[0]!.diff = "mutated after capture";

  assert.equal(
    (
      (event.payload.item as { readonly changes: readonly { readonly diff: string }[] })
        .changes[0]
    )?.diff,
    "@@ -1 +1 @@\n-secret\n+preserved",
  );
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.timing), true);
  assert.equal(Object.isFrozen(event.observationSources), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.item), true);
  assert.equal(
    Object.isFrozen(
      (event.payload.item as { readonly changes: readonly unknown[] }).changes,
    ),
    true,
  );
  assert.throws(() => {
    (event.payload.item as { type: string }).type = "rewritten";
  }, TypeError);
});
