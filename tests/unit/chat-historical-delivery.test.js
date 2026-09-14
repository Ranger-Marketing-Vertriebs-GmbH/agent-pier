import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatDraft,
  deliveryNotices,
  deliveryScope,
} from "../../web/features/chat/chat-draft.js";
test("older pages cannot hide a new legacy handoff notice after reload", async () => {
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
  const scope = deliveryScope({
    id: "isolated-audit",
    accountId: "local",
    tool: "claude",
  });
  const lock = async (_name, fn) => fn();
  const draft = new ChatDraft(storage, scope, lock);
  const currentWindow = [
    {
      id: "current-user",
      role: "user",
      text: "Different recent prompt",
      timestamp: "2026-09-12T10:00:00Z",
    },
  ];
  await draft.change({ text: "weiter" });
  await draft.enqueue("new-delivery", currentWindow);
  await draft.receipt({ deliveryId: "new-delivery", status: "handed-off" });
  assert.equal(deliveryNotices(draft.getSnapshot(), currentWindow).length, 1);
  const oldPage = [
    {
      id: "old-user-from-yesterday",
      role: "user",
      text: "weiter",
      timestamp: "2026-09-11T10:00:00Z",
    },
    ...currentWindow,
  ];
  await draft.observeMessages(oldPage);
  const reloaded = new ChatDraft(storage, scope, lock);
  assert.equal(reloaded.getSnapshot().recent[0].matchedMessageId, undefined);
  assert.equal(deliveryNotices(reloaded.getSnapshot(), oldPage).length, 1);
  assert.equal(deliveryNotices(reloaded.getSnapshot(), currentWindow).length, 1);
});
