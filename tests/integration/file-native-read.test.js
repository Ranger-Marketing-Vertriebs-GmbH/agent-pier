import test from "node:test";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readdirSync, fstatSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileFixture } from "../helpers/file-explorer.js";

import { FileNative } from "../../server/features/files/file-native.js";
async function fixture(t) {
  assert.equal(typeof FileNative, "function", "native descriptor implementation exists");
  const f = await fileFixture(t);
  const native = new FileNative();
  t.after(() => native.close());
  await fs.mkdir(path.join(f.project, "nested"));
  await fs.writeFile(path.join(f.project, "nested/sample.txt"), "owned content");
  return { ...f, native };
}
function descriptorsFor(stat) {
  return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").filter(
    (name) => {
      try {
        const current = fstatSync(Number(name), { bigint: true });
        return current.dev === stat.dev && current.ino === stat.ino;
      } catch {
        return false;
      }
    },
  );
}

test("native component traversal reads a regular file and closes owned descriptors", async (t) => {
  const f = await fixture(t);
  const root = await f.native.run("openRoot", { path: f.project });
  const file = await f.native.run("openFile", {
    directory: root.handle,
    path: "nested/sample.txt",
  });
  assert.equal(
    Buffer.from(
      await f.native.run("read", { handle: file.handle, length: 5, position: 6 }),
    ).toString(),
    "conte",
  );
  const stat = await fs.stat(path.join(f.project, "nested/sample.txt"), { bigint: true });
  assert.equal(file.ino, stat.ino);
  assert.equal(descriptorsFor(stat).length, 1);
  await f.native.run("closeHandle", { handle: file.handle });
  assert.equal(descriptorsFor(stat).length, 0);
  await assert.rejects(
    f.native.run("read", { handle: file.handle, length: 1, position: 0 }),
    { code: "FILE_INVALID_PATH" },
  );
});

test("a pinned root remains authoritative when its pathname becomes an outside link", async (t) => {
  const f = await fixture(t);
  const root = await f.native.run("openRoot", { path: f.project });
  const outside = path.join(f.home, "outside");
  await fs.mkdir(path.join(outside, "nested"), { recursive: true });
  await fs.writeFile(path.join(outside, "nested/sample.txt"), "OUTSIDE");
  await fs.rename(f.project, `${f.project}-selected`);
  await fs.symlink(outside, f.project);
  const file = await f.native.run("openFile", {
    directory: root.handle,
    path: "nested/sample.txt",
  });
  assert.equal(
    Buffer.from(
      await f.native.run("read", { handle: file.handle, length: 64, position: 0 }),
    ).toString(),
    "owned content",
  );
  await assert.rejects(f.native.run("openRoot", { path: f.project }), {
    code: "FILE_PATH_CHANGED",
  });
});

test("native root traversal rejects substituted ancestor links", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.home, `${f.home}-selected`);
  await fs.symlink(`${f.home}-selected`, f.home);
  await assert.rejects(f.native.run("openRoot", { path: f.project }), {
    code: "FILE_PATH_CHANGED",
  });
});

test("native child and leaf traversal never follows replacement links", async (t) => {
  const f = await fixture(t);
  const root = await f.native.run("openRoot", { path: f.project });
  await fs.rename(path.join(f.project, "nested"), path.join(f.project, "original"));
  await fs.symlink("original", path.join(f.project, "nested"));
  await assert.rejects(
    f.native.run("openFile", { directory: root.handle, path: "nested/sample.txt" }),
    { code: "FILE_PATH_CHANGED" },
  );
  await fs.symlink("original/sample.txt", path.join(f.project, "leaf"));
  await assert.rejects(
    f.native.run("openFile", { directory: root.handle, path: "leaf" }),
    { code: "FILE_PATH_CHANGED" },
  );
  const file = await f.native.run("openFile", {
    directory: root.handle,
    path: "original/sample.txt",
  });
  await fs.rename(
    path.join(f.project, "original/sample.txt"),
    path.join(f.project, "original/kept"),
  );
  await fs.writeFile(path.join(f.project, "original/sample.txt"), "replacement");
  assert.equal(
    Buffer.from(
      await f.native.run("read", { handle: file.handle, length: 64, position: 0 }),
    ).toString(),
    "owned content",
  );
});

