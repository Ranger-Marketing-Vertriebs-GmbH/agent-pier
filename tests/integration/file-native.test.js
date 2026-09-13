import test from "node:test";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readdirSync, fstatSync } from "node:fs";
import path from "node:path";
import { FileNative } from "../../server/features/files/file-native.js";
import { fileFixture } from "../helpers/file-explorer.js";

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
async function fixture(t) {
  const f = await fileFixture(t);
  const native = new FileNative();
  t.after(() => native.close());
  const root = await native.run("openRoot", { path: f.project });
  return { ...f, native, handle: root.handle };
}
async function names(native, handle) {
  const result = [];
  for (let count = 0; count < 20; count++) {
    const entry = await native.run("readDirectory", { handle });
    if (!entry) return result;
    result.push(entry);
  }
  assert.fail("Unexpected unbounded fixture directory");
}

test("native enumeration reads the owned directory, reports types and closes its stream", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, "nested"));
  await fs.writeFile(path.join(f.project, "nested", "ä-file.txt"), "fixture");
  await fs.symlink("ä-file.txt", path.join(f.project, "nested", "link"));
  const dir = await f.native.run("openDirectory", {
    directory: f.handle,
    path: "nested",
  });
  const stat = await fs.stat(path.join(f.project, "nested"), { bigint: true });
  assert.equal(dir.ino, stat.ino);
  await fs.rename(path.join(f.project, "nested"), path.join(f.project, "kept"));
  await fs.mkdir(path.join(f.home, "outside"));
  await fs.writeFile(path.join(f.home, "outside", "outside-sentinel.txt"), "outside");
  await fs.symlink(path.join(f.home, "outside"), path.join(f.project, "nested"));
  assert.deepEqual(
    (await names(f.native, dir.handle)).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "ä-file.txt", type: "file" },
      { name: "link", type: "symlink" },
    ],
  );
  assert.equal(descriptorsFor(stat).length, 1);
  await f.native.run("closeHandle", { handle: dir.handle });
  assert.equal(descriptorsFor(stat).length, 0);
  await assert.rejects(f.native.run("readDirectory", { handle: dir.handle }), {
    code: "FILE_INVALID_PATH",
  });
  const rootReader = await f.native.run("openDirectory", {
    directory: f.handle,
    path: "",
  });
  assert.deepEqual(
    (await names(f.native, rootReader.handle)).map((entry) => entry.name).sort(),
    ["kept", "nested"],
  );
});

test("native enumeration rejects substituted leaf and ancestor links without opening the target", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, "parent", "leaf"), { recursive: true });
  const outside = path.join(f.home, "outside");
  await fs.mkdir(path.join(outside, "leaf"), { recursive: true });
  await fs.writeFile(path.join(outside, "leaf", "outside-sentinel.txt"), "outside");
  const outsideStat = await fs.stat(path.join(outside, "leaf"), { bigint: true });
  await fs.rename(
    path.join(f.project, "parent", "leaf"),
    path.join(f.project, "original"),
  );
  await fs.symlink(path.join(outside, "leaf"), path.join(f.project, "parent", "leaf"));
  await assert.rejects(
    f.native.run("openDirectory", { directory: f.handle, path: "parent/leaf" }),
    { code: "FILE_PATH_CHANGED" },
  );
  await fs.rename(path.join(f.project, "parent"), path.join(f.project, "old-parent"));
  await fs.symlink(outside, path.join(f.project, "parent"));
  await assert.rejects(
    f.native.run("openDirectory", { directory: f.handle, path: "parent/leaf" }),
    { code: "FILE_PATH_CHANGED" },
  );
  assert.equal(descriptorsFor(outsideStat).length, 0);
});

test("native directory admission stays bounded and shutdown owns queued reads", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, "found"), "fixture");
  const stat = await fs.stat(f.project, { bigint: true });
  const readers = [];
  for (let count = 0; count < 63; count++)
    readers.push(await f.native.run("openDirectory", { directory: f.handle, path: "" }));
  await assert.rejects(f.native.run("openDirectory", { directory: f.handle, path: "" }), {
    code: "FILE_IO_ERROR",
    status: 503,
  });
  const reading = f.native.run("readDirectory", { handle: readers[0].handle });
  const closing = f.native.close();
  assert.deepEqual(await reading, { name: "found", type: "file" });
  await closing;
  assert.equal(descriptorsFor(stat).length, 0);
});

test(
  "native enumeration accepts execute-only ancestors but needs read access to its leaf",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    const parent = path.join(f.project, "parent");
    await fs.mkdir(path.join(parent, "leaf"), { recursive: true });
    await fs.writeFile(path.join(parent, "leaf", "found"), "fixture");
    await fs.chmod(parent, 0o100);
    try {
      const reader = await f.native.run("openDirectory", {
        directory: f.handle,
        path: "parent/leaf",
      });
      assert.deepEqual(await names(f.native, reader.handle), [
        { name: "found", type: "file" },
      ]);
      await assert.rejects(
        f.native.run("openDirectory", { directory: f.handle, path: "parent" }),
        { code: "FILE_ACCESS_DENIED" },
      );
    } finally {
      await fs.chmod(parent, 0o700);
    }
  },
);

test("directory request validation and queued admission expose no arbitrary native interface", async (t) => {
  const f = await fixture(t);
  for (const args of [
    { directory: f.handle, path: "../outside" },
    { directory: f.handle, path: "/outside" },
    { directory: f.handle, path: "", symbol: "opendir" },
    { directory: -1, path: "" },
  ])
    await assert.rejects(f.native.run("openDirectory", args), {
      code: "FILE_INVALID_PATH",
    });
  await assert.rejects(f.native.run("readDirectory", { handle: f.handle }), {
    code: "FILE_INVALID_PATH",
  });
  const dir = await f.native.run("openDirectory", { directory: f.handle, path: "" });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 65 }, () =>
      f.native.run("readDirectory", { handle: dir.handle }),
    ),
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 64);
  assert.equal(outcomes[64].reason.code, "FILE_IO_ERROR");
  assert.equal(outcomes[64].reason.status, 503);
});

test("an unexpected worker exit also releases its owned directory stream", async (t) => {
  const f = await fixture(t);
  const dir = await f.native.run("openDirectory", { directory: f.handle, path: "" });
  const stat = await fs.stat(f.project, { bigint: true });
  assert.equal(descriptorsFor(stat).length, 2);
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, "postMessage", function (message) {
    return post.call(this, message.operation === "readDirectory" ? null : message);
  });
  await assert.rejects(f.native.run("readDirectory", { handle: dir.handle }), {
    code: "FILE_IO_ERROR",
  });
  await f.native.close();
  assert.equal(descriptorsFor(stat).length, 0);
});
