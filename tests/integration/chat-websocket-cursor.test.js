import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture } from "../helpers/application.js";

const sessionId = "chat-stream-fixture";
const timeout = 10000;

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function fixture(t) {
  const f = await applicationFixture(t);
  f.application.accounts.environment = () => ({ HOME: f.home });
  f.application.sessions.get = async (id) => {
    assert.equal(id, sessionId);
    return { id, accountId: "fixture", tool: "codex", status: "stopped" };
  };
  f.application.sessions.screen = async () => "stopped fixture\n";
  let snapshot = {
    providerSessionId: "provider-fixture",
    messages: [
      { id: "first", role: "assistant", text: "Initial answer" },
      { id: "last", role: "user", text: "Unchanged tail" },
    ],
    tasks: [],
  };
  f.application.chat.read = async () => structuredClone(snapshot);
  f.application.chatImages.decorate = async (_id, value) => value;
  f.application.chatImages.read = async () => structuredClone(snapshot);
  return Object.assign(f, {
    change(text) {
      snapshot = { ...snapshot, messages: [{ id: "first", role: "assistant", text }] };
    },
  });
}

function connect(t, f, query = "") {
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${sessionId}/chat-stream${query}`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  const frames = [];
  const errors = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => ws.once("close", resolve));
  t.after(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  return {
    ws,
    closed,
    async sync() {
      await until(
        () => errors.length || frames.some((frame) => frame.type === "sync"),
        "Expected sync frame",
      );
      assert.deepEqual(errors, []);
      return frames.find((frame) => frame.type === "sync").data;
    },
  };
}

test(
  "chat WebSocket resumes from a cursor parked on close after many later frames",
  {
    timeout,
  },
  async (t) => {
    const f = await fixture(t);
    const first = connect(t, f);
    const cursor = (await first.sync()).sync.cursor;
    assert.ok(cursor);
    first.ws.close();
    await first.closed;
    await until(
      () => f.application.chatSync.parked.has(cursor),
      "closed connection must park its cursor",
    );
    for (let n = 0; n < 10; n++) {
      f.change(`later ${n}`);
      await f.application.chatSync.read(sessionId);
    }
    const resumed = connect(t, f, `?cursor=${cursor}`);
    const data = await resumed.sync();
    assert.equal(data.sync.mode, "delta");
    assert.equal(data.sync.base, cursor);
  },
);

test(
  "chat WebSocket ignores invalid cursors and does not park a never-used base",
  {
    timeout,
  },
  async (t) => {
    const f = await fixture(t);
    const invalid = ["unknown-123", "bad%20value", "with_underscore", "a".repeat(65)];
    for (const bad of invalid) {
      const client = connect(t, f, `?cursor=${bad}`);
      assert.equal((await client.sync()).sync.mode, "full");
    }
    const http = await (await f.request(`/api/sessions/${sessionId}/chat`)).json();
    const early = connect(t, f, `?cursor=${http.sync.cursor}`);
    early.ws.close();
    await early.closed;
    await delay(50);
    assert.equal(f.application.chatSync.parked.size, 0);
  },
);

test("cursors are interchangeable between WebSocket and HTTP", { timeout }, async (t) => {
  const f = await fixture(t);
  const chat = connect(t, f);
  const cursor = (await chat.sync()).sync.cursor;
  const viaHttp = await (
    await f.request(`/api/sessions/${sessionId}/chat?cursor=${cursor}`)
  ).json();
  assert.equal(viaHttp.sync.mode, "delta");
  const httpFull = await (await f.request(`/api/sessions/${sessionId}/chat`)).json();
  chat.ws.close();
  await chat.closed;
  const resumed = connect(t, f, `?cursor=${httpFull.sync.cursor}`);
  assert.equal((await resumed.sync()).sync.mode, "delta");
});
