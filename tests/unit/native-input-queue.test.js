import { codexInputTime } from "../../server/features/chat/native-input-time.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  nativeInputQueue,
  inputHash,
} from "../../server/features/chat/native-input-queue.js";
import { nativeDeliveryStates } from "../../web/features/chat/native-delivery-state.js";
import { markOpenCodeInput } from "../../server/features/chat/opencode-input-state.js";
const fixtures = JSON.parse(
  fs.readFileSync(new URL("../fixtures/native-input-queue.json", import.meta.url)),
);
for (const [tool, fixture] of Object.entries(fixtures)) {
  test(`${tool}: only current native queue chrome establishes a complete text observation`, () => {
    const { raw, pane } = fixture.snapshots.queued;
    assert.deepEqual(nativeInputQueue(tool, fixture.narrow.raw, fixture.narrow.pane), [
      inputHash("AP_PROBE_SECOND"),
    ]);
    assert.deepEqual(nativeInputQueue(tool, raw, pane), [inputHash("AP_PROBE_SECOND")]);
    for (const name of ["idle", "busy", "draft"]) {
      const frame = fixture.snapshots[name];
      assert.deepEqual(nativeInputQueue(tool, frame.raw, frame.pane), []);
    }
    assert.deepEqual(nativeInputQueue(tool, raw, { ...pane, cursorY: 0 }), []);
    assert.deepEqual(
      nativeInputQueue(tool, raw.replaceAll("AP_PROBE_SECOND", "AP_PROBE…"), pane),
      [],
    );
    assert.deepEqual(
      nativeInputQueue(tool, raw.replaceAll("AP_PROBE_SECOND", "[Pasted text #1]"), pane),
      [],
    );
  });
}
const item = {
  id: "a",
  text: "hello",
  baselineIds: [],
  status: "handed-off",
  observation: {
    generation: "launch",
    startedAt: 1000,
    providerSessionId: "thread",
    hash: inputHash("hello"),
    baseline: [],
  },
};
const message = { id: "native", role: "user", text: "hello", timestamp: 1001 };
const input = {
  generation: "launch",
  providerSessionId: "thread",
  queue: [item.observation.hash],
};
test("queued OpenCode message stays queued even though its history row already exists", () => {
  const states = nativeDeliveryStates([item], [message], input, "opencode");
  assert.deepEqual(states.get("a"), { state: "nativeQueued", messageId: "native" });
  assert.equal(
    nativeDeliveryStates([item], [message], { ...input, queue: [] }, "opencode").size,
    0,
  );
  assert.equal(
    nativeDeliveryStates(
      [item],
      [{ ...message, inputConsumed: true }],
      { ...input, queue: [] },
      "opencode",
    ).get("a").state,
    "nativeAccepted",
  );
});
test("queue disappearance, duplicate texts, composer-only text and replaced scopes cannot confirm acceptance", () => {
  const observe = (items, messages, current = input) =>
    nativeDeliveryStates(items, messages, current, "codex");
  assert.equal(observe([item], [], { ...input, queue: [] }).size, 0);
  assert.equal(observe([item, { ...item, id: "b" }], [message]).size, 0);
  assert.equal(observe([item], [], { ...input, generation: "new" }).size, 0);
  assert.equal(observe([item], [], { ...input, providerSessionId: "cleared" }).size, 0);
  assert.equal(
    observe([item], [], {
      ...input,
      queue: [item.observation.hash, item.observation.hash],
    }).size,
    0,
  );
  assert.equal(
    observe(
      [{ ...item, observation: { ...item.observation, baseline: input.queue } }],
      [message],
    ).size,
    0,
  );
  assert.equal(nativeDeliveryStates([item], [message], input, "codex", false).size, 0);
  assert.equal(observe([{ ...item, status: "uncertain" }], [message]).size, 0);
  assert.equal(
    observe([item], [{ ...message, text: " hello " }], { ...input, queue: [] }).size,
    0,
  );
  assert.equal(
    observe([{ ...item, baselineIds: [message.id] }], [message], { ...input, queue: [] })
      .size,
    0,
  );
  assert.equal(
    observe([item], [{ ...message, timestamp: 999 }], { ...input, queue: [] }).size,
    0,
  );
  assert.equal(
    observe([item], [message], { ...input, queue: [] }).get("a").state,
    "nativeAccepted",
  );
});
test("OpenCode consumes only messages with an explicit native assistant parent", () => {
  const rows = [
    { ...message, id: "part-1" },
    { ...message, id: "part-2" },
  ];
  const envelopes = [
    { info: { id: "u1", role: "user" }, parts: [{ id: "part-1" }] },
    { info: { id: "u2", role: "user" }, parts: [{ id: "part-2" }] },
    { info: { role: "assistant", parentID: "u1" }, parts: [] },
  ];
  const next = markOpenCodeInput(rows, envelopes);
  assert.equal(next[0].inputConsumed, true);
  assert.equal(next[1].inputConsumed, undefined);
  assert.equal(rows[0].inputConsumed, undefined);
});

test("Codex input timestamps come from native UUIDv7 IDs, never a history read clock", () => {
  assert.equal(codexInputTime("01a09544-bdbf-7201-929c-8d775a6d79c1"), 1789210705343);
  for (const id of [
    null,
    "user-1",
    "01a09544-bdbf-4201-929c-8d775a6d79c1",
    "01a09544-bdbf-7201-129c-8d775a6d79c1",
  ])
    assert.equal(codexInputTime(id), undefined);
});
