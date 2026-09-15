import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileFixture } from "../helpers/file-explorer.js";
import { FileNative } from "../../server/features/files/file-native.js";

const strictOwnership = process.platform !== "linux";
const expectedWarnings = strictOwnership
  ? []
  : [{ code: "FILE_METADATA_UNSUPPORTED", args: {} }];

async function metadata() {
  const module = await import("../../server/features/files/file-metadata.js").catch(
    () => ({}),
  );
  assert.equal(
    typeof module.copyMetadata,
    "function",
    "metadata preservation is implemented",
  );
  return module;
}

test("metadata copying leaves both byte streams untouched, preserves executable mode and exact times, and borrows descriptors", async (t) => {
  const { copyMetadata, readMetadata, assertMetadata } = await metadata();
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.project, "source"), "wx+", 0o750);
  const target = await fs.open(path.join(f.project, "target"), "wx+", 0o600);
  t.after(async () => {
    await source.close();
    await target.close();
  });
  await source.chmod(0o750);
  await source.writeFile("source bytes");
  await target.writeFile("different target bytes");
  await source.utimes(1234567890.125, 1234567891.25);
  const before = await readMetadata(source);
  assert.deepEqual(
    before.completeness,
    strictOwnership
      ? { complete: true }
      : { complete: false, reason: "namespace_visibility" },
  );
  if (!strictOwnership) {
    const targetBefore = await target.stat({ bigint: true });
    await assert.rejects(
      copyMetadata(source, target, { strictOwnership: true, preserveTimes: true }),
      { code: "FILE_METADATA_UNSUPPORTED" },
    );
    assert.equal((await target.stat({ bigint: true })).ctimeNs, targetBefore.ctimeNs);
    assert.throws(() => assertMetadata(before, before, { strictOwnership: true }), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
  }
  assert.equal(before.mode, 0o750);
  assert.equal(typeof before.mtimeNs, "bigint");
  assert.deepEqual(
    await copyMetadata(source, target, { strictOwnership, preserveTimes: true }),
    { warnings: expectedWarnings },
  );
  const after = await readMetadata(target);
  assertMetadata(before, after, { strictOwnership });
  assert.equal(after.atimeNs, before.atimeNs);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal((await target.stat()).mode & 0o7777, 0o750);
  assert.equal(await fs.readFile(path.join(f.project, "source"), "utf8"), "source bytes");
  assert.equal(
    await fs.readFile(path.join(f.project, "target"), "utf8"),
    "different target bytes",
  );
  assert.equal((await source.stat()).isFile(), true);
});

test("worker-owned metadata keeps opaque handles distinct from borrowed FileHandles", async (t) => {
  const { readMetadata } = await metadata();
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "file"), "fixture", { mode: 0o640 });
  await fs.chmod(path.join(f.project, "file"), 0o640);
  const native = new FileNative();
  t.after(() => native.close());
  const root = await native.run("openRoot", { path: f.project });
  const file = await native.run("openFile", { directory: root.handle, path: "file" });
  assert.equal((await readMetadata({ native, handle: file.handle })).mode, 0o640);
  await assert.rejects(readMetadata(file.handle), { code: "FILE_INVALID_PATH" });
  await native.run("closeHandle", { handle: file.handle });
  await assert.rejects(readMetadata({ native, handle: file.handle }), {
    code: "FILE_INVALID_PATH",
  });
});

