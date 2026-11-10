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
import { hangGuard } from "../helpers/hang-guard.js";

// Task 5.3: `agentbus.changed[:<projectId>]`, a signal topic. The project's queue
// folder is watched (the queue database, its write-ahead log and the peers), so a
// message, a claim, an acknowledgement or a peer registration sends `changed`; the
// overview's bare topic also follows the AgentBus sessions. Nothing the server only
// reads sends anything.
//
// The waits follow the watches' own progress instead of a wall-clock budget a loaded
// host can exhaust; a wait without any progress fails after half the hang guard and
// names what it waited for and what the watches saw.

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
  await live.next((frame) => frame.type === "hello", PROGRESS_MS);
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, PROGRESS_MS);
  return { live, first };
}

const changed = (live, topic) =>
  live.next((frame) => frame.topic === topic && frame.type === "changed", PROGRESS_MS);
const changes = (live, topic) =>
  live.frames.filter((frame) => frame.topic === topic && frame.type === "changed").length;

// A wait that makes no progress fails after half the hang guard, so the failure names
// what was awaited and what the watches saw instead of "test timed out".
const PROGRESS_MS = hangGuard.timeout / 2;

// What the topic watches and what its handles reported last (`seen` of watchesOf).
function watchState(f, seen) {
  const watches = f.application.agentbusWatches;
  const root = f.application.agentbus.root;
  const short = (target) => path.relative(root, String(target));
  return [
    "",
    `watched: ${JSON.stringify([...watches.directories.folders.values()].map((folder) => [short(folder.directory), [...folder.names.keys()]]))}`,
    `followers: ${JSON.stringify([...watches.followers].map((follower) => follower.state))}`,
    ...(seen
      ? [
          `signals: ${seen.count}, names: ${JSON.stringify(seen.names.slice(-12))}`,
          `last folder events: ${JSON.stringify(seen.events.slice(-12).map(([folder, name]) => [short(folder), name]))}`,
        ]
      : []),
  ].join("\n");
}

// Polls until `predicate` holds. Without progress it fails with what it waited for
// and `state()`, and leaves no loop behind.
async function until(predicate, waitingFor = "the condition", state = () => "") {
  const deadline = Date.now() + PROGRESS_MS;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `no progress in ${PROGRESS_MS} ms waiting for ${waitingFor}${state()}`,
      );
    await delay(10);
  }
  return true;
}