test("native failed traversal and shutdown release every owned fixture descriptor", async (t) => {
  const f = await fixture(t);
  const stats = await Promise.all(
    [
      f.project,
      path.join(f.project, "nested"),
      path.join(f.project, "nested/sample.txt"),
    ].map((p) => fs.stat(p, { bigint: true })),
  );
  const root = await f.native.run("openRoot", { path: f.project });
  for (let i = 0; i < 12; i++)
    await assert.rejects(
      f.native.run("openFile", { directory: root.handle, path: "nested/missing" }),
      { code: "FILE_NOT_FOUND" },
    );
  assert.equal(descriptorsFor(stats[1]).length, 0);
  const file = await f.native.run("openFile", {
    directory: root.handle,
    path: "nested/sample.txt",
  });
  const reading = f.native.run("read", { handle: file.handle, length: 64, position: 0 });
  const closing = f.native.close();
  assert.equal(Buffer.from(await reading).toString(), "owned content");
  await closing;
  for (const stat of stats) assert.equal(descriptorsFor(stat).length, 0);
  await assert.rejects(f.native.run("openRoot", { path: f.project }), {
    code: "FILE_IO_ERROR",
  });
  await f.native.close();
});

test("native validation bounds arguments and rejects special descriptors without blocking", async (t) => {
  const f = await fixture(t);
  const root = await f.native.run("openRoot", { path: f.project });
  for (const selected of [
    "../outside",
    "/etc/passwd",
    "nested/../sample.txt",
    "nested//sample.txt",
    "nested/.",
    "x\0y",
    "x".repeat(4097),
  ])
    await assert.rejects(
      f.native.run("openFile", { directory: root.handle, path: selected }),
      { code: "FILE_INVALID_PATH" },
    );
  await assert.rejects(f.native.run("arbitrarySymbol", {}), {
    code: "FILE_INVALID_PATH",
  });
  await assert.rejects(
    f.native.run("read", { handle: root.handle, length: 65537, position: 0 }),
    { code: "FILE_INVALID_PATH" },
  );
  await assert.rejects(
    f.native.run("openFile", { directory: root.handle, path: "nested" }),
    { code: "FILE_UNSUPPORTED_TYPE" },
  );
  execFileSync("mkfifo", [path.join(f.project, "pipe")]);
  await assert.rejects(
    f.native.run("openFile", { directory: root.handle, path: "pipe" }),
    { code: "FILE_UNSUPPORTED_TYPE" },
  );
  assert.throws(() => new FileNative({ platform: "win32" }), { code: "FILE_IO_ERROR" });
});

test(
  "known readable files can be opened beneath execute-only directories",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    const nested = path.join(f.project, "nested");
    await fs.chmod(nested, 0o100);
    try {
      const root = await f.native.run("openRoot", { path: nested });
      const file = await f.native.run("openFile", {
        directory: root.handle,
        path: "sample.txt",
      });
      assert.equal(
        Buffer.from(
          await f.native.run("read", { handle: file.handle, length: 64, position: 0 }),
        ).toString(),
        "owned content",
      );
    } finally {
      await fs.chmod(nested, 0o700);
    }
  },
);

test("an unexpected worker failure rejects pending work and closes native descriptors", async (t) => {
  const f = await fixture(t);
  const root = await f.native.run("openRoot", { path: f.project });
  const file = await f.native.run("openFile", {
    directory: root.handle,
    path: "nested/sample.txt",
  });
  const stat = await fs.stat(path.join(f.project, "nested/sample.txt"), { bigint: true });
  assert.equal(descriptorsFor(stat).length, 1);
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, "postMessage", function (message) {
    // Malformed transport input causes a real uncaught worker exception.
    return post.call(this, message.operation === "read" ? null : message);
  });
  await assert.rejects(
    f.native.run("read", { handle: file.handle, length: 1, position: 0 }),
    { code: "FILE_IO_ERROR" },
  );
  await f.native.close();
  assert.equal(descriptorsFor(stat).length, 0);
});