test("metadata supports real directories and rejects closed borrowed descriptors", async (t) => {
  const { copyMetadata, readMetadata } = await metadata();
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.project, "source"), { mode: 0o750 });
  await fs.mkdir(path.join(f.project, "target"), { mode: 0o700 });
  await fs.chmod(path.join(f.project, "source"), 0o750);
  const source = await fs.open(path.join(f.project, "source"), "r");
  const target = await fs.open(path.join(f.project, "target"), "r");
  t.after(async () => {
    await source.close();
    await target.close();
  });
  const { attachAttributes, observeAttributes } =
    await import("../helpers/file-native-metadata.js");
  attachAttributes(
    source.fd,
    "user.agentpier-directory",
    Buffer.from("directory metadata"),
  );
  await copyMetadata(source, target, { strictOwnership, preserveTimes: true });
  assert.deepEqual(observeAttributes(target.fd), observeAttributes(source.fd));
  const native = new FileNative();
  t.after(() => native.close());
  const owned = await native.run("openRoot", { path: path.join(f.project, "source") });
  assert.equal((await readMetadata({ native, handle: owned.handle })).mode, 0o750);
  assert.equal((await target.stat()).mode & 0o777, 0o750);
  await target.close();
  await assert.rejects(readMetadata(target), { code: "FILE_INVALID_PATH" });
});

test("metadata copies real xattrs and ACLs, removes stale target attributes, and leaves bytes untouched", async (t) => {
  const { copyMetadata, readMetadata } = await metadata();
  const { execFileSync } = await import("node:child_process");
  const { attachAttributes, observeAttributes } =
    await import("../helpers/file-native-metadata.js");
  const f = await fileFixture(t);
  const sourcePath = path.join(f.project, "source"),
    targetPath = path.join(f.project, "target");
  await fs.writeFile(sourcePath, "source");
  await fs.writeFile(targetPath, "target");
  const source = await fs.open(sourcePath, "r+"),
    target = await fs.open(targetPath, "r+");
  t.after(async () => {
    await source.close();
    await target.close();
  });
  attachAttributes(source.fd, "user.agentpier-test", Buffer.from([0, 1, 255, 17]));
  attachAttributes(target.fd, "user.agentpier-stale", Buffer.from("stale"));
  if (process.platform === "darwin")
    execFileSync("chmod", ["+a", "everyone allow readattr,readextattr", sourcePath]);
  else {
    const acl = Buffer.alloc(44);
    acl.writeUInt32LE(2);
    [
      [1, 6, 0xffffffff],
      [2, 4, 65534],
      [4, 0, 0xffffffff],
      [16, 4, 0xffffffff],
      [32, 0, 0xffffffff],
    ].forEach(([tag, perm, id], index) => {
      acl.writeUInt16LE(tag, 4 + index * 8);
      acl.writeUInt16LE(perm, 6 + index * 8);
      acl.writeUInt32LE(id, 8 + index * 8);
    });
    attachAttributes(source.fd, "system.posix_acl_access", acl);
  }
  const before = observeAttributes(source.fd);
  const sourceAcl =
    process.platform === "darwin"
      ? execFileSync("ls", ["-lde", sourcePath], { encoding: "utf8" })
          .split("\n")
          .slice(1)
          .join("\n")
      : before.find((a) => a.name === "system.posix_acl_access").value;
  await copyMetadata(source, target, { strictOwnership, preserveTimes: true });
  assert.deepEqual(observeAttributes(target.fd), before);
  const targetAcl =
    process.platform === "darwin"
      ? execFileSync("ls", ["-lde", targetPath], { encoding: "utf8" })
          .split("\n")
          .slice(1)
          .join("\n")
      : observeAttributes(target.fd).find((a) => a.name === "system.posix_acl_access")
          .value;
  assert.deepEqual(targetAcl, sourceAcl);
  assert.ok(
    (await readMetadata(source)).acl ||
      before.some((a) => a.name === "system.posix_acl_access"),
  );
  assert.equal(await fs.readFile(sourcePath, "utf8"), "source");
  assert.equal(await fs.readFile(targetPath, "utf8"), "target");
});

