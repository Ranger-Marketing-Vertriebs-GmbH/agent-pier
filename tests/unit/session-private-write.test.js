import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateWrite } from "../../server/features/sessions/session-process-runtime.js";

test("private session writes reject path-shaped filenames before touching disk", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ap-private-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "unchanged");
  for (const filename of [
    "../outside.json",
    outside,
    "child/session.json",
    "..\\outside.json",
    "C:\\outside.json",
    "C:/outside.json",
    "session.json/..",
    "session\0.json",
    ".json",
    "session.txt",
    "session.json.tmp",
    "",
    null,
  ])
    await assert.rejects(privateWrite(directory, filename, "changed"), /filename/);
  assert.equal(await readFile(outside, "utf8"), "unchanged");
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual((await readdir(root)).sort(), ["outside.json", "sessions"]);
});

test("private writes atomically replace only supported session files with private permissions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ap-private-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filenames = [
    "session.json",
    "session.launch.json",
    "session.screen",
    "tmux.conf",
  ];
  for (const filename of filenames) {
    await privateWrite(directory, filename, "first");
    await privateWrite(directory, filename, "second");
    assert.equal(await readFile(path.join(directory, filename), "utf8"), "second");
    assert.equal((await stat(path.join(directory, filename))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(directory)).sort(), filenames.sort());
});
