import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { watchChatSources } from "../../server/features/chat/chat-source-watch.js";

function sources(t, settleMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  let changes = 0;
  const unwatch = watchChatSources(
    {
      session: { id: "s", accountId: "a", tool: "codex" },
      accounts: { environment: () => ({ HOME: home }) },
      dataDir: path.join(root, "data"),
      home,
      settleMs,
    },
    () => changes++,
  );
  t.after(unwatch);
  return { unwatch, changes: () => changes };
}

test("watchers re-check once after arming so a write during startup is not missed", async (t) => {
  const watch = sources(t, 20);
  assert.equal(watch.changes(), 0);
  await delay(120);
  assert.equal(watch.changes(), 1);
});

test("disposing the watchers cancels the startup re-check", async (t) => {
  const watch = sources(t, 20);
  watch.unwatch();
  await delay(120);
  assert.equal(watch.changes(), 0);
});

function targeted(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["sessions", "native-sessions", "profile", "transcripts"])
    fs.mkdirSync(path.join(root, name));
  const file = path.join(root, "transcripts", "one.jsonl");
  fs.writeFileSync(file, "one");
  const state = { paths: [file], readAt: Date.now() };
  const registrations = [];
  let changes = 0;
  const stop = watchChatSources(
    {
      session: { id: "s", accountId: "a", tool: "claude", cwd: "/project" },
      accounts: {
        environment: () => ({ CLAUDE_CONFIG_DIR: path.join(root, "profile") }),
      },
      dataDir: root,
      home: root,
      sources: () => state,
      settleMs: 600000,
      watch: (file, options, listener) => {
        const watcher = new EventEmitter();
        const item = { file, options, listener, closed: false, watcher };
        watcher.unref = () => {};
        watcher.close = () => {
          item.closed = true;
        };
        registrations.push(item);
        return watcher;
      },
    },
    () => changes++,
  );
  t.after(stop);
  return {
    root,
    file,
    state,
    registrations,
    stop,
    changes: () => changes,
    refresh: () => stop.refresh?.(),
  };
}

test("known sources watch their files without recursively subscribing to the profile", async (t) => {
  const f = targeted(t);
  await f.refresh();
  const active = () => f.registrations.filter((r) => !r.closed);
  assert.ok(
    active().some((r) => r.file === f.file),
    "the actual transcript is watched",
  );
  assert.ok(!active().some((r) => r.file === path.join(f.root, "profile")));
  const first = f.registrations.length;
  await f.refresh();
  await f.refresh();
  assert.equal(f.registrations.length, first, "healthy watches survive recovery");
  const before = f.changes();
  active()
    .find((r) => r.file === f.file)
    .listener("change", "one.jsonl");
  assert.equal(f.changes(), before + 1);
  const metadata = active().find((r) => r.file === path.join(f.root, "sessions"));
  metadata.listener("change", "other.json");
  assert.equal(f.changes(), before + 1, "another session cannot invalidate this chat");
  metadata.listener("change", "s.json");
  assert.equal(f.changes(), before + 2);
});

test("an atomic transcript replacement rearms only that file", async (t) => {
  const f = targeted(t);
  await f.refresh();
  const first = f.registrations.find((r) => r.file === f.file);
  assert.ok(first, "transcript registered");
  const count = f.registrations.length;
  const replacement = path.join(f.root, "replacement");
  fs.writeFileSync(replacement, "two");
  fs.renameSync(replacement, f.file);
  await f.refresh();
  assert.equal(first.closed, true);
  assert.equal(f.registrations.length, count + 1);
  assert.equal(f.registrations.at(-1).file, f.file);
  const before = f.changes();
  first.listener("change", "one.jsonl");
  assert.equal(f.changes(), before, "late callbacks of retired watches are ignored");
});

test("missing WAL files are watched when created and failed watches recover", async (t) => {
  const f = targeted(t);
  const wal = f.file + "-wal";
  f.state.paths.push(wal);
  await f.refresh();
  assert.ok(!f.registrations.some((r) => r.file === wal));
  fs.writeFileSync(wal, "wal");
  await f.refresh();
  const first = f.registrations.find((r) => r.file === wal);
  assert.ok(first, "new WAL discovered without a directory event");
  first.watcher.emit("error", Error("lost watch"));
  await delay(1100);
  await f.refresh();
  assert.equal(first.closed, true);
  assert.equal(f.registrations.filter((r) => r.file === wal && !r.closed).length, 1);
});

test("switching source paths releases the old transcript and disposal stops recovery", async (t) => {
  const f = targeted(t);
  await f.refresh();
  const second = path.join(f.root, "transcripts", "two.jsonl");
  fs.writeFileSync(second, "two");
  f.state.paths = [second];
  await f.refresh();
  assert.ok(f.registrations.some((r) => r.file === f.file && r.closed));
  assert.ok(f.registrations.some((r) => r.file === second && !r.closed));
  f.stop();
  const count = f.registrations.length;
  await f.refresh();
  assert.equal(f.registrations.length, count);
  assert.ok(f.registrations.every((r) => r.closed));
});