test("metadata comparison separates preservation from content timestamps", async () => {
  const { assertMetadata, metadataFingerprint } = await metadata();
  const base = {
    completeness: { complete: true },
    mode: 0o750,
    uid: 1,
    gid: 2,
    mtimeNs: 1n,
    atimeNs: 2n,
    acl: null,
    xattrs: [],
  };
  assert.doesNotThrow(() =>
    assertMetadata(base, { ...base, mtimeNs: 3n, atimeNs: 4n }, { strictOwnership }),
  );
  assert.equal(
    metadataFingerprint(base),
    metadataFingerprint({ ...base, mtimeNs: 3n, atimeNs: 4n }),
  );
  assert.throws(
    () => assertMetadata(base, { ...base, mode: 0o700 }, { strictOwnership: false }),
    { code: "FILE_METADATA_MISMATCH" },
  );
  assert.throws(
    () => assertMetadata(base, { ...base, uid: 3 }, { strictOwnership: true }),
    { code: "FILE_METADATA_MISMATCH" },
  );
  assert.doesNotThrow(() =>
    assertMetadata(base, { ...base, uid: 3 }, { strictOwnership: false }),
  );
});

test("owned link metadata stays on the pinned symlink after rename and never changes either target sentinel", async (t) => {
  const { copyMetadata, readMetadata } = await metadata();
  const { attachAttributes, observeAttributes } =
    await import("../helpers/file-native-metadata.js");
  const f = await fileFixture(t);
  const sentinel = path.join(f.home, "outside");
  await fs.writeFile(sentinel, "outside sentinel");
  const outside = await fs.open(sentinel, "r+");
  t.after(() => outside.close());
  attachAttributes(
    outside.fd,
    "user.agentpier-sentinel",
    Buffer.from("outside attribute"),
  );
  const outsideAttributes = observeAttributes(outside.fd);
  await fs.symlink(sentinel, path.join(f.project, "source-link"));
  await fs.symlink(sentinel, path.join(f.project, "target-link"));
  if (process.platform === "darwin") {
    const { execFileSync } = await import("node:child_process");
    execFileSync("xattr", [
      "-s",
      "-w",
      "user.agentpier-link",
      "link value",
      path.join(f.project, "source-link"),
    ]);
    execFileSync("chmod", [
      "-h",
      "+a",
      "everyone allow readattr,readextattr",
      path.join(f.project, "source-link"),
    ]);
  }
  const native = new FileNative();
  t.after(() => native.close());
  const root = await native.run("openRoot", { path: f.project });
  const source = await native.run("openLink", {
    directory: root.handle,
    path: "source-link",
  });
  const target = await native.run("openLink", {
    directory: root.handle,
    path: "target-link",
  });
  const before = await readMetadata({ native, handle: source.handle });
  assert.deepEqual(
    before.xattrs.map(({ name, value }) => ({
      name,
      value: Buffer.from(value).toString(),
    })),
    process.platform === "darwin"
      ? [{ name: "user.agentpier-link", value: "link value" }]
      : [],
  );
  await fs.rename(
    path.join(f.project, "source-link"),
    path.join(f.project, "kept-source"),
  );
  await fs.rename(
    path.join(f.project, "target-link"),
    path.join(f.project, "kept-target"),
  );
  await fs.writeFile(path.join(f.project, "source-link"), "replacement source");
  await fs.writeFile(path.join(f.project, "target-link"), "replacement target");
  assert.deepEqual(
    await copyMetadata(
      { native, handle: source.handle },
      { native, handle: target.handle },
      { strictOwnership, preserveTimes: true },
    ),
    { warnings: expectedWarnings },
  );
  assert.equal(
    (await readMetadata({ native, handle: target.handle })).mtimeNs,
    before.mtimeNs,
  );
  if (process.platform === "darwin") {
    const { execFileSync } = await import("node:child_process");
    assert.equal(
      execFileSync(
        "xattr",
        ["-s", "-p", "user.agentpier-link", path.join(f.project, "kept-target")],
        { encoding: "utf8" },
      ).trim(),
      "link value",
    );
    const acl = (name) =>
      execFileSync("ls", ["-lde", path.join(f.project, name)], { encoding: "utf8" })
        .split("\n")
        .slice(1)
        .join("\n");
    assert.equal(acl("kept-source"), acl("kept-target"));
  }
  assert.deepEqual(observeAttributes(outside.fd), outsideAttributes);
  assert.equal(await fs.readFile(sentinel, "utf8"), "outside sentinel");
  assert.equal(
    await fs.readFile(path.join(f.project, "target-link"), "utf8"),
    "replacement target",
  );
  await assert.rejects(
    native.run("read", { handle: source.handle, length: 10, position: 0 }),
    { code: "FILE_INVALID_PATH" },
  );
  await assert.rejects(
    native.run("openLink", { directory: root.handle, path: "target-link" }),
    { code: "FILE_UNSUPPORTED_TYPE" },
  );
});

