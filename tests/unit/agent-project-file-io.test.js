import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  editFile,
  fileLimits,
  readFile,
  searchFolder,
  writeFile,
} from "../../server/features/assistants/project-files.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-io-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const latin1 = Buffer.from("Gr\xfc\xdfe\n", "latin1");

test("edits and appends refuse files that are not valid UTF-8; reads stay lenient", async (t) => {
  const root = folder(t);
  fs.writeFileSync(path.join(root, "old.txt"), latin1);
  await assert.rejects(
    editFile(root, "old.txt", { oldText: "Gr", newText: "Hallo" }),
    (error) => toolError(error).code === "PROJECT_FILE_ENCODING",
  );
  await assert.rejects(
    appendFile(root, "old.txt", "more\n"),
    (error) => toolError(error).code === "PROJECT_FILE_ENCODING",
  );
  assert.deepEqual(fs.readFileSync(path.join(root, "old.txt")), latin1);
  assert.match((await readFile(root, "old.txt")).content, /^Gr/);
});

test("appends create or extend a file within the total cap and refuse beyond it", async (t) => {
  const root = folder(t);
  assert.deepEqual(await appendFile(root, "log/run.md", "one\n"), {
    path: "log/run.md",
    bytes: 4,
    size: 4,
    created: true,
  });
  const next = await appendFile(root, "log/run.md", "two\n");
  assert.equal(next.size, 8);
  assert.equal(fs.readFileSync(path.join(root, "log/run.md"), "utf8"), "one\ntwo\n");
  fs.writeFileSync(
    path.join(root, "full.md"),
    "x".repeat(fileLimits.appendTotalBytes - 2),
  );
  await assert.rejects(
    appendFile(root, "full.md", "abc"),
    (error) => toolError(error).code === "PROJECT_FILE_UNSUITABLE",
  );
});

test("a write above the byte limit names the limit instead of failing opaquely", async (t) => {
  const root = folder(t);
  // 40,000 characters, 80,000 bytes: below the schema's character limit.
  const content = "ä".repeat(40000);
  assert.throws(
    () => writeFile(root, "big.md", content),
    (error) => toolError(error).code === "PROJECT_WRITE_TOO_LARGE",
  );
  await assert.rejects(
    appendFile(root, "big.md", content),
    (error) => toolError(error).code === "PROJECT_WRITE_TOO_LARGE",
  );
  // The bridge's own request limit reads as too large, not as invalid input.
  assert.equal(
    toolError(Object.assign(Error(), { status: 413 })).code,
    "REQUEST_TOO_LARGE",
  );
});

test(
  "a FIFO is refused at once instead of blocking the server",
  { timeout: 5000 },
  async (t) => {
    const root = folder(t);
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await assert.rejects(
      readFile(root, "pipe"),
      (error) => toolError(error).code === "PROJECT_FILE_UNSUITABLE",
    );
  },
);

test("hard-linked files are neither read nor searched", async (t) => {
  const root = folder(t);
  const outside = folder(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOKEN=1\n");
  fs.linkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
  await assert.rejects(
    readFile(root, "linked.txt"),
    (error) => toolError(error).code === "PROJECT_FILE_UNSUITABLE",
  );
  assert.deepEqual((await searchFolder(root, undefined, "TOKEN")).matches, []);
});

test("search sniffs binaries and counts every byte it reads", async (t) => {
  const root = folder(t);
  const binary = Buffer.alloc(2 * 1048576, 1);
  binary[0] = 0;
  fs.writeFileSync(path.join(root, "a.bin"), binary);
  fs.writeFileSync(path.join(root, "b.log"), "y".repeat(fileLimits.readBytes + 10));
  fs.writeFileSync(path.join(root, "c.txt"), "needle\n");
  const found = await searchFolder(root, undefined, "needle");
  assert.deepEqual(
    found.matches.map((m) => m.path),
    ["c.txt"],
  );
  // The binary and the oversized log are each sniffed, never read in full.
  assert.equal(found.scannedBytes, 8192 + 8192 + 7);
});

test("a line range of a file above 1 MiB is readable with bounded output", async (t) => {
  const root = folder(t);
  const lines = Array.from({ length: 200000 }, (_, i) => `row ${i + 1}`);
  fs.writeFileSync(path.join(root, "data.csv"), lines.join("\n") + "\n");
  assert.ok(fs.statSync(path.join(root, "data.csv")).size > fileLimits.readBytes);
  const read = await readFile(root, "data.csv", { offset: 150000, limit: 3 });
  assert.equal(read.content, "row 150000\nrow 150001\nrow 150002");
  assert.equal(read.truncated, true);
  assert.equal(read.totalLines, null);
  const tail = await readFile(root, "data.csv", { offset: 199999, limit: 10 });
  assert.equal(tail.content, "row 199999\nrow 200000\n");
  assert.equal(tail.truncated, false);
});
