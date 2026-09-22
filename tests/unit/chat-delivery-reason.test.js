import test from "node:test";
import assert from "node:assert/strict";
import { ChatDraft, deliveryScope } from "../../web/features/chat/chat-draft.js";
import { chatDeliveryCopy } from "../../web/lib/i18n/messages/chat.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

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

test("rejected receipts keep their stable reason for a translated notice", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "hello" });
  await draft.enqueue("id", []);
  await draft.receipt({
    deliveryId: "id",
    status: "rejected",
    reason: "CHAT_COMPOSER_DIALOG",
    error: "German fallback",
  });
  const item = draft.getSnapshot().outbox;
  assert.equal(item.reason, "CHAT_COMPOSER_DIALOG");
  setLanguage("en");
  try {
    assert.match(chatDeliveryCopy.reasons[item.reason], /dialog/);
  } finally {
    setLanguage("de");
  }
  assert.match(chatDeliveryCopy.reasons[item.reason], /Dialog/);
});
