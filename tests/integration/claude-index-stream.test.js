import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture } from "../helpers/application.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function fixture(t, { failIndex = false } = {}) {
  const f = await applicationFixture(t);
  const app = f.application;
  const session = {
    id: "stopped-claude",
    accountId: "fixture",
    tool: "claude",
    cwd: f.home,
    status: "stopped",
  };
  app.sessions.get = async (id) => {
    assert.equal(id, session.id);
    return session;
  };
  app.accounts.get = () => ({ id: "fixture", tool: "claude" });
  app.accounts.environment = () => ({ HOME: f.home });
  app.bindings.resolve = async () => null;
  const directory = path.join(
    f.home,
    ".claude/projects",
    f.home.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "native.jsonl");
  const records = Array.from({ length: 120 }, (_, index) => ({
    uuid: `row-${index}`,
    cwd: f.home,
    sessionId: "native",
    type: "assistant",
    message: { content: `Message ${index}` },
  }));
  records.unshift({
    uuid: "early-task",
    cwd: f.home,
    sessionId: "native",
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "todo-call",
          name: "TodoWrite",
          input: { todos: [{ content: "Earlier task", status: "pending" }] },
        },
      ],
    },
  });
  await fs.writeFile(
    file,
    records.map((record) => JSON.stringify(record) + "\n").join(""),
  );
  const entry = app.history.claudePages.entry(session, "native", file);
  const scan = entry.index.scan.bind(entry.index);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let scans = 0;
  entry.index.scan = async (...args) => {
    scans++;
    await gate;
    if (failIndex) throw new Error("Synthetic background index failure");
    return scan(...args);
  };
  app.chat.initialize(session, "native");
  const frames = [];
  const snapshots = [];
  const errors = [];
  let current;
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${session.id}/chat-stream`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  ws.on("error", (error) => errors.push(error));
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    if (frame.type === "sync") {
      current = applyChatSync(current, frame.data);
      snapshots.push(current);
    }
    // Match the browser transport: ended permanently closes this subscription.
    if (frame.type === "ended") ws.close();
  });
  return {
    ...f,
    session,
    ws,
    frames,
    snapshots,
    errors,
    release,
    scans: () => scans,
  };
}

test(
  "stopped Claude stream waits for indexed metadata and a valid history cursor before ending",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    try {
      await until(
        () => f.snapshots.length && f.scans(),
        "provisional snapshot and gated index start",
      );
      const provisional = f.snapshots[0];
      assert.equal(provisional.history.indexing, true);
      assert.deepEqual(provisional.tasks, []);
      assert.equal(
        f.frames.some((frame) => frame.type === "ended"),
        false,
      );
      assert.equal(f.ws.readyState, WebSocket.OPEN);
      f.release();
      await until(
        () => f.ws.readyState === WebSocket.CLOSED,
        "stream ends after indexing completes",
      );
      assert.deepEqual(f.errors, []);
      const ready = f.snapshots.at(-1);
      assert.equal(ready.history.indexing, false);
      assert.notEqual(ready.history.generation, provisional.history.generation);
      assert.deepEqual(
        ready.tasks.map((task) => task.text),
        ["Earlier task"],
      );
      assert.ok(ready.history.cursor);
      assert.equal(f.frames.at(-1).type, "ended");
      assert.equal(f.frames.filter((frame) => frame.type === "ended").length, 1);
      const older = await f.request(
        `/api/sessions/${f.session.id}/chat/history?cursor=${encodeURIComponent(ready.history.cursor)}`,
      );
      assert.equal(older.status, 200);
      const page = await older.json();
      assert.equal(page.messages.at(-1).id, "row-69");
      assert.equal(page.history.generation, ready.history.generation);
      await until(
        () => !f.application.chatStreams.entries.has(f.session.id),
        "ended client releases its stream",
      );
    } finally {
      f.release();
      f.ws.terminate();
    }
  },
);

test(
  "failed Claude indexing retains a stopped stream and a usable provisional history cursor",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { failIndex: true });
    try {
      await until(
        () => f.snapshots.length && f.scans(),
        "provisional snapshot and gated index start",
      );
      assert.equal(f.snapshots[0].history.indexing, true);
      assert.equal(
        f.frames.some((frame) => frame.type === "ended"),
        false,
      );
      f.release();
      await until(
        () => f.snapshots.at(-1)?.history.indexing === false,
        "failed indexing publishes its provisional cursor",
      );
      assert.deepEqual(f.errors, []);
      const settled = f.snapshots.at(-1);
      assert.equal(settled.history.indexing, false);
      assert.equal(settled.observability.stale, true);
      assert.equal(
        f.frames.some((frame) => frame.type === "ended"),
        false,
      );
      assert.equal(f.ws.readyState, WebSocket.OPEN);
      assert.equal(f.scans(), 1, "unchanged failing source must not immediately reindex");
      const older = await f.request(
        `/api/sessions/${f.session.id}/chat/history?cursor=${encodeURIComponent(settled.history.cursor)}`,
      );
      assert.equal(older.status, 200);
      assert.equal((await older.json()).messages.at(-1).id, "row-69");
    } finally {
      f.release();
      f.ws.terminate();
    }
  },
);
