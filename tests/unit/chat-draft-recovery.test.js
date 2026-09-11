import test from "node:test";
import assert from "node:assert/strict";
import { ChatDraft, deliveryNotices } from "../../web/features/chat/chat-draft.js";

function fixture() {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    key: (index) => [...data.keys()][index],
    get length() {
      return data.size;
    },
  };
  let tail = Promise.resolve();
  const lock = (_key, action) => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
  return () => new ChatDraft(storage, "scope", lock);
}

async function failed(draft) {
  await draft.change({
    text: "original",
    attachments: [{ key: "file", name: "notes", path: "/notes" }],
  });
  await draft.enqueue("original-id", []);
  await draft.receipt({ deliveryId: "original-id", status: "uncertain" });
}

test("failed delivery retains text and attachment custody after editing and more than twenty later sends", async () => {
  const reload = fixture(),
    draft = reload();
  await failed(draft);
  await draft.restore("original-id");
  for (let index = 0; index < 22; index++) {
    await draft.change({ text: `later ${index}`, attachments: [] });
    await draft.enqueue(`later-${index}`, []);
    await draft.receipt({ deliveryId: `later-${index}`, status: "handed-off" });
  }
  const item = reload()
    .getSnapshot()
    .recent.find((entry) => entry.id === "original-id");
  assert.equal(item?.text, "original\n/notes");
  assert.deepEqual(item.attachments, [{ key: "file", name: "notes", path: "/notes" }]);
  assert.equal(item.status, "uncertain");
});

test("two tabs and reload share one durable recovery request until its exact result arrives", async () => {
  const reload = fixture(),
    draft = reload();
  await failed(draft);
  const other = reload();
  const [first, second] = await Promise.all([
    draft.beginRecovery("original-id", "retry-a", "retry"),
    other.beginRecovery("original-id", "retry-b", "retry"),
  ]);
  assert.deepEqual(first.recoveryAttempt, second.recoveryAttempt);
  assert.deepEqual(reload().getSnapshot().outbox.recoveryAttempt, {
    attemptId: "retry-a",
    expectedAttemptId: "original-id",
    mode: "retry",
  });
  await other.receipt({
    deliveryId: "original-id",
    attemptId: "original-id",
    status: "uncertain",
  });
  assert.equal(reload().getSnapshot().outbox.recoveryAttempt.attemptId, "retry-a");
  await draft.receipt({
    deliveryId: "original-id",
    attemptId: "original-id",
    status: "uncertain",
    recovery: { requestId: "retry-a", action: "blocked", reason: "Other text" },
  });
  assert.equal(reload().getSnapshot().outbox.recoveryAttempt, null);
  const next = await draft.beginRecovery("original-id", "retry-c", "retry");
  assert.equal(next.recoveryAttempt.attemptId, "retry-c");
});

test("recovery on an archived bubble preserves the current composer and never duplicates a bubble", async () => {
  const reload = fixture(),
    draft = reload();
  await failed(draft);
  await draft.restore("original-id");
  await draft.change({ text: "new unsent", attachments: [] });
  await draft.beginRecovery("original-id", "retry", "retry");
  await draft.receipt({
    deliveryId: "original-id",
    attemptId: "retry",
    status: "handed-off",
    recovery: { requestId: "retry", action: "submitted-existing", reason: "" },
  });
  assert.equal(draft.getSnapshot().text, "new unsent");
  assert.equal(draft.getSnapshot().recent.length, 1);
  assert.equal(draft.getSnapshot().recent[0].status, "handed-off");
});

test("native text matching cannot hide unresolved delivery warnings", async () => {
  const reload = fixture(),
    draft = reload();
  await failed(draft);
  await draft.restore("original-id");
  const messages = [{ id: "native", role: "user", text: "original\n/notes" }];
  await draft.observeMessages(messages);
  assert.equal(deliveryNotices(draft.getSnapshot(), messages).length, 1);
});

test("a late status read from any older retry cannot roll back the current attempt", async () => {
  const reload = fixture(),
    draft = reload();
  await failed(draft);
  await draft.beginRecovery("original-id", "retry-one", "retry");
  await draft.receipt({
    deliveryId: "original-id",
    attemptId: "retry-one",
    status: "uncertain",
    recovery: { requestId: "retry-one", action: "blocked", reason: "Unknown submit" },
  });
  await draft.beginRecovery("original-id", "retry-two", "retry");
  await draft.receipt({
    deliveryId: "original-id",
    attemptId: "retry-two",
    status: "handed-off",
    recovery: { requestId: "retry-two", action: "submitted-existing", reason: "" },
  });
  await draft.receipt({
    deliveryId: "original-id",
    attemptId: "retry-one",
    status: "uncertain",
  });
  const item = reload().getSnapshot().recent[0];
  assert.equal(item.attemptId, "retry-two");
  assert.equal(item.status, "handed-off");
});

for (const terminal of ["handed-off", "rejected"]) {
  test(`late same-attempt receipts cannot undo ${terminal} in another tab`, async () => {
    const reload = fixture(),
      draft = reload();
    await draft.change({ text: "terminal receipt" });
    await draft.enqueue("delivery", []);
    const delayedTab = reload();
    await draft.receipt({
      deliveryId: "delivery",
      attemptId: "delivery",
      status: terminal,
    });
    if (terminal === "rejected") await draft.restore("delivery");
    for (const status of [
      "pending",
      "uncertain",
      "absent",
      terminal === "handed-off" ? "rejected" : "handed-off",
    ]) {
      await delayedTab.receipt({ deliveryId: "delivery", attemptId: "delivery", status });
      assert.equal(reload().getSnapshot().recent[0].status, terminal);
    }
  });
}

test("a rejected receipt still accepts a new explicit retry and its final outcome", async () => {
  const reload = fixture(),
    draft = reload();
  await draft.change({ text: "try again" });
  await draft.enqueue("delivery", []);
  await draft.receipt({
    deliveryId: "delivery",
    attemptId: "delivery",
    status: "rejected",
  });
  const item = await draft.beginRecovery("delivery", "retry", "retry");
  assert.equal(item.recoveryAttempt.expectedAttemptId, "delivery");
  await draft.receipt({ deliveryId: "delivery", attemptId: "retry", status: "pending" });
  assert.equal(reload().getSnapshot().outbox.status, "pending");
  await draft.receipt({
    deliveryId: "delivery",
    attemptId: "retry",
    status: "handed-off",
    recovery: { requestId: "retry", action: "resent", reason: "" },
  });
  assert.equal(reload().getSnapshot().outbox, null);
  assert.equal(reload().getSnapshot().recent[0].status, "handed-off");
  assert.equal(reload().getSnapshot().recent[0].attemptId, "retry");
});

test("same-attempt blocked recovery still updates the reason on a rejected receipt", async () => {
  const reload = fixture(),
    draft = reload();
  await draft.change({ text: "blocked retry" });
  await draft.enqueue("delivery", []);
  await draft.receipt({
    deliveryId: "delivery",
    attemptId: "delivery",
    status: "rejected",
  });
  await draft.beginRecovery("delivery", "retry", "retry");
  await draft.receipt({
    deliveryId: "delivery",
    attemptId: "delivery",
    status: "rejected",
    recovery: { requestId: "retry", action: "blocked", reason: "Composer occupied" },
  });
  const item = reload().getSnapshot().outbox;
  assert.equal(item.status, "rejected");
  assert.equal(item.recoveryAttempt, null);
  assert.equal(item.recovery.reason, "Composer occupied");
});
