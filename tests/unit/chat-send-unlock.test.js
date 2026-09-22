import test from "node:test";
import assert from "node:assert/strict";
import { ChatDraft, deliveryScope } from "../../web/features/chat/chat-draft.js";

function storage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
const scope = deliveryScope({
  id: "one",
  accountId: "a",
  tool: "claude",
  createdAt: "x",
});
const lock = (name, operation) => Promise.resolve().then(operation);

test("an absent outbox never locks the chat: it can be edited and dismissed", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "too large for the old body limit" });
  await draft.enqueue("id", []);
  await draft.receipt({ deliveryId: "id", status: "absent" });
  assert.equal(draft.getSnapshot().outbox.status, "absent");
  await draft.restore("id");
  assert.equal(draft.getSnapshot().outbox, null);
  assert.equal(draft.getSnapshot().text, "too large for the old body limit");
  // The absent notice stays pollable in recent until the user dismisses it.
  assert.equal(draft.getSnapshot().recent[0].status, "absent");
  await draft.dismiss("id");
  assert.deepEqual(draft.getSnapshot().recent, []);
});
