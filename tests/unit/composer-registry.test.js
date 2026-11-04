import test from "node:test";
import assert from "node:assert/strict";
import { ChatDraft } from "../../web/features/chat/chat-draft.js";
import { appendedDraftText } from "../../web/features/chat/chat-draft-reuse.js";
import {
  MAX_CHAT_TEXT,
  appendToComposer,
  registerComposer,
} from "../../web/features/chat/composer-registry.js";

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
const lock = (name, operation) => Promise.resolve().then(operation);

function composer(t, scope = "scope", store = storage()) {
  const draft = new ChatDraft(store, scope, lock);
  t.after(registerComposer(scope, draft));
  return draft;
}

test("a blank draft is replaced, a written one gets a new line", async (t) => {
  assert.equal(appendedDraftText("  ", "batch"), "batch");
  assert.equal(appendedDraftText("note", "batch"), "note\nbatch");
  const draft = composer(t);
  assert.equal(await appendToComposer("scope", "batch"), "appended");
  assert.equal(draft.getSnapshot().text, "batch");
  await draft.change({ text: "note" });
  assert.equal(await appendToComposer("scope", "batch"), "appended");
  assert.equal(draft.getSnapshot().text, "note\nbatch");
});

test("a pending outbox locks the draft; an unknown scope is missing", async (t) => {
  const draft = composer(t);
  await draft.change({ text: "hello" });
  await draft.enqueue("m1", [], {});
  assert.equal(await appendToComposer("scope", "batch"), "locked");
  assert.equal(await appendToComposer("other", "batch"), "missing");
});

test("an unreadable draft is locked", async (t) => {
  const store = storage();
  store.setItem("agentpier.chat.v1:scope", "{not json");
  const draft = composer(t, "scope", store);
  assert.equal(await appendToComposer("scope", "batch"), "locked");
  assert.equal(draft.getSnapshot().text, "");
});

test("an edit that does not land reads as locked", async (t) => {
  const draft = composer(t);
  draft.change = async () => {};
  assert.equal(await appendToComposer("scope", "batch"), "locked");
});

test("an over-long batch is refused", async (t) => {
  assert.equal(MAX_CHAT_TEXT, 32000);
  const draft = composer(t);
  await draft.change({ text: "x".repeat(31990) });
  assert.equal(await appendToComposer("scope", "y".repeat(20)), "too-long");
  assert.equal(draft.getSnapshot().text.length, 31990);
  assert.equal(await appendToComposer("scope", "y".repeat(9)), "appended");
  assert.equal(draft.getSnapshot().text.length, 32000);
});

test("two panes of one session share the draft and both show the batch", async (t) => {
  const store = storage();
  const first = new ChatDraft(store, "scope", lock);
  const second = new ChatDraft(store, "scope", lock);
  const dropFirst = registerComposer("scope", first);
  t.after(registerComposer("scope", second));
  assert.equal(await appendToComposer("scope", "batch"), "appended");
  assert.equal(first.getSnapshot().text, "batch");
  assert.equal(second.getSnapshot().text, "batch");
  // closing one pane keeps the other registered
  dropFirst();
  assert.equal(await appendToComposer("scope", "more"), "appended");
  assert.equal(second.getSnapshot().text, "batch\nmore");
  dropFirst();
  assert.equal(await appendToComposer("scope", "again"), "appended");
});

test("the last pane to close unregisters the scope", async () => {
  const draft = new ChatDraft(storage(), "solo", lock);
  const drop = registerComposer("solo", draft);
  drop();
  assert.equal(await appendToComposer("solo", "batch"), "missing");
});
