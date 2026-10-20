import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatSourceWatchPool } from "../../server/features/chat/chat-source-watch-pool.js";
import { watchChatSources } from "../../server/features/chat/chat-source-watch.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-pool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["sessions", "native-sessions", "profile"])
    fs.mkdirSync(path.join(root, dir));
  const registrations = [];
  const pool = new ChatSourceWatchPool({
    watch: (file, options, listener) => {
      const watcher = new EventEmitter();
      const item = { file, options, listener, watcher, closed: false };
      watcher.unref = () => {};
      watcher.close = () => {
        item.closed = true;
      };
      registrations.push(item);
      return watcher;
    },
    ...options,
  });
  const active = () => registrations.filter((r) => !r.closed);
  return { root, pool, registrations, active };
}

test("two chats share metadata watches while each invalidates only its own transcript", async (t) => {
  const f = fixture(t);
  const reports = [0, 0];
  const stops = [0, 1].map((n) => {
    const file = path.join(f.root, `chat-${n}.jsonl`);
    fs.writeFileSync(file, "text");
    const stop = watchChatSources(
      {
        session: { id: `s${n}`, accountId: "a", tool: "codex", cwd: "/project" },
        accounts: { environment: () => ({ CODEX_HOME: path.join(f.root, "profile") }) },
        dataDir: f.root,
        home: f.root,
        sources: () => ({ paths: [file] }),
        pool: f.pool,
        settleMs: 600000,
      },
      () => reports[n]++,
    );
    t.after(stop);
    return stop;
  });
  await Promise.all(stops.map((stop) => stop.refresh()));
  assert.equal(f.active().length, 4, "two directories shared, two exact transcripts");
  reports.fill(0);
  f.active()
    .find((r) => r.file.endsWith("chat-0.jsonl"))
    .listener("change", "chat-0.jsonl");
  assert.deepEqual(reports, [1, 0]);
  f.active()
    .find((r) => r.file === path.join(f.root, "sessions"))
    .listener("rename", "s1.json");
  assert.deepEqual(reports, [1, 1]);
  stops[0]();
  assert.equal(f.active().length, 3, "one chat must not close shared watches");
  stops[1]();
  assert.equal(f.active().length, 0);
  assert.equal(f.pool.entries.size, 0);
});

test("disposing during an outstanding stat never creates a late watcher", async (t) => {
  let release;
  const f = fixture(t, {
    stat: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const file = path.join(f.root, "sessions");
  const stop = f.pool.subscribe({ file, directory: true }, () => assert.fail("disposed"));
  const pending = stop.refresh();
  stop();
  release(fs.statSync(file));
  await pending;
  assert.equal(f.registrations.length, 0);
  assert.equal(f.pool.entries.size, 0);
});

test("repeated disposal cannot remove a newer subscription at the same path", async (t) => {
  const f = fixture(t);
  const target = { file: path.join(f.root, "sessions"), directory: true };
  const first = f.pool.subscribe(target, () => {});
  await first.refresh();
  first();
  const second = f.pool.subscribe(target, () => {});
  t.after(second);
  await second.refresh();
  first();
  assert.equal(f.pool.entries.size, 1);
  assert.equal(f.active().length, 1);
});

test("directory replacement is recovered without rebuilding unrelated watches", async (t) => {
  const f = fixture(t);
  let changes = 0;
  const file = path.join(f.root, "sessions");
  const stop = f.pool.subscribe({ file, directory: true }, () => changes++);
  t.after(stop);
  await stop.refresh();
  const first = f.active()[0];
  assert.equal(changes, 0, "initial registration preserves the current snapshot");
  fs.renameSync(file, path.join(f.root, "old-sessions"));
  fs.mkdirSync(file);
  await stop.refresh();
  assert.equal(first.closed, true);
  assert.equal(f.active().length, 1);
  assert.equal(f.registrations.length, 2);
  assert.equal(changes, 1, "replacement requests a fresh read");
});

test("persistent asynchronous watch errors back off while other watches stay active", async (t) => {
  let now = 10000;
  const f = fixture(t, { now: () => now });
  const stop = f.pool.subscribe(
    { file: path.join(f.root, "sessions"), directory: true },
    () => {},
  );
  const healthy = f.pool.subscribe(
    { file: path.join(f.root, "native-sessions"), directory: true },
    () => {},
  );
  t.after(stop);
  t.after(healthy);
  await Promise.all([stop.refresh(), healthy.refresh()]);
  f.active()
    .find((r) => r.file.endsWith("/sessions"))
    .watcher.emit("error", Error("ENOSPC"));
  for (let i = 0; i < 10; i++) await stop.refresh();
  assert.equal(f.registrations.length, 2, "no immediate failure loop");
  now += 1000;
  await stop.refresh();
  assert.equal(f.registrations.length, 3);
  f.registrations.at(-1).watcher.emit("error", Error("ENOSPC"));
  now += 1000;
  await stop.refresh();
  assert.equal(f.registrations.length, 3, "repeated failure increases the delay");
  now += 1000;
  await stop.refresh();
  assert.equal(f.registrations.length, 4);
  assert.equal(f.active().length, 2, "unrelated observer was retained");
});
