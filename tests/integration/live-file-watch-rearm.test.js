import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { FileWatches } from "../../server/features/files/file-watch-topic.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";

// Task 5.2 fix round: a watch handle that fails or outlives its folder is replaced, a
// file that cannot be watched again reads `watched: false` (the editor polls) and is
// retried, and a read whose resolved file lies in the data directory is refused.

const owner = { role: "owner" };

function fixture(t, { metadata, retryMs } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rearm-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(home, "sub"), { recursive: true });
  fs.mkdirSync(data);
  const file = path.join(home, "sub", "a.txt");
  fs.writeFileSync(file, "a");
  const handles = [];
  const control = { fail: false };
  const watch = (directory) => {
    if (control.fail) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    const handle = new EventEmitter();
    Object.assign(handle, {
      directory,
      closed: false,
      close: () => (handle.closed = true),
    });
    handles.push(handle);
    return handle;
  };
  const watches = new FileWatches({
    dataDir: data,
    context: () => makeFileScope({ home }),
    metadata: metadata || (async (_scope, target) => ({ path: target, ok: true })),
    watch,
    ...(retryMs ? { retryMs } : {}),
  });
  t.after(() => watches.close());
  const open = () => handles.filter((handle) => !handle.closed);
  return { root, home, data, file, handles, open, control, watches };
}

async function followed(f) {
  const scope = await makeFileScope({ home: f.home });
  const token = (await f.watches.register(owner, scope, f.file)).slice(
    "file.meta:".length,
  );
  const calls = { invalidations: 0 };
  const stop = f.watches.follow(token, () => (calls.invalidations += 1));
  const follower = () => f.watches.tokens.get(token).follower;
  await until(() => follower().state !== "arming");
  return { token, calls, stop, follower };
}

async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(5);
  }
}

test("a failing handle is replaced, and a change on the new one reads again", async (t) => {
  const f = fixture(t);
  const { token, calls, follower } = await followed(f);
  assert.equal(f.open().length, 1);
  f.open()[0].emit("error", new Error("boom"));
  await until(() => f.open().length === 1 && f.handles.length === 2);
  assert.equal(follower().state, "armed");
  assert.equal(f.watches.directories.size, 1);
  const before = calls.invalidations;
  f.open()[0].emit("change", "change", "a.txt");
  assert.ok(calls.invalidations > before);
  assert.equal((await f.watches.read(token)).watched, true);
});

test("a handle that cannot be replaced reads unwatched, then is retried", async (t) => {
  const f = fixture(t, { retryMs: 50 });
  const { token, follower } = await followed(f);
  f.control.fail = true;
  f.open()[0].emit("error", new Error("boom"));
  await until(() => follower().state === "unwatched");
  // Never armed without a live handle: the editor is told to poll.
  assert.equal(f.open().length, 0);
  assert.equal((await f.watches.read(token)).watched, false);
  f.control.fail = false;
  await until(() => follower().state === "armed");
  assert.equal(f.open().length, 1);
  assert.equal((await f.watches.read(token)).watched, true);
});

// Deleting the watched folder, as each platform reports it: inotify (Linux) a rename
// naming the folder itself, then a dead handle that may close by itself; FSEvents
// (macOS) keeps following the path, so only a later rename is seen. Linux often
// gives the re-created folder the same inode number.
for (const [shape, report] of [
  ["a rename of the folder itself", (handle) => handle.emit("change", "rename", "sub")],
  ["a handle that closes by itself", (handle) => handle.emit("close")],
  ["a rename without a name", (handle) => handle.emit("change", "rename", null)],
]) {
  test(`a folder deleted and created again gets a new handle: ${shape}`, async (t) => {
    const f = fixture(t);
    const { follower } = await followed(f);
    const [first] = f.open();
    const sub = path.dirname(f.file);
    fs.rmSync(sub, { recursive: true });
    fs.mkdirSync(sub);
    fs.writeFileSync(f.file, "b");
    report(first);
    await until(() => first.closed && f.open().length === 1);
    assert.notEqual(f.open()[0], first);
    assert.equal(follower().state, "armed");
    assert.equal(f.watches.directories.size, 1);
  });
}

test("a read whose resolved file lies in the data directory is refused", async (t) => {
  const holder = {};
  const f = fixture(t, {
    // The file was swapped for a link into the data directory after the check.
    metadata: async (_scope, target) => ({
      path: target,
      resolvedPath: path.join(holder.data, "secret.txt"),
      metadataRevision: `e1:${"a".repeat(64)}`,
    }),
  });
  holder.data = f.data;
  fs.writeFileSync(path.join(f.data, "secret.txt"), "x");
  const { token } = await followed(f);
  assert.deepEqual(await f.watches.read(token), {
    path: f.file,
    error: { code: "FILE_PROTECTED_PATH", status: 403 },
    watched: true,
  });
});

test("a handle on a file (the AgentBus log) survives a check of its own identity", async (t) => {
  const { DirectoryWatchers } = await import("../../server/lib/directory-watchers.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-rearm-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "queue.sqlite-wal");
  fs.writeFileSync(file, "x");
  const stat = fs.statSync(file, { bigint: true });
  const handle = new EventEmitter();
  handle.close = () => (handle.closed = true);
  const watchers = new DirectoryWatchers({ watch: () => handle });
  const release = watchers.add(file, null, () => {}, `${stat.dev}:${stat.ino}`);
  handle.emit("change", "rename", null);
  await delay(50);
  assert.equal(release.alive(), true);
  assert.equal(handle.closed, undefined);
});
