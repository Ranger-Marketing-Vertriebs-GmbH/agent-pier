import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatAttachments } from "../../server/features/chat/chat-attachments.js";
import { FileNative } from "../../server/features/files/file-native.js";

for (const boundary of ["opened root", "opened account"]) {
  test(`attachment cleanup preserves outside bytes when parent changes after ${boundary}`, async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "attachment-race-")),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new ChatAttachments({ dataDir: path.join(root, "data") });
    const account = path.join(store.directory, "account");
    const selected = path.join(account, "session");
    const outside = path.join(root, "outside");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(path.join(selected, "own"), "own upload");
    await fs.mkdir(path.join(outside, "session"), { recursive: true });
    const marker = path.join(outside, "session/keep");
    await fs.writeFile(marker, "outside upload");
    let swapped = false;
    async function swap() {
      if (swapped) return;
      swapped = true;
      await fs.rename(account, account + "-old");
      await fs.symlink(outside, account);
    }
    const run = FileNative.prototype.run;
    t.mock.method(FileNative.prototype, "run", async function (operation, args) {
      const result = await run.call(this, operation, args);
      if (
        (boundary === "opened root" && operation === "openRoot") ||
        (boundary === "opened account" &&
          operation === "openLookup" &&
          args.path === "account")
      )
        await swap();
      return result;
    });
    await store.discard("session", selected);
    assert.equal(swapped, true);
    assert.equal(await fs.readFile(marker, "utf8"), "outside upload");
  });
}

test("attachment cleanup closes its native owner after a traversal failure", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "attachment-owner-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatAttachments({ dataDir: root });
  const selected = path.join(store.directory, "session");
  await fs.mkdir(selected);
  const marker = path.join(selected, "keep");
  await fs.writeFile(marker, "unremoved upload");
  const run = FileNative.prototype.run;
  let owner;
  t.mock.method(FileNative.prototype, "run", async function (operation, args) {
    owner = this;
    if (operation === "readDirectory")
      throw Object.assign(new Error("injected traversal failure"), {
        code: "FILE_IO_ERROR",
      });
    return run.call(this, operation, args);
  });
  await assert.rejects(store.discard("session", selected), { code: "FILE_IO_ERROR" });
  assert.equal(await fs.readFile(marker, "utf8"), "unremoved upload");
  await assert.rejects(run.call(owner, "openRoot", { path: root }), {
    code: "FILE_IO_ERROR",
  });
});

test("attachment cleanup never adopts a replaced attachment root", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "attachment-root-race-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatAttachments({ dataDir: path.join(root, "data") });
  const selected = path.join(store.directory, "account/session");
  await fs.mkdir(selected, { recursive: true });
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(outside, "account/session"), { recursive: true });
  const marker = path.join(outside, "account/session/keep");
  await fs.writeFile(marker, "outside upload");
  await fs.rename(store.directory, store.directory + "-old");
  await fs.symlink(outside, store.directory);
  await store.discard("session", selected);
  assert.equal(await fs.readFile(marker, "utf8"), "outside upload");
});

test("attachment cleanup uses only native handles after validating the grant", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-native-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatAttachments({ dataDir: root });
  const selected = path.join(store.directory, "account/session");
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(selected, "upload"), "owned upload");
  t.mock.method(fs, "realpath", async () => {
    throw new Error("Unexpected path-based lookup");
  });
  await store.discard("session", selected);
  await assert.rejects(fs.stat(selected), { code: "ENOENT" });
});
