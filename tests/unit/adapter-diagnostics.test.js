import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDiagnosticsWriter,
  writeDiagnostics,
} from "../../server/features/adapter-runtime/adapter-diagnostics.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function counted() {
  let writes = 0;
  return {
    snapshot: () => ({ version: 1, writes: ++writes }),
    writes: () => writes,
  };
}

test("touch writes at most once per interval, flush writes at once", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "diagnostics.json");
  const source = counted();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1_000;
  const advance = (ms) => {
    clock += ms;
    t.mock.timers.tick(ms);
  };
  const writer = createDiagnosticsWriter({
    path: file,
    intervalMs: 50,
    snapshot: source.snapshot,
    now: () => clock,
  });
  // Ten touches within 20 ms: the first schedules an immediate write, the rest wait.
  for (let i = 0; i < 10; i++) {
    writer.touch();
    advance(2);
  }
  assert.equal(source.writes(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, writes: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The touches after the first write are held until the interval has passed.
  advance(31); // the first write ran at 2 ms, so the next is due at 52 ms
  assert.equal(source.writes(), 1);
  advance(1);
  assert.equal(source.writes(), 2);
  // A touch after a quiet interval writes at once.
  advance(60);
  writer.touch();
  advance(0);
  assert.equal(source.writes(), 3);
  // flush replaces a pending write and closes the writer.
  writer.touch();
  await writer.flush();
  assert.equal(source.writes(), 4);
  advance(100);
  writer.touch();
  advance(100);
  assert.equal(source.writes(), 4);
  assert.deepEqual(fs.readdirSync(dir), ["diagnostics.json"]);
});

test("a null path writes nothing", async () => {
  const source = counted();
  const writer = createDiagnosticsWriter({ path: null, snapshot: source.snapshot });
  writer.touch();
  await writer.flush();
  await delay(10);
  assert.equal(source.writes(), 0);
});

test("an unwritable path never throws", async (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const source = counted();
  const writer = createDiagnosticsWriter({
    path: path.join(blocker, "diagnostics.json"),
    intervalMs: 10,
    snapshot: source.snapshot,
  });
  writer.touch();
  await delay(30);
  await writer.flush();
  assert.equal(source.writes(), 2);
  assert.deepEqual(fs.readdirSync(dir), ["file"]);
});

test("flush without any touch writes nothing (an adapter that never served)", async (t) => {
  const dir = tempDir(t);
  const source = counted();
  const writer = createDiagnosticsWriter({
    path: path.join(dir, "s.adapter.json"),
    snapshot: source.snapshot,
  });
  await writer.flush();
  assert.equal(source.writes(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a generation writes only while the session record names it", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "s.adapter.json");
  const record = path.join(dir, "s.json");
  const own = (generation) =>
    fs.writeFileSync(record, JSON.stringify({ id: "s", adapterGeneration: generation }));
  const [a, b] = ["generation-a-0001", "generation-b-0002"];
  own(a);
  assert.equal(writeDiagnostics(file, { n: 1 }, a), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { n: 1 });
  // Reload: the record names the next generation; the old one neither overwrites …
  own(b);
  assert.equal(writeDiagnostics(file, { n: 2 }, a), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { n: 1 });
  // … nor recreates the file the reload deleted.
  fs.rmSync(file);
  assert.equal(writeDiagnostics(file, { n: 3 }, a), false);
  // Removal: no record, no write.
  fs.rmSync(record);
  assert.equal(writeDiagnostics(file, { n: 4 }, b), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  // A writer tagged with a stale generation stays silent, flush included.
  own(b);
  const writer = createDiagnosticsWriter({
    path: file,
    generation: a,
    snapshot: () => ({ n: 5 }),
  });
  writer.touch();
  await writer.flush();
  assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
});
