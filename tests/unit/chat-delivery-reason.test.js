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
  // Nothing reached the terminal: the composer is released with the text.
  const snapshot = draft.getSnapshot();
  assert.equal(snapshot.outbox, null);
  assert.equal(snapshot.text, "hello");
  const item = snapshot.recent.find((entry) => entry.id === "id");
  assert.equal(item.status, "rejected");
  assert.equal(item.reason, "CHAT_COMPOSER_DIALOG");
  setLanguage("en");
  try {
    assert.match(chatDeliveryCopy.reasons[item.reason], /dialog/);
    assert.match(
      chatDeliveryCopy.pastedReasons[item.reason],
      /pasted into Claude but not submitted/,
    );
  } finally {
    setLanguage("de");
  }
  assert.match(chatDeliveryCopy.reasons[item.reason], /Dialog/);
});

test("handoff notices are kept and translated as non-blocking information", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "hello" });
  await draft.enqueue("id", []);
  await draft.receipt({
    deliveryId: "id",
    status: "handed-off",
    notices: ["CHAT_APPENDED_TO_DRAFT", "CHAT_DIALOG_CLOSED"],
  });
  const snapshot = draft.getSnapshot();
  assert.equal(snapshot.outbox, null);
  const item = snapshot.recent.find((entry) => entry.id === "id");
  assert.deepEqual(item.notices, ["CHAT_APPENDED_TO_DRAFT", "CHAT_DIALOG_CLOSED"]);
  setLanguage("en");
  try {
    assert.equal(
      chatDeliveryCopy.notices.CHAT_APPENDED_TO_DRAFT,
      "Sent together with text that was already in the terminal prompt.",
    );
    assert.match(chatDeliveryCopy.notices.CHAT_DIALOG_CLOSED, /menu/);
  } finally {
    setLanguage("de");
  }
  assert.match(chatDeliveryCopy.notices.CHAT_APPENDED_TO_DRAFT, /Terminal-Eingabefeld/);
});
