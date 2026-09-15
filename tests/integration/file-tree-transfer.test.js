import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "../helpers/file-publisher.js";

// A relative lookup must retain the selected directory, even after pathname replacement.
test("owned tree lookup and link reads preserve the retained parent", async (t) => {
  const f = await fixture(t);
  const tree = path.join(f.home, "tree");
  await fs.mkdir(tree);
  await fs.writeFile(path.join(tree, "keep"), "original");
  await fs.symlink("keep", path.join(tree, "link"));
  const root = await f.native.run("openRoot", { path: tree });
  await fs.rename(tree, `${tree}-moved`);
  await fs.symlink(f.project, tree);
  let lookup;
  try {
    lookup = await f.native.run("openLookup", { directory: root.handle, path: "" });
    const link = await f.native.run("openLink", {
      directory: lookup.handle,
      path: "link",
    });
    try {
      await fs.rename(
        path.join(`${tree}-moved`, "link"),
        path.join(`${tree}-moved`, "retained-link"),
      );
      await fs.symlink("other", path.join(`${tree}-moved`, "link"));
      assert.equal(await f.native.run("readLink", { handle: link.handle }), "keep");
    } finally {
      await f.native.run("closeHandle", { handle: link.handle });
    }
    assert.deepEqual(await fs.readdir(f.project), []);
  } finally {
    if (lookup) await f.native.run("closeHandle", { handle: lookup.handle });
    await f.native.run("closeHandle", { handle: root.handle });
  }
});

test("verified tree copy preserves bytes and link entries without removing the source", async (t) => {
  const f = await fixture(t);
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  const tree = path.join(f.home, "tree");
  await fs.mkdir(path.join(tree, "nested"), { recursive: true });
  await fs.writeFile(path.join(tree, "nested", "keep"), "original bytes");
  await fs.symlink("nested/keep", path.join(tree, "link"));
  const stage = await f.publisher.stage(f.globalScope, f.target, {
    jobId: f.jobId,
    type: "directory",
  });
  const warnings = [];
  const transfer = await copyVerified(f.globalScope, tree, stage, {
    strictMetadata: false,
    report: async ({ issue }) => {
      if (issue) warnings.push(issue.code);
    },
  });
  if (process.platform === "linux")
    assert.ok(warnings.includes("FILE_METADATA_UNSUPPORTED"));
  assert.equal(
    await fs.readFile(path.join(stage.file, "nested", "keep"), "utf8"),
    "original bytes",
  );
  assert.equal(await fs.readlink(path.join(stage.file, "link")), "nested/keep");
  assert.equal(
    await fs.readFile(path.join(tree, "nested", "keep"), "utf8"),
    "original bytes",
  );
  await transfer.assertSourceUnchanged();
  await transfer.removeMatchingSource();
  await assert.rejects(fs.lstat(tree), { code: "ENOENT" });
});

test("verified copy detects source change and retains every source entry", async (t) => {
  const f = await fixture(t);
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "before");
  const stage = await f.stage();
  const transfer = await copyVerified(f.globalScope, source, stage, {
    strictMetadata: false,
  });
  await fs.writeFile(source, "after");
  await assert.rejects(transfer.removeMatchingSource(), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(await fs.readFile(source, "utf8"), "after");
  assert.equal(await fs.readFile(stage.file, "utf8"), "before");
});

test("tree byte limits and strict metadata failure leave source intact", async (t) => {
  const f = await fixture(t);
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  const { readFileLimits } = await import("../../server/features/files/file-limits.js");
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "12345");
  const stage = await f.stage();
  await assert.rejects(
    copyVerified(f.globalScope, source, stage, {
      limits: readFileLimits({ jobBytes: 4 }),
      strictMetadata: false,
    }),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
  assert.equal(await fs.readFile(source, "utf8"), "12345");
  const second = await f.stage();
  if (process.platform === "linux") {
    await assert.rejects(
      copyVerified(f.globalScope, source, second, { strictMetadata: true }),
      { code: "FILE_METADATA_UNSUPPORTED" },
    );
    assert.equal(await fs.readFile(source, "utf8"), "12345");
  } else {
    await copyVerified(f.globalScope, source, second, { strictMetadata: true });
    assert.equal(await fs.readFile(second.file, "utf8"), "12345");
  }
});

test("non-UTF8 link text is rejected without altering the source link", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.home, "invalid-link");
  const raw = Buffer.from([0x61, 0xff, 0x62]);
  await fs.symlink(raw, source);
  const stage = await f.publisher.stage(f.globalScope, f.target, {
    jobId: f.jobId,
    type: "symlink",
  });
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  await assert.rejects(
    copyVerified(f.globalScope, source, stage, { strictMetadata: false }),
    { code: "FILE_UNSUPPORTED_TYPE" },
  );
  assert.deepEqual(await fs.readlink(source, { encoding: "buffer" }), raw);
});

test("verified copy rejects actual corrupted staged bytes and retains the source", async (t) => {
  const f = await fixture(t, (op, args, run) =>
    op === "write"
      ? run(op, { ...args, bytes: Buffer.alloc(args.bytes.length, 120) })
      : run(op, args),
  );
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "original");
  const stage = await f.stage();
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  await assert.rejects(
    copyVerified(f.globalScope, source, stage, { strictMetadata: false }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(source, "utf8"), "original");
});

test("deep tree transfer stays within the native handle budget", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.home, "deep");
  const relative = Array(70).fill("d").join("/");
  await fs.mkdir(path.join(source, relative), { recursive: true });
  await fs.writeFile(path.join(source, relative, "keep"), "deep bytes");
  const stage = await f.publisher.stage(f.globalScope, f.target, {
    jobId: f.jobId,
    type: "directory",
  });
  const { copyVerified } =
    await import("../../server/features/files/file-tree-transfer.js");
  const result = await copyVerified(f.globalScope, source, stage, {
    strictMetadata: false,
  });
  assert.equal(
    await fs.readFile(path.join(stage.file, relative, "keep"), "utf8"),
    "deep bytes",
  );
  assert.equal(result.manifest.length, 72);
});
