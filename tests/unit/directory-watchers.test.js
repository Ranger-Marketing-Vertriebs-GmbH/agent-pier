import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DirectoryWatchers } from "../../server/lib/directory-watchers.js";

// A `rename` naming the watched path itself is a deletion only on Linux (inotify's
// IN_DELETE_SELF). macOS FSEvents also reports an in-place write to a watched file and
// a late "created" of a watched folder that way: the handle must stay while the path
// is still the same one. The platform is injected, so these run on every host.

function fixture(t, { platform, kind = "folder", identity = true } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-dirwatch-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, kind === "file" ? "queue.sqlite-wal" : "peers");
  if (kind === "file") fs.writeFileSync(target, "x");
  else fs.mkdirSync(target);
  const stat = fs.statSync(target, { bigint: true });
  const handle = new EventEmitter();
  handle.closed = false;
  handle.close = () => (handle.closed = true);
  const watchers = new DirectoryWatchers({ watch: () => handle, platform });
  const calls = [];
  const release = watchers.add(
    target,
    null,
    (...args) => calls.push(args),
    identity ? `${stat.dev}:${stat.ino}` : null,
  );
  const self = path.basename(target);
  return { target, handle, watchers, calls, release, self };
}

async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(5);
  }
}

for (const kind of ["file", "folder"]) {
  for (const identity of [true, false]) {
    const label = `${kind}${identity ? "" : " without identity"}`;
    test(`macOS: a rename naming the watched ${label} that still exists keeps the handle`, async (t) => {
      const f = fixture(t, { platform: "darwin", kind, identity });
      f.handle.emit("change", "rename", f.self);
      await until(() => f.calls.length > 0);
      await delay(20);
      // Reported once, as the event it is, never as a failed handle.
      assert.deepEqual(f.calls, [[f.self, "rename"]]);
      assert.equal(f.release.alive(), true);
      assert.equal(f.handle.closed, false);
      assert.equal(f.watchers.size, 1);
    });

    test(`macOS: a rename naming the watched ${label} that is gone drops the handle`, async (t) => {
      const f = fixture(t, { platform: "darwin", kind, identity });
      fs.rmSync(f.target, { recursive: true });
      f.handle.emit("change", "rename", f.self);
      await until(() => f.handle.closed);
      assert.deepEqual(f.calls, [[]]);
      assert.equal(f.release.alive(), false);
      assert.equal(f.watchers.size, 0);
    });
  }
}

test("macOS: a watched folder replaced by a new one drops the handle", async (t) => {
  const f = fixture(t, { platform: "darwin" });
  fs.rmSync(f.target, { recursive: true });
  // Another folder under the same path takes a new inode while the old one is held.
  const holder = path.join(path.dirname(f.target), "holder");
  fs.mkdirSync(holder);
  fs.mkdirSync(f.target);
  f.handle.emit("change", "rename", f.self);
  await until(() => f.handle.closed);
  assert.deepEqual(f.calls, [[]]);
  assert.equal(f.release.alive(), false);
});

test("Linux: a rename naming the watched folder itself drops the handle at once", (t) => {
  const f = fixture(t, { platform: "linux" });
  f.handle.emit("change", "rename", f.self);
  // inotify's watch is dead even when a folder of that name exists again.
  assert.equal(f.handle.closed, true);
  assert.deepEqual(f.calls, [[]]);
  assert.equal(f.release.alive(), false);
});