// Until the topic watches `directory` (any folder when undefined) and a file's handle
// reports. On macOS fs.watch registers a file's kqueue watch only in the event loop's
// next poll phase, so a write made before it (the queue's log right after its handle
// is added) is never reported; two turns of the loop always pass that poll phase.
async function watching(f, directory) {
  const { directories } = f.application.agentbusWatches;
  await until(
    () =>
      [...directories.folders.values()].some(
        (folder) => directory === undefined || folder.directory === directory,
      ),
    `a watch of ${directory ?? "any folder"}`,
    () => watchState(f),
  );
  for (let turn = 0; turn < 2; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

// What the topic's watches see: its signals as they raise them (before the hub's
// debounce and the socket), the names that reached it and every folder event with its
// folder. Installed before subscribing.
function watchesOf(f) {
  const watches = f.application.agentbusWatches;
  const seen = { count: 0, names: [], events: [] };
  const follow = watches.follow.bind(watches);
  watches.follow = (projectId, signal) =>
    follow(projectId, () => {
      seen.count += 1;
      signal();
    });
  const changedName = watches.changed.bind(watches);
  watches.changed = (follower, filename, type) => {
    seen.names.push(filename);
    return changedName(follower, filename, type);
  };
  const { directories } = watches;
  const changedFolder = directories.changed.bind(directories);
  directories.changed = (folder, type, filename) => {
    seen.events.push([folder.directory, filename]);
    return changedFolder(folder, type, filename);
  };
  return seen;
}

// Until the topic's handle of `directory` reports. macOS starts a folder's watch
// (FSEvents) some time after fs.watch returned and reports nothing made before:
// `.probe`, a name the topic ignores, is touched until its event is in.
async function reporting(f, seen, directory) {
  await watching(f, directory);
  const probe = path.join(directory, ".probe");
  const from = seen.events.length;
  const reported = () =>
    seen.events
      .slice(from)
      .some(([folder, name]) => folder === directory && name === ".probe");
  let round = 0;
  const writes = [];
  await until(
    () => {
      if (!reported())
        writes.push(fs.writeFile(probe, String((round += 1))).catch(() => {}));
      return reported();
    },
    `the watch of ${directory} to report .probe`,
    () => `\nprobes written: ${round}${watchState(f, seen)}`,
  );
  // No probe is written once this returns: in `peers` every name signals.
  await Promise.all(writes);
}

// macOS reports a folder's events in order but late, also of files made just before
// its watch started. A peer registered in `home` is reported after all of them: once
// its event is in and no re-arm is running, nothing earlier can still signal.
//
// The `peers` folder must be there and reporting (see `reporting`). A peer that makes
// the folder is no such mark: the topic then starts a watch of the new folder, which
// reports the peer's own files some time later, and when a re-arm already running
// found the folder first, macOS may never report the folder being made at all.
async function reported(f, seen, home, name) {
  const from = seen.names.length;
  writeJsonAtomic(path.join(home, "peers", `${name}.json`), { key: name });
  await until(
    () => seen.names.slice(from).includes(`${name}.json`),
    `the topic to see ${name}.json in peers`,
    () => watchState(f, seen),
  );
  const { followers } = f.application.agentbusWatches;
  await until(
    () => [...followers].every((follower) => !follower.arming && !follower.again),
    "the topic's re-arms to end",
    () => watchState(f, seen),
  );
}

// What reached the topic since `from`, for the message of a failed count.
const since = (seen, from) => `names since: ${JSON.stringify(seen.names.slice(from))}`;

test(
  "a message, a claim and an acknowledgement in the queue send changed",
  hangGuard,
  async (t) => {
    const f = await applicationFixture(t);
    const home = await projectHome(f);
    const queue = openQueue(home);
    t.after(() => queue.close());
    const topic = `agentbus.changed:${PROJECT}`;
    const { live, first } = await subscribed(f, topic);
    t.after(() => live.ws.close());
    assert.equal(first.type, "same");
    await watching(f);

    queue.enqueue(message("m1"));
    await changed(live, topic);
    const claim = queue.claim("codex-peer", "owner-1", Date.now(), 30000, 8);
    assert.equal(claim.claimIds.length, 1);
    await changed(live, topic);
    queue.ack("owner-1", claim.claimIds);
    await changed(live, topic);
  },
);

test(
  "reading the queue sends nothing, so a refetch never feeds itself",
  hangGuard,
  async (t) => {
    const f = await applicationFixture(t);
    const home = await projectHome(f);
    const peers = path.join(home, "peers");
    await fs.mkdir(peers, { mode: 0o700 });
    const queue = openQueue(home);
    t.after(() => queue.close());
    queue.enqueue(message("m1"));
    // The server opens its own handle once (opening touches the files).
    const own = f.application.agentbus.queue(home);
    const topic = `agentbus.changed:${PROJECT}`;
    const seen = watchesOf(f);
    const { live } = await subscribed(f, topic);
    t.after(() => live.ws.close());
    await reporting(f, seen, home);
    await reporting(f, seen, peers);
    await reported(f, seen, home, "claude-s1");
    const before = seen.count;
    const from = seen.names.length;
    // What the overview and the message log read: summaries (with their lease
    // reclaim) and rows, through the server's own queue handle.
    for (let index = 0; index < 5; index += 1) {
      own.summary("codex-peer");
      own.rows({ recipient: "codex-peer" });
      queue.summary("codex-peer");
    }
    await delay(800);
    assert.equal(seen.count, before, since(seen, from));
  },
);

test(
  "a peer registers, also into a peers folder made after the watch started",
  hangGuard,
  async (t) => {
    const f = await applicationFixture(t);
    const home = await projectHome(f);
    const topic = `agentbus.changed:${PROJECT}`;
    const seen = watchesOf(f);
    const { live } = await subscribed(f, topic);
    t.after(() => live.ws.close());
    await reporting(f, seen, home);
    // The first peer creates `peers` (seen in the project folder) with an atomic write.
    writeJsonAtomic(path.join(home, "peers", "claude-s1.json"), { key: "claude-s1" });
    await changed(live, topic);
    // The new folder is watched from then on: a second atomic write is seen in it.
    // Written again until it is seen: the new folder's watch starts some time later.
    await watching(f, path.join(home, "peers"));
    await until(() => {
      if (seen.names.includes("codex-s2.json")) return true;
      writeJsonAtomic(path.join(home, "peers", "codex-s2.json"), { key: "codex-s2" });
      return false;
    });
    await changed(live, topic);
    // Another project's queue is not this topic's change.
    const other = await projectHome(f, OTHER);
    await reported(f, seen, home, "claude-s3");
    const before = seen.count;
    const from = seen.names.length;
    const queue = openQueue(other);
    t.after(() => queue.close());
    queue.enqueue(message("elsewhere"));
    await delay(600);
    assert.equal(seen.count, before, since(seen, from));
  },
);

test("a project folder deleted and made again is watched again", hangGuard, async (t) => {
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
  assert.ok(await until(() => changes(live, topic) > before));
});

test(
  "the overview's topic follows the AgentBus sessions and every project's queue",
  hangGuard,
  async (t) => {
    const f = await applicationFixture(t);
    const home = await projectHome(f);
    const peers = path.join(home, "peers");
    await fs.mkdir(peers, { mode: 0o700 });
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
    const seen = watchesOf(f);
    // A listing after this call (one already running may have read the old list).
    const listed = async () => {
      await f.application.operationsEvents.poll();
      await f.application.operationsEvents.poll();
    };
    const { live, first } = await subscribed(f, topic);
    t.after(() => live.ws.close());
    assert.equal(first.type, "same");
    await reporting(f, seen, home);
    await reporting(f, seen, peers);
    const queue = openQueue(home);
    t.after(() => queue.close());
    queue.enqueue(message("m1"));
    await changed(live, topic);
    // An unchanged session list sends nothing; a renamed AgentBus session does.
    await reported(f, seen, home, "claude-s1");
    let before = seen.count;
    const from = seen.names.length;
    await listed();
    assert.equal(seen.count, before, since(seen, from));
    extra = [{ ...extra[0], name: "Renamed" }];
    await listed();
    assert.equal(seen.count, before + 1, since(seen, from));
    await changed(live, topic);
    // A session of a new project: its folder is watched too.
    const second = await projectHome(f, OTHER);
    extra = [
      ...extra,
      {
        ...extra[0],
        id: "bus-two",
        agentbus: { ...extra[0].agentbus, projectId: OTHER },
      },
    ];
    await listed();
    await changed(live, topic);
    await reporting(f, seen, second);
    before = changes(live, topic);
    const queue2 = openQueue(second);
    t.after(() => queue2.close());
    queue2.enqueue(message("m2"));
    assert.ok(await until(() => changes(live, topic) > before));
  },
);

test(
  "one handle per folder is shared and closed with the last subscriber",
  hangGuard,
  async (t) => {
    const f = await applicationFixture(t);
    const home = await projectHome(f);
    const watches = f.application.agentbusWatches;
    const seen = watchesOf(f);
    const topic = `agentbus.changed:${PROJECT}`;
    const one = await subscribed(f, topic);
    const two = await subscribed(f, topic);
    t.after(() => one.live.ws.close());
    t.after(() => two.live.ws.close());
    // macOS may still report the folder being made, which renews its handle; a later
    // event of the folder is reported after it.
    await reporting(f, seen, home);
    assert.ok(await until(() => watches.directories.size === 1));
    await delay(100);
    assert.equal(watches.directories.size, 1);
    one.live.send({ op: "unsub", topic });
    two.live.send({ op: "unsub", topic });
    assert.ok(await until(() => watches.directories.size === 0));
  },
);

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

test(
  "past the cap the topic signals on a timer, logs once and retries",
  hangGuard,
  async (t) => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    t.after(() => (console.warn = warn));
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
    assert.ok(await until(() => signals >= 2));
    assert.equal(made.length, 0);
    // The cap is logged once, however often the retry meets it.
    assert.equal(warnings.filter((line) => line.includes("AgentBus folders")).length, 1);
    // Room again: the next retry arms it and the timer stops.
    watches.directories.maxDirectories = 8;
    assert.ok(await until(() => [...watches.followers][0]?.state === "armed"));
    assert.ok(made.length > 0);
    await delay(100);
    const settled = signals;
    await delay(150);
    assert.equal(signals, settled);
    stop();
    assert.equal(watches.followers.size, 0);
    assert.equal(watches.directories.size, 0);

    // A project folder that does not exist yet is awaited in the projects folder,
    // filtered to its id, instead of signalling on a timer.
    const projects = path.join(root, "projects");
    const before = made.length;
    let waiting = 0;
    const missing = watches.follow(OTHER, () => (waiting += 1));
    assert.ok(await until(() => [...watches.followers][0]?.state === "armed"));
    assert.deepEqual(
      made.slice(before).map(({ directory }) => directory),
      [projects],
    );
    const parent = made.at(-1).handle;
    await delay(150);
    assert.equal(waiting, 0);
    parent.emit("change", "rename", PROJECT);
    assert.equal(waiting, 0);
    await fs.mkdir(path.join(projects, OTHER));
    parent.emit("change", "rename", OTHER);
    assert.equal(waiting, 1);
    assert.ok(
      await until(() =>
        made.some(
          ({ directory, handle }) =>
            directory === path.join(projects, OTHER) && !handle.closed,
        ),
      ),
    );
    assert.ok(await until(() => parent.closed === true));
    missing();
  },
);

test(
  "a handle that fails is closed, signals and is armed again",
  hangGuard,
  async (t) => {
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
    // A write signals but keeps the handles: only a rename re-arms.
    let arms = 0;
    const arm = watches.arm.bind(watches);
    watches.arm = (...args) => {
      arms += 1;
      return arm(...args);
    };
    made[0].handle.emit("change", "change", "queue.sqlite-wal");
    assert.equal(signals, 1);
    assert.equal(arms, 0);
    made[0].handle.emit("change", "rename", "queue.sqlite-wal");
    assert.equal(signals, 2);
    assert.equal(arms, 1);
    await delay(50);
    made[0].handle.emit("error", new Error("gone"));
    assert.equal(made[0].handle.closed, true);
    assert.equal(signals, 3);
    assert.ok(await until(() => made.length === 2 && !made[1].handle.closed));
    made[1].handle.emit("change", "rename", "queue.sqlite");
    assert.equal(signals, 4);
  },
);
