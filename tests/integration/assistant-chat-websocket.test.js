import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

const timeout = 15000;
const message = (id, text = id, timestamp = 1) => ({
  id,
  role: "assistant",
  text,
  timestamp,
  runId: null,
});

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

/** An app with the agent feature on, no Gateway, and two cached conversations. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service, "the agent feature runs");
  service.feeds.debounceMs = 20;
  const assistant = service.store.createAssistant({
    name: "Feed",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = (key) =>
    service.store.saveConversation({ assistantId: assistant.id, runtimeSessionKey: key })
      .id;
  const a = conversation("agent:feed:a");
  const b = conversation("agent:feed:b");
  service.store.cacheMessages(a, [message("one"), message("two", "two", 2)]);
  service.store.cacheMessages(b, [message("other")]);
  const reads = new Map();
  const read = service.feeds.read;
  service.feeds.read = (id) => {
    reads.set(id, (reads.get(id) || 0) + 1);
    return read(id);
  };
  return Object.assign(f, { service, a, b, reads });
}

function connect(t, f, id, { cursor, ...options } = {}) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/assistant-conversations/${id}/stream${query}`,
    { origin: f.url, headers: { cookie: f.cookie }, ...options },
  );
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  const status = new Promise((resolve) => {
    ws.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.resume();
      ws.terminate();
    });
    ws.once("open", () => resolve(101));
  });
  t.after(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  const of = (type) => frames.filter((frame) => frame.type === type);
  return {
    ws,
    frames,
    closed,
    status,
    of,
    async sync(count = 1) {
      await until(
        () => of("sync").length >= count,
        `sync ${count}: ${JSON.stringify(frames)}`,
      );
      return of("sync")[count - 1];
    },
  };
}

test(
  "the agent chat feed sends a full window, then deltas, and resumes from its cursor",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const client = connect(t, f, f.a);
    const first = await client.sync();
    assert.equal(first.sequence, 1);
    assert.equal(first.data.sync.mode, "full");
    assert.deepEqual(
      first.data.messages.map((m) => m.id),
      ["one", "two"],
    );
    assert.equal(first.data.stale, true);
    f.service.store.cacheMessages(f.a, [
      message("one"),
      message("two", "two edited", 2),
      message("three", "three", 3),
    ]);
    f.service.changed({ conversationId: f.a });
    const second = await client.sync(2);
    assert.equal(second.sequence, 2);
    assert.equal(second.data.sync.mode, "delta");
    assert.deepEqual(
      second.data.upserts.map((m) => [m.id, m.text]),
      [
        ["two", "two edited"],
        ["three", "three"],
      ],
    );
    const state = applyChatSync(first.data, second.data);
    client.ws.close();
    await client.closed;
    // Resuming with a known cursor sends only what changed meanwhile.
    f.service.store.cacheMessages(f.a, [
      message("one"),
      message("two", "two edited", 2),
      message("three", "three", 3),
      message("four", "four", 4),
    ]);
    const resumed = connect(t, f, f.a, { cursor: state.sync.cursor });
    const delta = await resumed.sync();
    assert.equal(delta.sequence, 1);
    assert.equal(delta.data.sync.mode, "delta");
    assert.deepEqual(
      delta.data.upserts.map((m) => m.id),
      ["four"],
    );
    // An unknown cursor (a restarted service) gets the whole window.
    const unknown = connect(t, f, f.a, {
      cursor: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal((await unknown.sync()).data.sync.mode, "full");
  },
);

test(
  "a scoped change reads only its own feed; a global change reads every feed",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const a = connect(t, f, f.a);
    const b = connect(t, f, f.b);
    await Promise.all([a.sync(), b.sync()]);
    const before = { a: f.reads.get(f.a), b: f.reads.get(f.b) };
    f.service.changed({ conversationId: f.a });
    await until(() => f.reads.get(f.a) > before.a, "a reads again");
    await delay(80);
    assert.equal(f.reads.get(f.b), before.b);
    f.service.changed();
    await until(() => f.reads.get(f.b) > before.b, "b reads after a global change");
    // Nothing changed in either history: no frame follows the initial one.
    await delay(80);
    assert.equal(a.of("sync").length, 1);
    assert.equal(b.of("sync").length, 1);
  },
);

test(
  "stream frames append per socket and a new socket gets the whole reply",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const one = connect(t, f, f.a);
    await one.sync();
    f.service.feeds.stream(f.a, "run-1", "Hello");
    f.service.feeds.stream(f.a, "run-1", "Hello there");
    await until(() => one.of("stream").length === 2, "two stream frames");
    assert.deepEqual(one.of("stream"), [
      { type: "stream", runId: "run-1", from: 0, text: "Hello" },
      { type: "stream", runId: "run-1", from: 5, text: " there" },
    ]);
    const two = connect(t, f, f.a);
    await until(() => two.of("stream").length === 1, "whole text for a new socket");
    assert.deepEqual(two.of("stream")[0], {
      type: "stream",
      runId: "run-1",
      from: 0,
      text: "Hello there",
    });
    assert.equal("sequence" in two.of("stream")[0], false);
    const other = connect(t, f, f.b);
    await other.sync();
    assert.deepEqual(other.of("stream"), []);
  },
);

test(
  "the agent chat feed requires login, a known conversation and a running feature",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    for (const options of [{ headers: {} }, { origin: "https://foreign.example" }]) {
      const client = connect(t, f, f.a, options);
      assert.ok([401, 403].includes(await client.status));
      assert.deepEqual(client.frames, []);
    }
    assert.equal(await connect(t, f, "unknown-conversation").status, 404);
    assert.equal(await connect(t, f, "bad%20id").status, 404);
    // Without the agent feature there is no feed.
    const running = f.application.assistants;
    f.application.assistants = null;
    try {
      assert.equal(await connect(t, f, f.a).status, 503);
    } finally {
      f.application.assistants = running;
    }
    // A history that reports its conversation gone closes the feed.
    const client = connect(t, f, f.b);
    await client.sync();
    f.service.feeds.read = async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    };
    f.service.changed({ conversationId: f.b });
    assert.equal(await client.closed, 1008);
  },
);

test(
  "logout closes the agent chat feed and releases its subscription",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const client = connect(t, f, f.a);
    await client.sync();
    assert.equal(f.service.feeds.entries.has(f.a), true);
    const result = await f.request("/auth/logout", { method: "POST" });
    assert.equal(result.status, 204);
    assert.equal(await client.closed, 1008);
    await until(() => !f.service.feeds.entries.has(f.a), "feed released");
  },
);

test("a socket that cannot keep up is closed to resume later", { timeout }, async (t) => {
  const f = await fixture(t);
  const client = connect(t, f, f.a);
  await client.sync();
  const [server] = f.application.assistantChatWss.clients;
  Object.defineProperty(server, "bufferedAmount", { get: () => 4 * 1024 * 1024 });
  f.service.feeds.stream(f.a, "run", "text");
  assert.equal(await client.closed, 1013);
});

test(
  "the history route answers ?cursor= with the feed's diff shape",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const get = async (query) => {
      const response = await f.request(
        `/api/assistant-conversations/${f.a}/messages${query}`,
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const full = await get("?cursor=");
    assert.equal(full.sync.mode, "full");
    assert.deepEqual(
      full.messages.map((m) => m.id),
      ["one", "two"],
    );
    f.service.store.cacheMessages(f.a, [
      message("one"),
      message("two", "two", 2),
      message("x", "x", 3),
    ]);
    const delta = await get(`?cursor=${full.sync.cursor}`);
    assert.equal(delta.sync.mode, "delta");
    assert.equal(delta.sync.base, full.sync.cursor);
    assert.deepEqual(
      delta.upserts.map((m) => m.id),
      ["x"],
    );
    assert.deepEqual(delta.order, ["one", "two", "x"]);
    // Without a cursor the route keeps its plain history page.
    const plain = await get("");
    assert.equal("sync" in plain, false);
    assert.equal(plain.messages.length, 3);
  },
);
