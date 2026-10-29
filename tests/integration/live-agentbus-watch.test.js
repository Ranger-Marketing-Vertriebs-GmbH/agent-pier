import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { openQueue } from "../../vendor/agentbus/core/queue.js";
import { writeJsonAtomic } from "../../vendor/agentbus/core/fsx.js";
import { AgentBusWatches } from "../../server/features/agentbus/live-topics.js";

// Task 5.3: `agentbus.changed[:<projectId>]`, a signal topic. The project's queue
// folder is watched (the queue database, its write-ahead log and the peers), so a
// message, a claim, an acknowledgement or a peer registration sends `changed`; the
// overview's bare topic also follows the AgentBus sessions. Nothing the server only
// reads sends anything.

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

const message = (id, to = "codex-peer") => ({
  id,
  ts: Date.now(),
  from: { runtime: "claude", name: "one", sessionId: "s1", cwd: "/tmp" },
  to,
  toName: "two",
  text: `hello ${id}`,
});

async function projectHome(f, id = PROJECT) {
  const home = path.join(f.application.agentbus.root, "projects", id);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

async function subscribed(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  return { live, first };
}

const changed = (live, topic, timeoutMs = 1500) =>
  live.next((frame) => frame.topic === topic && frame.type === "changed", timeoutMs);
const changes = (live, topic) =>
  live.frames.filter((frame) => frame.topic === topic && frame.type === "changed").length;

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  return predicate();
}

test("a message, a claim and an acknowledgement in the queue send changed", async (t) => {
  const f = await applicationFixture(t);
  const home = await projectHome(f);
  const queue = openQueue(home);
  t.after(() => queue.close());
  const topic = `agentbus.changed:${PROJECT}`;
  const { live, first } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  assert.equal(first.type, "same");
  await until(() => f.application.agentbusWatches.directories.size > 0);

  queue.enqueue(message("m1"));
  await changed(live, topic);
  const claim = queue.claim("codex-peer", "owner-1", Date.now(), 30000, 8);
  assert.equal(claim.claimIds.length, 1);
  await changed(live, topic);
  queue.ack("owner-1", claim.claimIds);
  await changed(live, topic);
});

test("reading the queue sends nothing, so a refetch never feeds itself", async (t) => {
  const f = await applicationFixture(t);
  const home = await projectHome(f);
  const queue = openQueue(home);
  t.after(() => queue.close());
  queue.enqueue(message("m1"));
  // The server opens its own handle once (opening touches the files).
  const own = f.application.agentbus.queue(home);
  const topic = `agentbus.changed:${PROJECT}`;
  const { live } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  await until(() => f.application.agentbusWatches.directories.size > 0);
  await delay(300);
  const before = changes(live, topic);
  // What the overview and the message log read: summaries (with their lease
  // reclaim) and rows, through the server's own queue handle.
  for (let index = 0; index < 5; index += 1) {
    own.summary("codex-peer");
    own.rows({ recipient: "codex-peer" });
    queue.summary("codex-peer");
  }
  await delay(800);
  assert.equal(changes(live, topic), before);
});

test("a peer registers, also into a peers folder made after the watch started", async (t) => {
  const f = await applicationFixture(t);
  const home = await projectHome(f);
  const topic = `agentbus.changed:${PROJECT}`;
  const { live } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  await until(() => f.application.agentbusWatches.directories.size > 0);
  // The first peer creates `peers` (seen in the project folder) with an atomic write.
  writeJsonAtomic(path.join(home, "peers", "claude-s1.json"), { key: "claude-s1" });
  await changed(live, topic);
  // The new folder is watched from then on: a second atomic write is seen in it.
  assert.ok(await until(() => f.application.agentbusWatches.directories.size === 2));
  writeJsonAtomic(path.join(home, "peers", "codex-s2.json"), { key: "codex-s2" });
  await changed(live, topic);
  // Another project's queue is not this topic's change.
  const other = await projectHome(f, OTHER);
  await delay(300);
  const before = changes(live, topic);
  const queue = openQueue(other);
  t.after(() => queue.close());
  queue.enqueue(message("elsewhere"));
  await delay(600);
  assert.equal(changes(live, topic), before);
});

test("a project folder deleted and made again is watched again", async (t) => {
  const f = await applicationFixture(t);
  const home = await projectHome(f);
  const topic = `agentbus.changed:${PROJECT}`;
  const { live } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  const watches = f.application.agentbusWatches;
  await until(() => watches.directories.size > 0);
  // While the folder is gone the topic signals on its timer and tries again.
  watches.fallbackMs = 50;
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  // The replaced folder is noticed (a failed or stale handle) and watched anew.
  assert.ok(
    await until(
      () =>
        [...watches.followers][0]?.state === "armed" && watches.directories.size === 1,
    ),
  );
  await delay(200);
  const queue = openQueue(home);
  t.after(() => queue.close());
  const before = changes(live, topic);
  queue.enqueue(message("after"));
  assert.ok(await until(() => changes(live, topic) > before, 3000));
});

