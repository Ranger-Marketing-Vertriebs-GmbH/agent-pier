import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  caseInsensitiveTarget,
  localRoot,
  openLocalSource,
  walkLocal,
  writeLocal,
} from "../../server/features/sftp/sftp-local.js";
import { excludeList } from "../../server/features/sftp/sftp-excludes.js";
import { sftpLimits } from "../../server/features/sftp/sftp-limits.js";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sftp-local-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(project, "src", "deep"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, "src", "a.txt"), "alpha");
  fs.writeFileSync(path.join(project, "src", "deep", "b.txt"), "bravo!");
  fs.writeFileSync(path.join(outside, "secret"), "secret");
  return { base, project, outside };
}
const parts = (dir) => fs.readdirSync(dir).filter((n) => n.includes("agentpier-part"));

test("walkLocal lists regular files with relative POSIX paths", async (t) => {
  const { project } = fixture(t);
  fs.mkdirSync(path.join(project, "src", ".git"));
  fs.writeFileSync(path.join(project, "src", ".git", "config"), "x");
  fs.writeFileSync(path.join(project, "src", ".env"), "TOKEN=1");
  const target = localRoot({ root: project, raw: "src" });
  const { entries, skipped } = await walkLocal(target, { excludes: excludeList() });
  assert.deepEqual(
    entries.map((e) => [e.path, e.size]),
    [
      ["a.txt", 5],
      ["deep/b.txt", 6],
    ],
  );
  assert.equal(typeof entries[0].mtimeMs, "number");
  assert.deepEqual(skipped, { links: 0, special: 0, unsafe: 0 });
  const all = await walkLocal(target, { excludes: excludeList([], { defaults: false }) });
  assert.deepEqual(
    all.entries.map((e) => e.path),
    [".env", "a.txt", "deep/b.txt"],
    ".git stays hidden even without default excludes",
  );
});

test("link out of the root is skipped", async (t) => {
  const { project, outside } = fixture(t);
  fs.symlinkSync(path.join(outside, "secret"), path.join(project, "src", "out"));
  fs.symlinkSync(outside, path.join(project, "src", "outdir"));
  fs.linkSync(path.join(outside, "secret"), path.join(project, "src", "hard"));
  const target = localRoot({ root: project, raw: "src" });
  const { entries, skipped } = await walkLocal(target, { excludes: [] });
  assert.deepEqual(
    entries.map((e) => e.path),
    ["a.txt", "deep/b.txt"],
  );
  assert.deepEqual(skipped, { links: 3, special: 0, unsafe: 0 });
  await assert.rejects(openLocalSource(target, "out"), { status: 403 });
  await assert.rejects(openLocalSource(target, "hard"), { code: "SFTP_PATH_REFUSED" });
  await assert.rejects(openLocalSource(target, "outdir/secret"), { status: 403 });
  await assert.rejects(openLocalSource(target, "../../outside/secret"), {
    code: "SFTP_PATH_REFUSED",
  });
  const handle = await openLocalSource(target, "deep/b.txt");
  try {
    assert.equal((await handle.readFile()).toString(), "bravo!");
  } finally {
    await handle.close();
  }
});

test("walkLocal skips names the server refuses and leftover parts", async (t) => {
  const { project } = fixture(t);
  const src = path.join(project, "src");
  fs.writeFileSync(path.join(src, `bad${String.fromCharCode(10)}name`), "x");
  fs.writeFileSync(path.join(src, "back\\slash"), "x");
  fs.writeFileSync(path.join(src, ".a.txt.agentpier-part-00ff00ff00ff00ff"), "x");
  const target = localRoot({ root: project, raw: "src" });
  const { entries, skipped } = await walkLocal(target, { excludes: [] });
  assert.deepEqual(
    entries.map((e) => e.path),
    ["a.txt", "deep/b.txt"],
  );
  assert.deepEqual(skipped, { links: 0, special: 0, unsafe: 2 });
});

test("walkLocal stops at the scan limit", async (t) => {
  const { project } = fixture(t);
  const target = localRoot({ root: project, raw: "src" });
  await assert.rejects(
    walkLocal(target, { excludes: [], limits: { ...sftpLimits, maxScanEntries: 2 } }),
    { code: "SFTP_LIMIT" },
  );
});

test("walkLocal on a file lists that file", async (t) => {
  const { project } = fixture(t);
  const target = localRoot({ root: project, raw: "src/a.txt" });
  const { entries } = await walkLocal(target, { excludes: [] });
  assert.deepEqual(
    entries.map((e) => e.path),
    ["a.txt"],
  );
  const handle = await openLocalSource(target, "a.txt");
  await handle.close();
});

