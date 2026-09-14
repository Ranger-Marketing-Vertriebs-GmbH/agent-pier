import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatDraft,
  deliveryScope,
  deliveryNotices,
} from "../../web/features/chat/chat-draft.js";

const session = { id: "one", accountId: "account", tool: "codex", createdAt: "today" };
const context = {
  tool: "codex",
  providerSessionId: "native-before",
  restartGeneration: 0,
};
function fixture() {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  let tail = Promise.resolve();
  const lock = (_name, operation) => (tail = tail.then(operation));
  const reload = (scope = deliveryScope(session)) => new ChatDraft(storage, scope, lock);
  return { draft: reload(), reload };
}
async function enqueue(draft, text = "/clear", supplied = context, id = "clear-one") {
  await draft.change({ text });
  return draft.enqueue(
    id,
    [{ id: "old", role: "assistant", text: "Old answer" }],
    supplied,
  );
}
const snapshot = (id, extra = {}) => ({
  clientObservedAt: Date.now() + 1,
  availability: "ready",
  providerSessionId: id,
  messages: [],
  ...extra,
});

test("clear requests begin only after handoff and survive reload and delivery notice dismissal", async () => {
  const { draft, reload } = fixture();
  await enqueue(draft);
  assert.equal(draft.getSnapshot().reset, null);
  await draft.receipt({ deliveryId: "clear-one", status: "uncertain" });
  assert.equal(draft.getSnapshot().reset, null);
  const restored = reload();
  await restored.receipt({ deliveryId: "clear-one", status: "handed-off" });
  const { requestedAt, baseline, ...reset } = reload().getSnapshot().reset;
  assert.ok(Number.isFinite(requestedAt));
  assert.equal(baseline[0][0], "old");
  assert.deepEqual(reset, {
    deliveryId: "clear-one",
    sequence: 1,
    providerSessionId: "native-before",
    restartGeneration: 0,
    status: "requested",
  });
  assert.deepEqual(deliveryNotices(restored.getSnapshot(), []), []);
  await restored.dismiss("clear-one");
  assert.equal(reload().getSnapshot().reset.status, "requested");
  assert.equal(
    reload(deliveryScope({ ...session, accountId: "other" })).getSnapshot().reset,
    null,
  );
});

test("only an observed fresh different conversation confirms clear, and replay cannot reopen it", async () => {
  const { draft, reload } = fixture();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  for (const data of [
    null,
    snapshot("native-before"),
    snapshot(null),
    snapshot("native-after", { availability: "waiting" }),
    snapshot("native-after", { observability: { stale: true } }),
  ]) {
    await draft.observeReset(data, 0);
    assert.equal(draft.getSnapshot().reset.status, "requested");
  }
  await draft.observeReset(snapshot("native-after"), 0);
  assert.equal(reload().getSnapshot().reset.status, "confirmed");
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  await draft.observeReset(snapshot("native-before"), 0);
  assert.equal(reload().getSnapshot().reset.status, "confirmed");
});

test("rejected clears, ordinary messages, attached or multiline commands and other tools do not request reset", async () => {
  for (const [text, supplied, status] of [
    ["/clear", context, "rejected"],
    ["/clear\nExplain this", context, "handed-off"],
    [" /clear", context, "handed-off"],
    ["/clear", { ...context, tool: "claude" }, "handed-off"],
    ["/clear", { ...context, providerSessionId: null }, "handed-off"],
    ["hello", context, "handed-off"],
  ]) {
    const { draft } = fixture();
    await enqueue(draft, text, supplied);
    await draft.receipt({ deliveryId: "clear-one", status });
    assert.equal(draft.getSnapshot().reset, null);
  }
  const { draft } = fixture();
  await draft.change({
    attachments: [{ key: "file", name: "file", path: "/fixture/file" }],
  });
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  assert.equal(draft.getSnapshot().reset, null);
});

test("restart clears pending presentation and an old receipt cannot replace a newer request", async () => {
  const { draft, reload } = fixture();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  await draft.observeReset(null, 1);
  assert.equal(reload().getSnapshot().reset, null);
  await enqueue(draft, "/clear", { ...context, restartGeneration: 1 }, "clear-two");
  await draft.receipt({ deliveryId: "clear-two", status: "handed-off" });
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  assert.equal(reload().getSnapshot().reset.deliveryId, "clear-two");
});

test("a background tab cannot erase a reset from a newer restart", async () => {
  const { draft, reload } = fixture();
  const background = reload();
  await enqueue(draft, "/clear", { ...context, restartGeneration: 1 });
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  await background.observeReset(null, 0);
  assert.equal(reload().getSnapshot().reset?.status, "requested");
});

test("a cached snapshot from before the request cannot confirm another tab's reset", async () => {
  const { draft, reload } = fixture();
  const background = reload();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  await background.observeReset(
    snapshot("older-conversation", { clientObservedAt: 1 }),
    0,
  );
  assert.equal(reload().getSnapshot().reset.status, "requested");
});

test("the first late handoff of an earlier uncertain clear cannot replace a newer clear", async () => {
  const { draft, reload } = fixture();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "uncertain" });
  await draft.restore("clear-one");
  await enqueue(
    draft,
    "/clear",
    { ...context, providerSessionId: "native-current" },
    "clear-two",
  );
  await draft.receipt({ deliveryId: "clear-two", status: "handed-off" });
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  assert.equal(reload().getSnapshot().reset.deliveryId, "clear-two");
});

test("an explicit absent retry captures the current conversation after a restart", async () => {
  const { draft, reload } = fixture();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "absent" });
  const retried = await draft.retryAbsent([], {
    ...context,
    providerSessionId: "new-launch",
    restartGeneration: 1,
  });
  assert.equal(retried.id, "clear-one");
  await draft.receipt({ deliveryId: retried.id, status: "handed-off" });
  await draft.observeReset(snapshot("new-launch"), 1);
  assert.equal(reload().getSnapshot().reset?.status, "requested");
  assert.equal(reload().getSnapshot().reset?.providerSessionId, "new-launch");
  assert.equal(await draft.retryAbsent([], context), null);
});

test("older pages stay in previous history while new and updated output stays current", async () => {
  const { resetHistory } = await import("../../web/features/chat/chat-reset.js");
  const { draft } = fixture();
  await enqueue(draft);
  await draft.receipt({ deliveryId: "clear-one", status: "handed-off" });
  const rows = [
    { id: "older", role: "assistant", text: "Loaded older page" },
    { id: "old", role: "assistant", text: "Updated answer" },
    { id: "new", role: "assistant", text: "New answer" },
  ];
  const result = resetHistory(draft.getSnapshot().reset, rows, "requested");
  assert.deepEqual(
    result.previous.map((row) => row.id),
    ["older"],
  );
  assert.deepEqual(
    result.current.map((row) => row.id),
    ["old", "new"],
  );
});