test("the overview's topic follows the AgentBus sessions and every project's queue", async (t) => {
  const f = await applicationFixture(t);
  const home = await projectHome(f);
  const sessions = f.application.sessions;
  const list = sessions.list.bind(sessions);
  let extra = [
    {
      id: "bus-one",
      name: "One",
      tool: "codex",
      accountId: "local-codex",
      status: "exited",
      agentbus: { enabled: true, projectId: PROJECT, version: "1" },
    },
  ];
  sessions.list = async (...args) => [...(await list(...args)), ...extra];
  const topic = "agentbus.changed";
  const { live, first } = await subscribed(f, topic);
  t.after(() => live.ws.close());
  assert.equal(first.type, "same");
  await until(() => f.application.agentbusWatches.directories.size > 0);
  const queue = openQueue(home);
  t.after(() => queue.close());
  queue.enqueue(message("m1"));
  await changed(live, topic);
  // An unchanged session list sends nothing; a renamed AgentBus session does.
  await delay(300);
  let before = changes(live, topic);
  await f.application.operationsEvents.poll();
  await delay(300);
  assert.equal(changes(live, topic), before);
  extra = [{ ...extra[0], name: "Renamed" }];
  await f.application.operationsEvents.poll();
  await changed(live, topic);
  // A session of a new project: its folder is watched too.
  const handles = f.application.agentbusWatches.directories.size;
  const second = await projectHome(f, OTHER);
  extra = [
    ...extra,
    { ...extra[0], id: "bus-two", agentbus: { ...extra[0].agentbus, projectId: OTHER } },
  ];
  await f.application.operationsEvents.poll();
  await changed(live, topic);
  assert.ok(
    await until(() => f.application.agentbusWatches.directories.size === handles + 1),
  );
  before = changes(live, topic);
  const queue2 = openQueue(second);
  t.after(() => queue2.close());
  queue2.enqueue(message("m2"));
  assert.ok(await until(() => changes(live, topic) > before));
});

test("one handle per folder is shared and closed with the last subscriber", async (t) => {
  const f = await applicationFixture(t);
  await projectHome(f);
  const watches = f.application.agentbusWatches;
  const topic = `agentbus.changed:${PROJECT}`;
  const one = await subscribed(f, topic);
  const two = await subscribed(f, topic);
  t.after(() => one.live.ws.close());
  t.after(() => two.live.ws.close());
  assert.ok(await until(() => watches.directories.size === 1));
  await delay(100);
  assert.equal(watches.directories.size, 1);
  one.live.send({ op: "unsub", topic });
  two.live.send({ op: "unsub", topic });
  assert.ok(await until(() => watches.directories.size === 0));
});

// A fake fs.watch: each handle is an emitter the test drives.
function fakeWatch() {
  const made = [];
  const watch = (directory) => {
    const handle = new EventEmitter();
    handle.close = () => (handle.closed = true);
    made.push({ directory, handle });
    return handle;
  };
  return { made, watch };
}

test("past the cap or without a watchable folder the topic signals on a timer and retries", async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "bus-watch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "projects", PROJECT), { recursive: true });
  const { made, watch } = fakeWatch();
  const watches = new AgentBusWatches({
    root: () => root,
    sessions: async () => [],
    onSessions: () => () => {},
    watch,
    maxDirectories: 0,
    fallbackMs: 40,
  });
  t.after(() => watches.close());
  let signals = 0;
  const stop = watches.follow(PROJECT, () => (signals += 1));
  await until(() => [...watches.followers][0]?.state === "unwatched");
  // Never reported armed without a live handle: it signals as the former poll did.
  assert.ok(await until(() => signals >= 2, 1000));
  assert.equal(made.length, 0);
  // Room again: the next retry arms it and the timer stops.
  watches.directories.maxDirectories = 8;
  assert.ok(await until(() => [...watches.followers][0]?.state === "armed", 1000));
  assert.ok(made.length > 0);
  await delay(100);
  const settled = signals;
  await delay(150);
  assert.equal(signals, settled);
  stop();
  assert.equal(watches.followers.size, 0);
  assert.equal(watches.directories.size, 0);

  // A project folder that does not exist yet is not watched either.
  const missing = watches.follow(OTHER, () => (signals += 1));
  await until(() => [...watches.followers][0]?.state === "unwatched");
  assert.equal([...watches.followers][0].state, "unwatched");
  missing();
});

test("a handle that fails is closed, signals and is armed again", async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "bus-watch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "projects", PROJECT), { recursive: true });
  const { made, watch } = fakeWatch();
  const watches = new AgentBusWatches({
    root: () => root,
    sessions: async () => [],
    onSessions: () => () => {},
    watch,
  });
  t.after(() => watches.close());
  let signals = 0;
  watches.follow(PROJECT, () => (signals += 1));
  assert.ok(await until(() => [...watches.followers][0]?.state === "armed"));
  assert.equal(made.length, 1);
  // The shared-memory index changes when anyone reads: it is no change.
  made[0].handle.emit("change", "change", "queue.sqlite-shm");
  made[0].handle.emit("change", "change", "launches");
  assert.equal(signals, 0);
  made[0].handle.emit("change", "change", "queue.sqlite-wal");
  assert.equal(signals, 1);
  made[0].handle.emit("error", new Error("gone"));
  assert.equal(made[0].handle.closed, true);
  assert.equal(signals, 2);
  assert.ok(await until(() => made.length === 2 && !made[1].handle.closed));
  made[1].handle.emit("change", "rename", "queue.sqlite");
  assert.equal(signals, 3);
});
