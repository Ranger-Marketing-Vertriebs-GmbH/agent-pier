import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssistantStore,
  cachedMessageLimit,
  cachedTextLimit,
} from "../../server/features/assistants/assistant-store.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";

// OpenClaw's chat.history cuts a page's texts at 8000 characters and marks the cut;
// a message read on its own uses the caller's limit.
const marker = "\n...(truncated)...";
const cutText = (text, max) =>
  text.length > max ? `${text.slice(0, max)}${marker}` : text;
const longText = `${"a line of the pasted docs\n".repeat(1000)}the end`;
const native = (id, timestamp, content, role = "assistant") => ({
  role,
  content,
  timestamp,
  __openclaw: { id },
});

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-message-cache-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = store.createAssistant({
    name: "Cache",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "session",
  });
  // Single reads of these ids serve no message, like an unanswered read.
  const state = { history: [], reads: [], failing: new Set() };
  const clock = { at: 1_000_000 };
  const client = {
    ready: true,
    call: async (method, params) => {
      assert.equal(method, "chat.history");
      const max = params.maxChars ?? 8000;
      if (params.messageId) state.reads.push(params.messageId);
      if (state.failing.has(params.messageId)) return { messages: [] };
      // A page counts back from the newest message: `offset` skips the newest ones.
      const end = state.history.length - (params.offset || 0);
      const start = Math.max(0, end - (params.limit || 1));
      const shown = params.messageId
        ? state.history.filter((m) => m.__openclaw.id === params.messageId)
        : state.history.slice(start, end);
      return {
        messages: shown.map((m) => ({ ...m, content: cutText(m.content, max) })),
        hasMore: !params.messageId && start > 0,
      };
    },
  };
  const service = {
    store,
    runtime: { client, generation: 1 },
    now: () => clock.at,
    ledger: { requests: () => [], attemptRequests: () => new Map() },
  };
  const writes = t.mock.method(store, "cacheMessages");
  const read = (options) => conversationHistory(service, conversation.id, options);
  return { store, client, state, clock, writes, read, id: conversation.id };
}

test("an unchanged history read does not rewrite the message cache", async (t) => {
  const { store, state, writes, read, id } = setup(t);
  state.history = [
    native("u1", 1, "Paste these docs", "user"),
    native("a1", 2, longText),
  ];
  const first = await read();
  assert.equal(first.messages.at(-1).text, longText);
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(state.reads, ["a1"]);
  const stored = store.messages(id);
  // The 2 s poll during a run: same page, same completed text.
  for (let i = 0; i < 3; i++) {
    const again = await read();
    assert.equal(again.stale, false);
    assert.equal(again.messages.at(-1).text, longText);
  }
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(state.reads, ["a1"], "the completed text is reused, not re-read");
  assert.deepEqual(store.messages(id), stored);
  // A new message changes the cache, so it is written once more.
  state.history.push(native("a2", 3, "Anything else?"));
  await read();
  assert.equal(writes.mock.callCount(), 2);
  assert.deepEqual(
    store.messages(id).map((m) => m.id),
    ["u1", "a1", "a2"],
  );
});

test("the cache keeps only the newest messages and their completed texts", async (t) => {
  const { store, state, writes, read, id } = setup(t);
  assert.ok(cachedMessageLimit >= 100, "the cache holds at least one full page");
  const count = cachedMessageLimit + 50;
  state.history = Array.from({ length: count }, (_, i) =>
    native(`m${i}`, i + 1, i === count - 2 ? longText : `message ${i}`),
  );
  // Older pages were loaded once; their messages joined the cache.
  store.cacheMessages(
    id,
    state.history.map((m) => ({
      id: m.__openclaw.id,
      role: m.role,
      text: m.content,
      timestamp: m.timestamp,
      runId: null,
    })),
  );
  // Count only the writes of history reads from here on.
  writes.mock.resetCalls();
  const cached = store.messages(id);
  assert.equal(cached.length, cachedMessageLimit);
  assert.equal(cached[0].id, `m${count - cachedMessageLimit}`);
  assert.equal(cached.at(-1).id, `m${count - 1}`);
  // The newest page completes the long text from the cache without a single read.
  const page = await read();
  assert.equal(page.messages.at(-2).text, longText);
  assert.equal(page.messages.at(-2).partial, undefined);
  assert.deepEqual(state.reads, []);
  // New messages push the oldest out; the completed text stays.
  state.history.push(native("new", count + 1, "Newest"));
  await read();
  const after = store.messages(id);
  assert.equal(after.length, cachedMessageLimit);
  assert.equal(after[0].id, `m${count - cachedMessageLimit + 1}`);
  assert.equal(after.at(-1).id, "new");
  assert.equal(after.find((m) => m.id === `m${count - 2}`).text, longText);
  assert.equal(writes.mock.callCount(), 1);
});