test("data dir refused as protected root", async (t) => {
  const { project } = fixture(t);
  const data = path.join(project, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "token"), "x");
  const protectedRoots = [data];
  assert.throws(() => localRoot({ root: project, raw: "data", protectedRoots }), {
    key: "projectPathRefused",
  });
  assert.throws(
    () => localRoot({ root: project, raw: "", write: true, protectedRoots }),
    { key: "projectPathRefused" },
  );
  const target = localRoot({ root: project, raw: "", protectedRoots });
  const { entries } = await walkLocal(target, { excludes: [] });
  assert.ok(entries.every((e) => !e.path.startsWith("data/")));
});

test("writeLocal writes atomically with the given mtime", async (t) => {
  const { project } = fixture(t);
  const target = localRoot({ root: project, raw: "out/new", write: true });
  const mtimeMs = Date.UTC(2024, 0, 2, 3, 4, 5);
  const first = await writeLocal(target, "x/y/z.txt", Readable.from(["hel", "lo"]), {
    mtimeMs,
  });
  const file = path.join(project, "out", "new", "x", "y", "z.txt");
  assert.deepEqual(first, { overwritten: false });
  assert.equal(fs.readFileSync(file, "utf8"), "hello");
  assert.equal(fs.statSync(file).mtimeMs, mtimeMs);
  const second = await writeLocal(target, "x/y/z.txt", Readable.from(["again"]), {});
  assert.deepEqual(second, { overwritten: true });
  assert.equal(fs.readFileSync(file, "utf8"), "again");
  assert.deepEqual(parts(path.dirname(file)), []);
});

test("writeLocal leaves no temp file after an aborted stream", async (t) => {
  const { project } = fixture(t);
  const target = localRoot({ root: project, raw: "src", write: true });
  const failing = new Readable({
    read() {
      this.push("partial");
      this.destroy(new Error("connection dropped"));
    },
  });
  await assert.rejects(writeLocal(target, "a.txt", failing, {}), /connection dropped/);
  assert.equal(fs.readFileSync(path.join(project, "src", "a.txt"), "utf8"), "alpha");
  assert.deepEqual(parts(path.join(project, "src")), []);
  const controller = new AbortController();
  const slow = new Readable({ read() {} });
  const pending = writeLocal(target, "c.txt", slow, { signal: controller.signal });
  slow.push("some");
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(parts(path.join(project, "src")), []);
  assert.equal(fs.existsSync(path.join(project, "src", "c.txt")), false);
});

test("writeLocal into a read-only target refused", async (t) => {
  const { project, outside } = fixture(t);
  assert.throws(
    () => localRoot({ root: project, raw: ".agentpier-worktrees/run", write: true }),
    { key: "projectPathRefused" },
  );
  assert.throws(() => localRoot({ root: project, raw: ".git", write: true }), {
    key: "projectPathRefused",
  });
  const target = localRoot({
    root: project,
    raw: "src",
    write: true,
    lockToolConfig: true,
  });
  await assert.rejects(
    writeLocal(target, ".agentpier-worktrees/x", Readable.from(["x"]), {}),
    { key: "projectPathRefused" },
  );
  await assert.rejects(
    writeLocal(target, ".claude/settings.json", Readable.from(["x"]), {}),
    {
      key: "projectToolConfigLocked",
    },
  );
  await assert.rejects(writeLocal(target, "a/../../x", Readable.from(["x"]), {}), {
    code: "SFTP_PATH_REFUSED",
  });
  fs.symlinkSync(outside, path.join(project, "src", "escape"));
  await assert.rejects(writeLocal(target, "escape/new", Readable.from(["x"]), {}));
  assert.deepEqual(fs.readdirSync(outside), ["secret"]);
  fs.mkdirSync(path.join(project, "src", "dir.txt"));
  await assert.rejects(writeLocal(target, "dir.txt", Readable.from(["x"]), {}), {
    code: "SFTP_TYPE_CONFLICT",
  });
  await assert.rejects(writeLocal(target, "a.txt/below", Readable.from(["x"]), {}), {
    code: "SFTP_TYPE_CONFLICT",
  });
  const readOnly = localRoot({ root: project, raw: "src" });
  await assert.rejects(writeLocal(readOnly, "n.txt", Readable.from(["x"]), {}), {
    code: "SFTP_PATH_REFUSED",
  });
});

test("caseInsensitiveTarget probes the target's file system", async (t) => {
  const { base, project } = fixture(t);
  fs.writeFileSync(path.join(base, "Probe"), "");
  const expected = fs.existsSync(path.join(base, "PROBE"));
  const missing = localRoot({ root: project, raw: "not/yet", write: true });
  assert.equal(caseInsensitiveTarget(missing), expected);
  assert.equal(caseInsensitiveTarget(localRoot({ root: project, raw: "src" })), expected);
});