test(
  "copying an empty ACL removes a pre-existing target ACL",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { copyMetadata, readMetadata } = await metadata();
    const { execFileSync } = await import("node:child_process");
    const f = await fileFixture(t);
    const source = await fs.open(path.join(f.project, "source"), "wx+");
    const target = await fs.open(path.join(f.project, "target"), "wx+");
    t.after(async () => {
      await source.close();
      await target.close();
    });
    execFileSync("chmod", [
      "+a",
      "everyone allow readattr,readextattr",
      path.join(f.project, "target"),
    ]);
    assert.ok((await readMetadata(target)).acl);
    await copyMetadata(source, target, { strictOwnership, preserveTimes: true });
    assert.equal((await readMetadata(target)).acl, null);
    assert.doesNotMatch(
      execFileSync("ls", ["-lde", path.join(f.project, "target")], { encoding: "utf8" }),
      /0: everyone/,
    );
  },
);

test("metadata copying can preserve target timestamps for saves", async (t) => {
  const { copyMetadata, readMetadata } = await metadata();
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.project, "source"), "wx+");
  const target = await fs.open(path.join(f.project, "target"), "wx+");
  t.after(async () => {
    await source.close();
    await target.close();
  });
  await source.utimes(1234567890.125, 1234567891.25);
  await target.utimes(1234567899.5, 1234567899.75);
  const before = await readMetadata(target);
  await copyMetadata(source, target, { strictOwnership, preserveTimes: false });
  const after = await readMetadata(target);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.atimeNs, before.atimeNs);
});

test(
  "Linux's unsupported user xattr namespace on a pinned link cannot modify its target",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await fileFixture(t);
    const { attachAttributes, observeAttributes } =
      await import("../helpers/file-native-metadata.js");
    const { linuxMetadataFunctions } =
      await import("../../server/features/files/file-native-linux.js");
    const { checkedNative } =
      await import("../../server/features/files/file-native-metadata.js");
    const { default: koffi } = await import("koffi");
    const outside = await fs.open(path.join(f.home, "outside"), "wx+");
    t.after(() => outside.close());
    await outside.writeFile("sentinel");
    attachAttributes(
      outside.fd,
      "user.agentpier-target",
      Buffer.from("sentinel attribute"),
    );
    await fs.symlink(path.join(f.home, "outside"), path.join(f.project, "link"));
    const link = await fs.open(
      path.join(f.project, "link"),
      0x200000 | (process.arch === "arm64" ? 0x8000 : 0x20000),
    );
    t.after(() => link.close());
    await fs.rename(path.join(f.project, "link"), path.join(f.project, "kept"));
    await fs.symlink(path.join(f.home, "outside"), path.join(f.project, "link"));
    const functions = linuxMetadataFunctions(koffi.load(null), checkedNative);
    assert.throws(
      () =>
        functions.set(link.fd, "user.agentpier-target", Buffer.from("must not arrive")),
      { code: "EPERM" },
    );
    assert.deepEqual(observeAttributes(outside.fd), [
      { name: "user.agentpier-target", value: Buffer.from("sentinel attribute") },
    ]);
    assert.equal(await fs.readFile(path.join(f.home, "outside"), "utf8"), "sentinel");
  },
);

