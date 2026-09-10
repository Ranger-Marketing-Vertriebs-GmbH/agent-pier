import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { applicationFixture } from "../helpers/application.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

const sessionId = "chat-stream-fixture";
const timeout = 10000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

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
    tasks: [{ id: "task", status: "pending" }],
  };
  f.application.chat.read = async () => structuredClone(snapshot);
  f.application.chatImages.decorate = async (_id, value) => value;
  f.application.chatImages.read = async () => structuredClone(snapshot);
  return Object.assign(f, {
    update(next) {
      snapshot = next;
      f.application.chatEvents.publish(sessionId, "source-changed");
    },
    snapshot: () => structuredClone(snapshot),
  });
}

function connect(t, f, endpoint = "chat-stream", options = {}) {
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${sessionId}/${endpoint}`,
    { origin: f.url, headers: { cookie: f.cookie }, ...options },
  );
  const frames = [];
  const errors = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  t.after(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
  return {
    ws,
    frames,
    errors,
    closed,
    async next(type, after = 0) {
      await until(
        () => errors.length || frames.slice(after).some((frame) => frame.type === type),
        `Expected ${type} frame; received ${JSON.stringify(frames)}`,
      );
      assert.deepEqual(errors, [], "WebSocket transport must remain valid");
      return frames.slice(after).find((frame) => frame.type === type);
    },
  };
}

test(
  "chat and terminal WebSockets share HTTP upgrades without corrupting either connection",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const chat = connect(t, f);
    const terminal = connect(t, f, "terminal");
    const [initial, output] = await Promise.all([
      chat.next("sync"),
      terminal.next("output"),
    ]);
    assert.equal(initial.sequence, 1);
    assert.equal(initial.data.sync.mode, "full");
    assert.deepEqual(initial.data.messages, f.snapshot().messages);
    assert.equal(output.data, "stopped fixture\r\n");
    assert.equal(chat.ws.readyState, WebSocket.OPEN);
    assert.equal(terminal.ws.readyState, WebSocket.OPEN);
  },
);

test(
  "chat WebSocket requires a login cookie and rejects foreign origins",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    for (const options of [{ headers: {} }, { origin: "https://foreign.example" }]) {
      const client = connect(t, f, "chat-stream", options);
      const response = new Promise((resolve) => {
        client.ws.once("unexpected-response", (_request, result) => {
          resolve(result.statusCode);
          result.resume();
          client.ws.terminate();
        });
      });
      assert.ok([401, 403].includes(await response));
      await client.closed;
      assert.deepEqual(client.frames, []);
    }
    const allowed = connect(t, f);
    assert.equal((await allowed.next("sync")).data.sync.mode, "full");
  },
);

test(
  "logout closes the authenticated chat WebSocket and releases its subscription",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const client = connect(t, f);
    await client.next("sync");
    const result = await f.request("/auth/logout", { method: "POST" });
    assert.equal(result.status, 204);
    assert.equal(await client.closed, 1008);
    await until(
      () => !f.application.chatEvents.subscribers.has(sessionId),
      "logout releases chat events",
    );
    assert.equal(f.application.chatStreams.entries.has(sessionId), false);
  },
);

test(
  "stream deltas include earlier message and task changes, and reconnect starts with a full baseline",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const client = connect(t, f);
    const initial = await client.next("sync");
    let state = applyChatSync(null, initial.data);
    const changed = f.snapshot();
    changed.messages[0].text = "Corrected answer";
    changed.tasks[0].status = "completed";
    const offset = client.frames.length;
    f.update(changed);
    const next = await client.next("sync", offset);
    assert.equal(next.sequence, initial.sequence + 1);
    assert.equal(next.data.sync.mode, "delta");
    assert.deepEqual(
      next.data.upserts.map((row) => row.id),
      ["first"],
    );
    state = applyChatSync(state, next.data);
    assert.deepEqual(state.messages, changed.messages);
    assert.deepEqual(state.tasks, changed.tasks);
    const metadataOnly = f.snapshot();
    metadataOnly.tasks.push({ id: "follow-up", status: "pending" });
    const metadataOffset = client.frames.length;
    f.update(metadataOnly);
    const metadataFrame = await client.next("sync", metadataOffset);
    assert.equal(metadataFrame.sequence, next.sequence + 1);
    assert.equal(metadataFrame.data.sync.mode, "delta");
    assert.deepEqual(metadataFrame.data.upserts, []);
    state = applyChatSync(state, metadataFrame.data);
    assert.deepEqual(state.tasks, metadataOnly.tasks);
    client.ws.close();
    await client.closed;
    const reconnected = connect(t, f);
    const fresh = await reconnected.next("sync");
    assert.equal(fresh.sequence, 1);
    assert.equal(fresh.data.sync.mode, "full");
    assert.deepEqual(fresh.data.messages, state.messages);
    assert.deepEqual(fresh.data.tasks, state.tasks);
  },
);

test(
  "native transcript writes trigger stream updates without publishing an event hint",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const directory = path.join(f.home, ".codex", "sessions");
    await fs.mkdir(directory, { recursive: true });
    const transcript = path.join(directory, "fixture.jsonl");
    const initial = f.snapshot();
    await fs.writeFile(transcript, JSON.stringify(initial));
    f.application.chatImages.read = async () =>
      JSON.parse(await fs.readFile(transcript, "utf8"));
    const client = connect(t, f);
    const first = await client.next("sync");
    const changed = structuredClone(initial);
    changed.messages[0].text = "Update from native file";
    const offset = client.frames.length;
    await fs.writeFile(transcript, JSON.stringify(changed));
    const next = await client.next("sync", offset);
    assert.equal(next.sequence, first.sequence + 1);
    assert.equal(next.data.sync.mode, "delta");
    assert.deepEqual(applyChatSync(first.data, next.data).messages, changed.messages);
    assert.equal(f.application.chatEvents.current(sessionId), 0);
  },
);

test(
  "subscribers share serialized snapshot reads while changes arrive during a read",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    f.application.chatImages.read = async () => {
      reads++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        started.resolve();
        if (reads === 1) await release.promise;
        return f.snapshot();
      } finally {
        active--;
      }
    };
    const first = connect(t, f);
    await started.promise;
    const second = connect(t, f);
    await until(() => second.ws.readyState === WebSocket.OPEN, "second socket opens");
    for (let index = 0; index < 5; index++)
      f.application.chatEvents.publish(sessionId, "source-changed");
    await delay(50);
    assert.equal(reads, 1, "second subscriber and hints must reuse the in-flight read");
    release.resolve();
    await Promise.all([first.next("sync"), second.next("sync")]);
    assert.equal(maxActive, 1);
    first.ws.close();
    second.ws.close();
    await Promise.all([first.closed, second.closed]);
    await until(
      () => !f.application.chatStreams.entries.has(sessionId),
      "last close releases stream",
    );
    assert.equal(f.application.chatEvents.subscribers.has(sessionId), false);
  },
);

test(
  "closing during a delayed initial read cannot resurrect a stream subscription",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    t.after(() => release.resolve());
    let reads = 0;
    f.application.chatImages.read = async () => {
      reads++;
      started.resolve();
      await release.promise;
      finished.resolve();
      return f.snapshot();
    };
    const client = connect(t, f);
    await started.promise;
    client.ws.close();
    await client.closed;
    release.resolve();
    await finished.promise;
    await delay(30);
    assert.equal(f.application.chatStreams.entries.has(sessionId), false);
    assert.equal(f.application.chatEvents.subscribers.has(sessionId), false);
    f.application.chatEvents.publish(sessionId, "source-changed");
    await delay(30);
    assert.equal(reads, 1);
    assert.deepEqual(client.frames, []);
  },
);

test(
  "a new subscriber waits for invalidated cache and receives an unchanged baseline",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const first = connect(t, f);
    await first.next("sync");
    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    f.application.chatImages.read = async () => {
      started.resolve();
      await release.promise;
      return f.snapshot();
    };
    f.application.chatEvents.publish(sessionId, "source-changed");
    await started.promise;
    const second = connect(t, f);
    await until(() => second.ws.readyState === WebSocket.OPEN, "second socket opens");
    await delay(30);
    assert.deepEqual(
      second.frames,
      [],
      "invalidated cache must not become the initial baseline",
    );
    release.resolve();
    const baseline = await second.next("sync");
    assert.equal(baseline.data.sync.mode, "full");
    assert.deepEqual(baseline.data.messages, f.snapshot().messages);
    assert.equal(first.frames.filter((frame) => frame.type === "sync").length, 1);
  },
);

test(
  "rebinding during a read never replays the previous conversation to a new subscriber",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const first = connect(t, f);
    await first.next("sync");
    const firstOffset = first.frames.length;
    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    let reads = 0;
    let snapshot = f.snapshot();
    f.application.chatImages.read = async () => {
      const value = structuredClone(snapshot);
      if (++reads === 1) {
        started.resolve();
        await release.promise;
      }
      return value;
    };
    f.application.chatEvents.publish(sessionId, "source-changed");
    await started.promise;
    snapshot = { ...snapshot, providerSessionId: "replacement", messages: [] };
    f.application.chatEvents.publish(sessionId, "binding-changed");
    const second = connect(t, f);
    await until(() => second.ws.readyState === WebSocket.OPEN, "second socket opens");
    await delay(30);
    assert.deepEqual(second.frames, []);
    release.resolve();
    const [updated, baseline] = await Promise.all([
      first.next("sync", firstOffset),
      second.next("sync"),
    ]);
    assert.equal(updated.data.providerSessionId, "replacement");
    assert.equal(baseline.data.providerSessionId, "replacement");
    assert.equal(baseline.data.sync.mode, "full");
    assert.deepEqual(baseline.data.messages, []);
  },
);

test("chat upgrades return 503 once streams have shut down", { timeout }, async (t) => {
  const f = await fixture(t);
  f.application.chatStreams.close();
  const client = connect(t, f);
  await client.closed;
  assert.match(client.errors[0]?.message || "", /503/);
  assert.deepEqual(client.frames, []);
});

test(
  "completed background snapshots reuse the cache while coalesced source hints still invalidate it",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    let cached;
    let source = f.snapshot();
    let providerReads = 0;
    let invalidations = 0;
    f.application.chat.invalidate = () => {
      invalidations++;
      cached = null;
    };
    f.application.chatImages.read = async () => {
      if (!cached) {
        providerReads++;
        cached = structuredClone(source);
      }
      return cached;
    };
    const client = connect(t, f);
    await client.next("sync");
    assert.equal(providerReads, 1);
    const offset = client.frames.length;
    cached = { ...source, tasks: [{ id: "completed-read", status: "completed" }] };
    f.application.chatEvents.publish(sessionId, "snapshot-changed");
    const completed = await client.next("sync", offset);
    assert.deepEqual(completed.data.metadata.tasks, cached.tasks);
    assert.equal(providerReads, 1, "completion must not restart the provider read");
    assert.equal(invalidations, 1);

    const sourceOffset = client.frames.length;
    source = { ...source, tasks: [{ id: "new-source", status: "pending" }] };
    f.application.chatEvents.publish(sessionId, "source-changed");
    f.application.chatEvents.publish(sessionId, "snapshot-changed");
    const changed = await client.next("sync", sourceOffset);
    assert.deepEqual(changed.data.metadata.tasks, source.tasks);
    assert.equal(
      providerReads,
      2,
      "completion hint cannot erase a queued source refresh",
    );
    assert.equal(invalidations, 2);

    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const read = f.application.chatImages.read;
    f.application.chatImages.read = async () => {
      const result = await read();
      started.resolve();
      await release.promise;
      return result;
    };
    const pendingOffset = client.frames.length;
    f.application.chatEvents.publish(sessionId, "source-changed");
    await started.promise;
    cached = { ...source, tasks: [{ id: "pending-completion", status: "completed" }] };
    f.application.chatEvents.publish(sessionId, "snapshot-changed");
    release.resolve();
    const pending = await client.next("sync", pendingOffset);
    assert.deepEqual(pending.data.metadata.tasks, cached.tasks);
    assert.equal(providerReads, 3, "completion queued during a read also reuses cache");
    assert.equal(invalidations, 3);
  },
);
