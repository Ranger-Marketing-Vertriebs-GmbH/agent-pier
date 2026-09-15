import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

const save = (f, target, bytes, revision, requestId) =>
  f.text.save(f.scope, target, Buffer.from(bytes), { revision, requestId });
const recordFor = (f) => f.store.listPublications().find((row) => row.document.textSave);
const countPublications = (f) => {
  const run = f.publisher.native.run.bind(f.publisher.native),
    counts = { exchange: 0, renameNoReplace: 0 };
  f.publisher.native.run = async (op, args) => {
    if (Object.hasOwn(counts, op)) counts[op]++;
    return run(op, args);
  };
  return counts;
};

for (const boundary of ["native", "pair", "cleanup"])
  test(`restart finalizes a proven create after ${boundary} failure without a second publication`, async (t) => {
    const f = await uploadFixture(t),
      target = path.join(f.home, "saved"),
      requestId = uploadRequest();
    const counts = countPublications(f);
    if (boundary === "native") {
      const run = f.publisher.native.run.bind(f.publisher.native);
      f.publisher.native.run = async (op, args) => {
        const result = await run(op, args);
        if (op === "renameNoReplace")
          throw new Error("fixture post-publication disconnect");
        return result;
      };
    } else {
      const put = f.store.putPublication.bind(f.store);
      f.store.putPublication = (record) => {
        put(record);
        if (
          boundary === "pair"
            ? record.document.textCompleted
            : record.phase === "resolved"
        )
          throw new Error("fixture durable checkpoint failure");
      };
    }
    await assert.rejects(save(f, target, "accepted", null, requestId));
    assert.equal(await fs.readFile(target, "utf8"), "accepted");
    const original = f.store.text.get(recordFor(f).jobId).result;
    if (boundary !== "cleanup") {
      assert.equal(
        original,
        undefined,
        "transaction rollback does not expose an uncommitted pair",
      );
      assert.equal(recordFor(f).document.textCompleted, undefined);
    } else assert.match(original.revision, /^d1:/);
    assert.equal(counts.renameNoReplace, 1);
    await f.restart();
    const after = countPublications(f),
      result = await save(f, target, "accepted", null, requestId);
    assert.equal(f.jobs.get(f.scope, recordFor(f).jobId).status, "completed");
    if (original) assert.deepEqual(result, original);
    else
      assert.equal(
        result.metadataRevision,
        (await f.text.metadata(f.scope, target)).metadataRevision,
      );
    await fs.writeFile(target, "later writer");
    // Resolved journal pruning cannot remove the pair kept by the request's job.
    f.store.db.prepare("DELETE FROM publications WHERE phase='resolved'").run();
    await f.restart();
    assert.deepEqual(await save(f, target, "accepted", null, requestId), result);
    assert.equal(await fs.readFile(target, "utf8"), "later writer");
    assert.deepEqual(after, { exchange: 0, renameNoReplace: 0 });
  });

test("unproven edited output stays interrupted through two restarts without fabricated success", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "changed"),
    requestId = uploadRequest();
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "renameNoReplace") throw new Error("fixture publication interruption");
    return result;
  };
  await assert.rejects(save(f, target, "accepted", null, requestId));
  await fs.writeFile(target, "external");
  for (let n = 0; n < 2; n++) {
    await f.restart();
    const counts = countPublications(f);
    await assert.rejects(save(f, target, "accepted", null, requestId));
    assert.equal(f.store.text.get(recordFor(f).jobId).result, undefined);
    assert.notEqual(recordFor(f).phase, "resolved");
    assert.equal(await fs.readFile(target, "utf8"), "external");
    assert.deepEqual(counts, { exchange: 0, renameNoReplace: 0 });
  }
});

test("displaced adoption must finish before full success and retains the exact original pair", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "replace"),
    requestId = uploadRequest();
  await fs.writeFile(target, "original");
  const doc = await f.text.read(f.scope, target),
    counts = countPublications(f);
  if (process.platform === "linux") {
    await assert.rejects(save(f, target, "accepted", doc.revision, requestId), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
    assert.deepEqual(counts, { exchange: 0, renameNoReplace: 0 });
    return;
  }
  f.trash.adoptDisplaced = async () => {
    throw new Error("fixture adoption interruption");
  };
  await assert.rejects(save(f, target, "accepted", doc.revision, requestId));
  const record = recordFor(f),
    saved = f.store.text.get(record.jobId);
  assert.equal(saved.complete, undefined);
  assert.match(saved.result.revision, /^d1:/);
  assert.equal(await fs.readFile(record.document.staged, "utf8"), "original");
  assert.equal(await fs.readFile(target, "utf8"), "accepted");
  assert.equal(counts.exchange, 1);
  await f.restart();
  assert.deepEqual(
    await save(f, target, "accepted", doc.revision, requestId),
    saved.result,
  );
  const trash = await f.trash.list(f.scope);
  assert.equal(trash.entries.length, 1);
  assert.equal(trash.entries[0].availability, "recoverable");
  await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
  assert.equal(f.store.getPublication(record.id), null);
  await fs.writeFile(target, "external");
  await f.restart();
  assert.deepEqual(
    await save(f, target, "accepted", doc.revision, requestId),
    saved.result,
  );
  assert.equal((await f.trash.list(f.scope)).entries.length, 1);
});

