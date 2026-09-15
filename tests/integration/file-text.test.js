import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { serializeDocument } from "../../web/features/files/file-text-format.js";

const save = (f, target, bytes, revision = null, requestId = uploadRequest()) =>
  f.text.save(f.scope, target, Buffer.from(bytes), { revision, requestId });

test("documents and content-free metadata share d1/e1 observations and exact format", async (t) => {
  const f = await uploadFixture(t);
  assert.ok(f.text, "application composes text owner");
  for (const bytes of [
    "",
    "\uFEFF",
    "\uFEFF\uFEFFa",
    "a\nb\n\n",
    "\uFEFFa\r\nb",
    "a\rb\n",
  ]) {
    const target = path.join(f.home, "format.txt");
    await fs.writeFile(target, bytes);
    const doc = await f.text.read(f.scope, target);
    const observation = await f.text.metadata(f.scope, target);
    assert.deepEqual(Object.keys(observation).sort(), [
      "metadataRevision",
      "path",
      "resolvedPath",
    ]);
    assert.equal(observation.metadataRevision, doc.metadataRevision);
    assert.match(doc.revision, /^d1:[a-f0-9]{64}$/);
    if (doc.lineEnding !== "mixed")
      assert.deepEqual(Buffer.from(serializeDocument(doc, doc.text)), Buffer.from(bytes));
    else assert.equal(bytes, "a\rb\n");
  }
});

test("bounded creation and immutable response replay survives later edits and restart", async (t) => {
  const f = await uploadFixture(t);
  const target = path.join(f.home, "new.txt"),
    requestId = uploadRequest();
  const result = await save(f, target, "created", null, requestId);
  assert.equal(
    result.metadataRevision,
    (await f.text.metadata(f.scope, target)).metadataRevision,
  );
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600 & ~process.umask());
  await fs.writeFile(target, "external later");
  assert.deepEqual(await save(f, target, "created", null, requestId), result);
  await assert.rejects(save(f, target, "changed", null, requestId), {
    code: "FILE_REQUEST_CONFLICT",
  });
  await f.restart();
  assert.deepEqual(await save(f, target, "created", null, requestId), result);
  assert.equal(await fs.readFile(target, "utf8"), "external later");
});

test("ordinary stale or deleted documents never publish, while Save As creates independently", async (t) => {
  const f = await uploadFixture(t);
  const target = path.join(f.home, "note");
  await fs.writeFile(target, "before");
  const old = await f.text.read(f.scope, target);
  await fs.writeFile(target, "writer");
  await assert.rejects(save(f, target, "draft", old.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
  await fs.unlink(target);
  await assert.rejects(save(f, target, "draft", old.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(await fs.stat(target).catch(() => null), null);
  await save(f, target, "draft");
  assert.equal(await fs.readFile(target, "utf8"), "draft");
});

test("strict existing save preserves original metadata or refuses incomplete Linux capability", async (t) => {
  const f = await uploadFixture(t);
  const target = path.join(f.home, "old");
  await fs.writeFile(target, "before", { mode: 0o640 });
  await fs.utimes(target, 100, 100);
  const before = await fs.stat(target),
    doc = await f.text.read(f.scope, target);
  if (process.platform === "linux") {
    assert.equal(doc.readOnly, true);
    await assert.rejects(save(f, target, "after", doc.revision), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
    assert.equal(await fs.readFile(target, "utf8"), "before");
  } else {
    assert.equal(doc.readOnly, false);
    const result = await save(f, target, "after", doc.revision);
    assert.equal(
      result.metadataRevision,
      (await f.text.metadata(f.scope, target)).metadataRevision,
    );
    const after = await fs.stat(target);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.notEqual(after.mtimeMs, before.mtimeMs);
    const trash = await f.trash.list(f.scope);
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].availability, "recoverable");
  }
});

test("hardlinks remain read-only and fresh independent Save As does not alter their inode", async (t) => {
  const f = await uploadFixture(t);
  const target = path.join(f.home, "hard");
  await fs.writeFile(target, "shared");
  await fs.link(target, target + "2");
  const doc = await f.text.read(f.scope, target);
  assert.equal(doc.readOnly, true);
  await assert.rejects(save(f, target, "draft", doc.revision), {
    code: "FILE_READ_ONLY",
  });
  await save(f, target + "3", "draft");
  assert.equal(await fs.readFile(target + "2", "utf8"), "shared");
});

test("selected link and resolved parent stay separate and retargeting invalidates observations", async (t) => {
  const f = await uploadFixture(t);
  await fs.mkdir(path.join(f.home, "elsewhere"));
  const target = path.join(f.home, "elsewhere", "target"),
    link = path.join(f.home, "selected");
  await fs.writeFile(target, "before");
  await fs.symlink(target, link);
  const doc = await f.text.read(f.scope, link);
  assert.equal(doc.path, link);
  assert.equal(doc.resolvedPath, target);
  assert.equal(
    doc.metadataRevision,
    (await f.text.metadata(f.scope, link)).metadataRevision,
  );
  if (process.platform !== "linux") {
    await save(f, link, "after", doc.revision);
    assert.equal(await fs.readFile(target, "utf8"), "after");
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  }
  const current = await f.text.read(f.scope, link);
  await fs.unlink(link);
  await fs.symlink(target, link);
  assert.notEqual(
    current.metadataRevision,
    (await f.text.metadata(f.scope, link)).metadataRevision,
  );
  await assert.rejects(save(f, link, "no", current.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
});