test(
  "real oversized metadata is rejected before changing target metadata or either file's bytes",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { copyMetadata } = await metadata();
    const f = await fileFixture(t);
    const { attachAttributes, observeAttributes } =
      await import("../helpers/file-native-metadata.js");
    const source = await fs.open(path.join(f.project, "source"), "wx+");
    const target = await fs.open(path.join(f.project, "target"), "wx+");
    t.after(async () => {
      await source.close();
      await target.close();
    });
    await source.writeFile("source");
    await source.chmod(0o750);
    await target.writeFile("target");
    for (let count = 0; count < 257; count++)
      attachAttributes(source.fd, `user.agentpier-${count}`, Buffer.from("x"));
    const targetBefore = await target.stat({ bigint: true });
    await assert.rejects(
      copyMetadata(source, target, { strictOwnership, preserveTimes: true }),
      { code: "FILE_METADATA_LIMIT" },
    );
    const targetAfter = await target.stat({ bigint: true });
    assert.equal(targetAfter.mode, targetBefore.mode);
    assert.equal(targetAfter.ctimeNs, targetBefore.ctimeNs);
    assert.equal(observeAttributes(source.fd).length, 257);
    assert.equal(await fs.readFile(path.join(f.project, "source"), "utf8"), "source");
    assert.equal(await fs.readFile(path.join(f.project, "target"), "utf8"), "target");
  },
);

test("draining native shutdown never closes a queued borrowed metadata descriptor", async (t) => {
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.project, "source"), "wx+");
  t.after(() => source.close());
  await source.chmod(0o750);
  const native = new FileNative();
  t.after(() => native.close());
  const reading = native.run("readBorrowedMetadata", { handle: source.fd });
  const closing = native.close();
  assert.equal((await reading).mode, 0o750);
  await closing;
  assert.equal((await source.stat()).isFile(), true);
});

test("metadata copying to the same inode is a no-op and incompatible inode types fail before mutation", async (t) => {
  const { copyMetadata } = await metadata();
  const f = await fileFixture(t);
  const source = await fs.open(path.join(f.project, "source"), "wx+");
  await source.writeFile("same inode");
  await fs.link(path.join(f.project, "source"), path.join(f.project, "hardlink"));
  const alias = await fs.open(path.join(f.project, "hardlink"), "r+");
  await fs.mkdir(path.join(f.project, "directory"));
  const directory = await fs.open(path.join(f.project, "directory"), "r");
  t.after(async () => {
    await source.close();
    await alias.close();
    await directory.close();
  });
  const before = await source.stat({ bigint: true });
  assert.deepEqual(
    await copyMetadata(source, alias, { strictOwnership: true, preserveTimes: true }),
    { warnings: [] },
  );
  assert.equal((await source.stat({ bigint: true })).ctimeNs, before.ctimeNs);
  const directoryBefore = await directory.stat({ bigint: true });
  await assert.rejects(
    copyMetadata(source, directory, { strictOwnership, preserveTimes: true }),
    { code: "FILE_UNSUPPORTED_TYPE" },
  );
  assert.equal((await directory.stat({ bigint: true })).ctimeNs, directoryBefore.ctimeNs);
});

test("metadata fingerprints use deterministic attribute ordering across host locales", async () => {
  const { metadataFingerprint } = await metadata();
  const value = {
    mode: 0o600,
    uid: 1,
    gid: 2,
    acl: null,
    xattrs: [
      { name: "user.ä", value: Buffer.from("a") },
      { name: "user.z", value: Buffer.from("z") },
    ],
  };
  assert.equal(
    metadataFingerprint(value),
    "48cfa619225a64614abf097957155eda3e3f4d93b94b09e4a63aca23f85069aa",
  );
});
