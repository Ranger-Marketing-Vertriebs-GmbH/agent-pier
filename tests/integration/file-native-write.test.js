import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileFixture } from "../helpers/file-explorer.js";
import { FileNative } from "../../server/features/files/file-native.js";

test("owned creation and writes stay in a pinned parent after its path becomes a link", async (t) => {
  const f = await fileFixture(t),
    native = new FileNative();
  t.after(() => native.close());
  const parent = await native.run("openRoot", { path: f.project });
  await fs.rename(f.project, `${f.project}-retained`);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, f.project);
  const dir = await native.run("createDirectory", {
    directory: parent.handle,
    name: "private",
  });
  const file = await native.run("createFile", { directory: dir.handle, name: "bytes" });
  await native.run("write", {
    handle: file.handle,
    bytes: Buffer.from("owned"),
    position: 0,
  });
  await native.run("sync", { handle: file.handle });
  await native.run("sync", { handle: dir.handle });
  assert.equal(await fs.readFile(`${f.project}-retained/private/bytes`, "utf8"), "owned");
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(
    native.run("createFile", { directory: dir.handle, name: "bytes" }),
    { code: "FILE_EXISTS" },
  );
  await assert.rejects(
    native.run("write", { handle: file.handle, bytes: Buffer.alloc(65537), position: 0 }),
    { code: "FILE_INVALID_PATH" },
  );
});

test("prechecked cleanup refuses a replacement file observed before removal", async (t) => {
  const f = await fileFixture(t),
    native = new FileNative();
  t.after(() => native.close());
  const parent = await native.run("openRoot", { path: f.home });
  const file = await native.run("createFile", {
    directory: parent.handle,
    name: "registered",
  });
  await native.run("write", {
    handle: file.handle,
    bytes: Buffer.from("registered"),
    position: 0,
  });
  await fs.rename(`${f.home}/registered`, `${f.home}/retained`);
  await fs.writeFile(`${f.home}/registered`, "unrelated");
  await assert.rejects(
    native.run("removeEntry", {
      directory: parent.handle,
      name: "registered",
      identity: `${file.dev}:${file.ino}`,
      type: "file",
    }),
    { code: "FILE_PATH_CHANGED" },
  );
  assert.equal(await fs.readFile(`${f.home}/registered`, "utf8"), "unrelated");
  assert.equal(await fs.readFile(`${f.home}/retained`, "utf8"), "registered");
});

test("prechecked cleanup preserves an observed replacement empty directory", async (t) => {
  const f = await fileFixture(t),
    native = new FileNative();
  t.after(() => native.close());
  const parent = await native.run("openRoot", { path: f.home });
  const directory = await native.run("createDirectory", {
    directory: parent.handle,
    name: "registered",
  });
  await fs.rename(`${f.home}/registered`, `${f.home}/retained`);
  await fs.mkdir(`${f.home}/registered`);
  const replacement = await fs.stat(`${f.home}/registered`, { bigint: true });
  await assert.rejects(
    native.run("removeEntry", {
      directory: parent.handle,
      name: "registered",
      identity: `${directory.dev}:${directory.ino}`,
      type: "directory",
    }),
    { code: "FILE_PATH_CHANGED" },
  );
  assert.equal(
    (await fs.stat(`${f.home}/registered`, { bigint: true })).ino,
    replacement.ino,
  );
  assert.equal(
    (await fs.stat(`${f.home}/retained`, { bigint: true })).ino,
    directory.ino,
  );
});
