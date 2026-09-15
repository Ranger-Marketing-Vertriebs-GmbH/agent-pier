import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import {
  extractionZip,
  extractOperation,
  resolveExtract,
} from "../helpers/file-extract.js";

test("global extraction keeps selected symlink/.. source and target semantics", async (t) => {
  const f = await uploadFixture(t),
    lexical = path.join(f.home, "lexical"),
    real = path.join(f.home, "real");
  await fs.mkdir(lexical);
  await fs.mkdir(path.join(real, "child"), { recursive: true });
  await fs.mkdir(path.join(real, "target"));
  await fs.mkdir(path.join(lexical, "target"));
  await fs.symlink(path.join(real, "child"), path.join(lexical, "alias"));
  await fs.writeFile(
    path.join(real, "input.zip"),
    extractionZip([{ name: "chosen", bytes: "native" }]),
  );
  await fs.writeFile(
    path.join(lexical, "input.zip"),
    extractionZip([{ name: "wrong", bytes: "lexical" }]),
  );
  const selected = lexical + "/alias/..";
  const job = await f.jobs.start(
    f.scope,
    extractOperation(selected + "/input.zip", selected + "/target"),
  );
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.equal(await fs.readFile(path.join(real, "target/chosen"), "utf8"), "native");
  assert.deepEqual(await fs.readdir(path.join(lexical, "target")), []);
  assert.ok(
    f.jobs
      .entries(f.scope, job.id)
      .entries.every((row) => row.path.startsWith(selected + "/target/")),
  );
});

test("extract publishes multiple original roots only after validating every ZIP entry", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "hällo.txt", bytes: "hello" },
      "empty/",
      { name: "nested/child.txt", bytes: "child", deflate: true },
    ]),
  );
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.project, "hällo.txt"), "utf8"), "hello");
  assert.equal(
    await fs.readFile(path.join(f.project, "nested/child.txt"), "utf8"),
    "child",
  );
  assert.deepEqual(await fs.readdir(path.join(f.project, "empty")), []);
  assert.equal((await fs.stat(path.join(f.project, "hällo.txt"))).mode & 0o7777, 0o600);
  assert.equal((await fs.stat(path.join(f.project, "nested"))).mode & 0o7777, 0o700);
});

for (const entry of [
  { name: "../escape" },
  { name: "/absolute" },
  { name: "C:/drive" },
  { name: "a\\escape" },
  { name: "link", mode: 0o120777 },
  { name: "fifo", mode: 0o010600 },
  { name: "secret", flags: 1 },
  { name: "good", bytes: "duplicate" },
  { name: "good/child" },
  { name: "bad-crc", bytes: "CRC must be checked", corrupt: true },
  { name: "bomb", bytes: "x".repeat(1000), deflate: true, size: 1 },
  { name: "header", localFlags: 1 },
  { name: "invalid-utf8", rawName: [0xff] },
])
  test(`late invalid ZIP entry ${JSON.stringify(entry)} publishes nothing`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(path.join(f.project, "sentinel"), "old");
    await fs.writeFile(source, extractionZip([{ name: "good", bytes: "safe" }, entry]));
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
    assert.deepEqual(await fs.readdir(f.project), ["sentinel"]);
    assert.equal(await fs.readFile(path.join(f.project, "sentinel"), "utf8"), "old");
  });

test("extraction merges existing directories, replaces through Trash and preserves fixed creation modes", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  const target = path.join(f.project, "folder");
  await fs.mkdir(target, { mode: 0o750 });
  await fs.writeFile(path.join(target, "same"), "previous");
  const before = await fs.stat(target);
  await fs.writeFile(
    source,
    extractionZip([
      { name: "folder/same", bytes: "new", mode: 0o106777 },
      { name: "folder/next", bytes: "next" },
    ]),
  );
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  await resolveExtract(f, job, "merge");
  await resolveExtract(f, job, "replace");
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal((await fs.stat(target)).ino, before.ino);
  assert.equal((await fs.stat(target)).mode, before.mode);
  assert.equal(await fs.readFile(path.join(target, "same"), "utf8"), "new");
  assert.equal((await fs.stat(path.join(target, "same"))).mode & 0o7777, 0o600);
  assert.equal((await f.trash.list(f.scope)).entries.length, 1);
  assert.equal(result.completedEntries, 3);
  assert.ok(f.jobs.entries(f.scope, job.id).entries.every((row) => row.outputPublished));
});

test("keep-both and skip choices are resolved before output and corrupt skipped bytes still fail", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(path.join(f.project, "a"), "original");
  await fs.writeFile(path.join(f.project, "bad"), "original");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "a", bytes: "new" },
      { name: "bad", bytes: "corrupt", corrupt: true },
    ]),
  );
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  await resolveExtract(f, job, "keep_both");
  await resolveExtract(f, job, "skip");
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
  assert.deepEqual(await fs.readdir(f.project), ["a", "bad"]);
});

for (const limits of [
  { jobBytes: 5 },
  { uploadBytes: 2 },
  { jobEntries: 2 },
  { maxDepth: 1 },
])
  test(`extraction preflights configured limits ${JSON.stringify(limits)}`, async (t) => {
    const f = await uploadFixture(t, limits),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(
      source,
      extractionZip([
        { name: "a", bytes: "123" },
        { name: "b/c", bytes: "456" },
      ]),
    );
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    const result = await f.jobs.join(f.scope, job.id);
    assert.equal(result.status, "failed");
    assert.equal(result.issue.code, "FILE_LIMIT_EXCEEDED");
    assert.deepEqual(await fs.readdir(f.project), []);
  });
