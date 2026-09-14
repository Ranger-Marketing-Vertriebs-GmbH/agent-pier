import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

test("text reads count actual bytes including BOM, reject binary/invalid UTF8, and metadata reads no contents", async (t) => {
  const f = await uploadFixture(t, { textBytes: 1024 }),
    target = path.join(f.home, "bound");
  for (const bytes of [
    Buffer.from([0xff, 0xfe, 65, 0]),
    Buffer.from([0xc0, 0x80]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from("a\0b"),
    Buffer.from([65, 1]),
  ]) {
    await fs.writeFile(target, bytes);
    await assert.rejects(f.text.read(f.scope, target), { code: "FILE_UNSUPPORTED_TYPE" });
  }
  await fs.writeFile(
    target,
    Buffer.concat([Buffer.from("\uFEFF"), Buffer.alloc(1021, 97)]),
  );
  assert.equal((await f.text.read(f.scope, target)).text.length, 1021);
  await fs.appendFile(target, "x");
  await assert.rejects(f.text.read(f.scope, target), { code: "FILE_LIMIT_EXCEEDED" });
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = (op, args) => {
    assert.notEqual(op, "read", "document metadata must not hash or read bytes");
    return run(op, args);
  };
  assert.match((await f.text.metadata(f.scope, target)).metadataRevision, /^e1:/);
});

test("growth during a descriptor read stops at the byte cap; long work holds no physical leases", async (t) => {
  const f = await uploadFixture(t, { textBytes: 1024 }),
    target = path.join(f.home, "growth");
  await fs.writeFile(target, "a".repeat(1024));
  const run = f.publisher.native.run.bind(f.publisher.native);
  let grew = false;
  f.publisher.native.run = async (op, args) => {
    if (["read", "write", "readMetadata", "copyMetadata"].includes(op)) {
      assert.equal(f.barrier.active, 0, op);
      assert.equal(f.locks.active.size, 0, op);
    }
    const result = await run(op, args);
    if (op === "read" && !grew) {
      grew = true;
      await fs.appendFile(target, "b");
    }
    return result;
  };
  await assert.rejects(f.text.read(f.scope, target), { code: "FILE_LIMIT_EXCEEDED" });
  await f.text.save(f.scope, path.join(f.home, "new"), Buffer.from("accepted"), {
    revision: null,
    requestId: uploadRequest(),
  });
});

test("missing OS file or resolved-parent write permission forbids replacement and permits independent Save As", async (t) => {
  const f = await uploadFixture(t),
    directory = path.join(f.home, "locked"),
    target = path.join(directory, "note");
  await fs.mkdir(directory);
  await fs.writeFile(target, "original");
  for (const subject of [target, directory]) {
    await fs.chmod(subject, subject === target ? 0o400 : 0o500);
    try {
      const doc = await f.text.read(f.scope, target);
      assert.equal(doc.readOnly, true);
      await assert.rejects(
        f.text.save(f.scope, target, Buffer.from("draft"), {
          revision: doc.revision,
          requestId: uploadRequest(),
        }),
        { code: "FILE_ACCESS_DENIED" },
      );
      assert.equal(await fs.readFile(target, "utf8"), "original");
      assert.equal(f.store.listPublications().length, 0);
    } finally {
      await fs.chmod(subject, subject === target ? 0o600 : 0o700);
    }
  }
  await f.text.save(f.scope, path.join(f.home, "independent"), Buffer.from("draft"), {
    revision: null,
    requestId: uploadRequest(),
  });
});

test("admission copies caller bytes, uses the shared queue, and joins one immutable writer", async (t) => {
  const f = await uploadFixture(t, { transfers: 1 }),
    target = path.join(f.home, "queued"),
    requestId = uploadRequest();
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const run = f.publisher.native.run.bind(f.publisher.native);
  let publications = 0;
  f.publisher.native.run = async (op, args) => {
    if (op === "write") {
      entered.resolve();
      await gate.promise;
    }
    if (op === "renameNoReplace") publications++;
    return run(op, args);
  };
  const bytes = Buffer.from("accepted");
  const first = f.text.save(f.scope, target, bytes, { revision: null, requestId });
  bytes.fill(120);
  try {
    await entered.promise;
    const duplicate = f.text.save(f.scope, target, Buffer.from("accepted"), {
      revision: null,
      requestId,
    });
    duplicate.catch(() => {});
    const queued = f.text.save(f.scope, target + "2", Buffer.from("second"), {
      revision: null,
      requestId: uploadRequest(),
    });
    await f.until(() => f.jobs.pending.length === 1);
    assert.equal(
      f.store.listPublications().length,
      1,
      "queued saves allocate no physical stage",
    );
    await assert.rejects(
      f.text.save(f.scope, target, Buffer.from("changed"), { revision: null, requestId }),
      { code: "FILE_REQUEST_CONFLICT" },
    );
    gate.resolve();
    assert.deepEqual(await first, await duplicate);
    await queued;
    assert.equal(await fs.readFile(target, "utf8"), "accepted");
    assert.equal(publications, 2, "one publication for each distinct request");
  } finally {
    gate.resolve();
    await first.catch(() => {});
  }
});

test("incomplete metadata capability makes a readable document read-only before any stage", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "capability");
  await fs.writeFile(target, "original");
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    return op === "readMetadata"
      ? { ...result, completeness: { complete: false, reason: "namespace_visibility" } }
      : result;
  };
  const document = await f.text.read(f.scope, target);
  assert.equal(document.readOnly, true);
  assert.equal(document.text, "original");
  await assert.rejects(
    f.text.save(f.scope, target, Buffer.from("draft"), {
      revision: document.revision,
      requestId: uploadRequest(),
    }),
    { code: "FILE_METADATA_UNSUPPORTED" },
  );
  assert.equal(f.store.listPublications().length, 0);
  assert.equal(await fs.readFile(target, "utf8"), "original");
});