test("a message completed later is written once and then left alone", async (t) => {
  const { store, state, clock, writes, read, id } = setup(t);
  state.history = [native("a1", 1, longText)];
  // The single read goes unanswered: the cache keeps the page's cut text.
  state.failing.add("a1");
  assert.equal((await read()).messages[0].partial, true);
  assert.equal(writes.mock.callCount(), 1);
  // Its retry is not due yet, so the next poll changes nothing.
  await read();
  assert.equal(writes.mock.callCount(), 1);
  // The retry reads the whole text: exactly one more write, then none.
  state.failing.delete("a1");
  clock.at += 5000;
  writes.mock.resetCalls();
  const whole = await read();
  assert.equal(whole.messages[0].text, longText);
  assert.equal(whole.messages[0].partial, undefined);
  await read();
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(store.messages(id)[0].text, longText);
  // A reply that grows under the same id is written once per change.
  state.history.push(native("a2", 2, "Hel"));
  await read();
  state.history[1] = native("a2", 2, "Hello, the rest of the reply");
  writes.mock.resetCalls();
  await read();
  await read();
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(store.messages(id)[1].text, "Hello, the rest of the reply");
});

test("the cache keeps its texts within a budget but the newest page whole", (t) => {
  const { store, id } = setup(t);
  const huge = (count, size) =>
    Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      text: `${i}`.padEnd(size, "x"),
      timestamp: i + 1,
      runId: null,
    }));
  const size = 30000;
  store.cacheMessages(id, huge(cachedMessageLimit, size));
  const kept = store.messages(id);
  const total = kept.reduce((sum, m) => sum + m.text.length, 0);
  assert.ok(total <= cachedTextLimit, `${total} characters`);
  assert.equal(kept.length, Math.floor(cachedTextLimit / size));
  assert.equal(kept.at(-1).id, `m${cachedMessageLimit - 1}`, "the oldest leave first");
  // The newest page stays whole even when it alone exceeds the budget.
  store.cacheMessages(id, huge(150, 60000));
  const page = store.messages(id);
  assert.equal(page.length, 100);
  assert.equal(page[0].id, "m50");
  assert.equal(page.at(-1).id, "m149");
});

test("an oversized cache from an earlier build is pruned on the next read", async (t) => {
  const { store, state, writes, read, id } = setup(t);
  const count = cachedMessageLimit + 20;
  const old = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "assistant",
    text: `message ${i}`,
    timestamp: i + 1,
    runId: null,
  }));
  // Earlier builds wrote the whole merged history as one blob.
  store.db.prepare("INSERT INTO messages VALUES (?,?)").run(id, JSON.stringify(old));
  state.history = old.slice(-100).map((m) => native(m.id, m.timestamp, m.text));
  await read();
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(store.messages(id).length, cachedMessageLimit);
  await read();
  assert.equal(writes.mock.callCount(), 1);
});

test("offline reads page through the capped cache with completed texts", async (t) => {
  const { client, state, read } = setup(t);
  const count = cachedMessageLimit + 30;
  state.history = Array.from({ length: count }, (_, i) =>
    native(`m${i}`, i + 1, i === count - 1 ? longText : `message ${i}`),
  );
  // Each page the owner loaded online joined the cache.
  let before;
  do before = (await read({ before })).nextBefore;
  while (before);
  client.ready = false;
  const pages = [];
  do {
    const page = await read({ before });
    assert.equal(page.stale, true);
    pages.push(page.messages);
    before = page.nextBefore;
  } while (before);
  const served = pages.reverse().flat();
  assert.equal(served.length, cachedMessageLimit);
  assert.equal(served[0].id, `m${count - cachedMessageLimit}`);
  assert.equal(served.at(-1).id, `m${count - 1}`);
  assert.equal(served.at(-1).text, longText);
  assert.equal(served.at(-1).partial, undefined);
});