test("publication resolution alone cannot report success before the central adoption final marker", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "final-marker"),
    requestId = uploadRequest();
  await fs.writeFile(target, "original");
  const document = await f.text.read(f.scope, target);
  if (process.platform === "linux") {
    await assert.rejects(save(f, target, "accepted", document.revision, requestId), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
    assert.equal(await fs.readFile(target, "utf8"), "original");
    return;
  }
  const write = f.trash.save.bind(f.trash);
  f.trash.save = async (record) => {
    if (record.adoptionComplete) throw new Error("fixture final adoption marker failure");
    return write(record);
  };
  await assert.rejects(save(f, target, "accepted", document.revision, requestId));
  const publication = recordFor(f),
    saved = f.store.text.get(publication.jobId),
    displaced = f.store.getTrash(publication.id);
  assert.equal(publication.phase, "resolved");
  assert.equal(displaced.adoptionSource.containerRemoved, true);
  assert.equal(displaced.adoptionComplete, undefined);
  assert.equal(saved.complete, undefined);
  assert.equal(await fs.readFile(displaced.location.file, "utf8"), "original");
  await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
  assert.ok(
    f.store.getPublication(publication.id),
    "uncommitted final adoption pins its required publication proof",
  );
  await fs.writeFile(target, "external before final adoption");
  await f.restart();
  assert.deepEqual(
    await save(f, target, "accepted", document.revision, requestId),
    saved.result,
  );
  assert.equal(f.store.getTrash(publication.id).adoptionComplete, true);
  assert.equal((await f.trash.list(f.scope)).entries.length, 1);
  await fs.writeFile(target, "external");
  await f.restart();
  assert.deepEqual(
    await save(f, target, "accepted", document.revision, requestId),
    saved.result,
  );
});

test("metadata failure cleans only proven unpublished bytes and never exchanges the original", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "metadata");
  await fs.writeFile(target, "original");
  const doc = await f.text.read(f.scope, target),
    counts = countPublications(f);
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "copyMetadata")
      throw Object.assign(new Error("fixture metadata mismatch"), {
        code: "FILE_METADATA_MISMATCH",
        status: 409,
      });
    return result;
  };
  await assert.rejects(save(f, target, "draft", doc.revision, uploadRequest()), {
    code:
      process.platform === "linux"
        ? "FILE_METADATA_UNSUPPORTED"
        : "FILE_METADATA_MISMATCH",
  });
  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.deepEqual(counts, { exchange: 0, renameNoReplace: 0 });
  assert.equal(
    (await fs.readdir(f.home)).some((name) => name.startsWith(".agentpier-stage-")),
    false,
  );
});

for (const modified of [false, true])
  test(`failed partial staging ${modified ? "retains foreign bytes" : "removes a proven prefix"}`, async (t) => {
    const f = await uploadFixture(t),
      target = path.join(f.home, "partial");
    const run = f.publisher.native.run.bind(f.publisher.native);
    let writes = 0;
    f.publisher.native.run = async (op, args) => {
      if (op === "write" && ++writes === 2) {
        if (modified) await fs.writeFile(recordFor(f).document.staged, "foreign");
        throw new Error("fixture second write failure");
      }
      return run(op, args);
    };
    await assert.rejects(save(f, target, "x".repeat(150000), null, uploadRequest()));
    assert.equal(await fs.stat(target).catch(() => null), null);
    const record = recordFor(f);
    if (modified) {
      assert.equal(await fs.readFile(record.document.staged, "utf8"), "foreign");
      assert.notEqual(record.phase, "resolved");
      await f.restart();
      assert.equal(await fs.readFile(record.document.staged, "utf8"), "foreign");
    } else {
      assert.equal(record.phase, "resolved");
      assert.equal(await fs.stat(record.document.staged).catch(() => null), null);
      await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
      assert.equal(
        f.store.getPublication(record.id),
        null,
        "proven unpublished cleanup does not pin retention",
      );
    }
  });
