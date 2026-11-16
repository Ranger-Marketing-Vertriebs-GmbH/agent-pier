import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStopStore } from "../../server/features/chat/task-stop-store.js";

function dataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-stops-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const s1 = { id: "s1" };

test("stops live in an AgentPier-only folder, not in the session's native folder", (t) => {
  const dir = dataDir(t);
  fs.mkdirSync(path.join(dir, "native-sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "native-sessions", "s1", "s1.launch.json"), "{}");
  const store = new TaskStopStore({ dataDir: dir });
  store.record(s1, { id: "a", kind: "agent", at: 1 });
  assert.ok(fs.existsSync(path.join(dir, "task-stops", "s1.json")));
  assert.deepEqual(fs.readdirSync(path.join(dir, "native-sessions", "s1")), [
    "s1.launch.json",
  ]);
  assert.equal(fs.statSync(path.join(dir, "task-stops")).mode & 0o077, 0);
  assert.equal(new TaskStopStore({ dataDir: dir }).has(s1, "a"), true);
});

test("forget removes the file and the cached stops", (t) => {
  const dir = dataDir(t);
  const store = new TaskStopStore({ dataDir: dir });
  store.record(s1, { id: "a", kind: "agent", at: 1 });
  store.forget("s1");
  assert.equal(fs.existsSync(path.join(dir, "task-stops", "s1.json")), false);
  assert.equal(store.has(s1, "a"), false);
  assert.equal(new TaskStopStore({ dataDir: dir }).has(s1, "a"), false);
});

test("an invalid session id never becomes a path", (t) => {
  const dir = dataDir(t);
  const store = new TaskStopStore({ dataDir: dir });
  for (const id of ["../x", "a/b", "", ".hidden", "x".repeat(81), 5, null]) {
    assert.equal(store.has({ id }, "a"), false);
    assert.throws(() => store.record({ id }, { id: "a", kind: "agent", at: 1 }));
    assert.doesNotThrow(() => store.forget(id));
  }
  assert.equal(fs.existsSync(path.join(dir, "task-stops")), false);
  assert.equal(fs.existsSync(path.join(dir, "x.json")), false);
});

test("at most 100 stops are kept", (t) => {
  const dir = dataDir(t);
  const store = new TaskStopStore({ dataDir: dir });
  for (let i = 0; i < 105; i += 1)
    store.record(s1, { id: `t${i}`, kind: "shell", at: i });
  const saved = JSON.parse(
    fs.readFileSync(path.join(dir, "task-stops", "s1.json"), "utf8"),
  );
  assert.equal(saved.stops.length, 100);
  assert.equal(saved.stops[0].id, "t5");
});
