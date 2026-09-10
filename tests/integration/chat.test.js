import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../../server/features/chat/chat-store.js";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-chat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = {
    id: "test",
    accountId: "one",
    tool: "claude",
    cwd: dir,
    status: "running",
  };
  const content = {
    messages: [{ id: "m1", role: "assistant", text: "Hello" }],
    tasks: [{ id: "t1", text: "Build", status: "in_progress" }],
  };
  const history = {
    list: async () => [
      { id: "native-one", title: "One" },
      { id: "native-two", title: "Two" },
    ],
    read: async () => content,
  };
  const store = new ChatStore({
    dataDir: dir,
    sessions: { get: async () => session },
    history,
  });
  return { dir, session, store, history, content };
}
test("chat never guesses the newest conversation or falls back to terminal chrome", async (t) => {
  const { store } = fixture(t);
  assert.deepEqual(await store.read("test"), {
    availability: "unbound",
    providerSessionId: null,
    messages: [],
    tasks: [],
  });
});
test("exact binding persists, retains tasks, and rejects a foreign account or unavailable conversation", async (t) => {
  const { store, session } = fixture(t);
  await assert.rejects(store.bind("test", "foreign"), /Accounts/);
  await store.bind("test", "native-one");
  assert.equal((await store.read("test")).providerSessionId, "native-one");
  assert.equal((await store.read("test")).tasks[0].status, "in_progress");
  session.accountId = "other";
  await assert.rejects(store.read("test"), /Account/);
});
test("switching a binding invalidates cached messages and stopped sessions retain snapshots", async (t) => {
  const { store, history, session } = fixture(t);
  await store.bind("test", "native-one");
  await store.read("test");
  history.read = async () => ({
    messages: [{ id: "two", role: "user", text: "Two" }],
    tasks: [],
  });
  await store.bind("test", "native-two");
  assert.equal((await store.read("test")).messages[0].text, "Two");
  store.cache.clear();
  session.status = "stopped";
  history.read = async () => {
    throw Error("offline");
  };
  assert.equal((await store.read("test")).messages[0].text, "Two");
  store.remove("test");
  assert.equal((await store.read("test")).availability, "unbound");
});
test("running chats retain their saved snapshot when live history is unavailable", async (t) => {
  const { store, history, session } = fixture(t);
  await store.bind("test", "native-one");
  history.read = async () => {
    throw Object.assign(Error("history unavailable"), { status: 503 });
  };
  const result = await store.read("test");
  assert.equal(result.messages[0].text, "Hello");
  assert.equal(result.observability.stale, true);
  assert.equal(session.status, "running");
});
test("running chats show their snapshot while a long live history read continues", async (t) => {
  const { dir, history, session } = fixture(t);
  const store = new ChatStore({
    dataDir: dir,
    sessions: { get: async () => session },
    history,
    liveHistoryTimeout: 1,
  });
  await store.bind("test", "native-one");
  history.read = () => new Promise(() => {});
  const started = Date.now();
  const result = await store.read("test");
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.messages[0].text, "Hello");
  assert.equal(result.observability.stale, true);
});
