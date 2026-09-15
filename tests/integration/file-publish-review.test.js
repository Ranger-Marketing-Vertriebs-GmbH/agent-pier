import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "../helpers/file-publisher.js";
import { fileRevision } from "../../server/features/files/file-publish.js";
import { validateNativeRequest } from "../../server/features/files/file-native.js";
import { resolveFile } from "../../server/features/files/file-paths.js";

test("generic native writes allow configured workloads above the upload default", () => {
  assert.doesNotThrow(() =>
    validateNativeRequest("write", {
      handle: 1,
      bytes: Buffer.from("x"),
      position: 11 * 1024 ** 3,
    }),
  );
  assert.throws(
    () =>
      validateNativeRequest("write", {
        handle: 1,
        bytes: Buffer.from("xx"),
        position: Number.MAX_SAFE_INTEGER,
      }),
    { code: "FILE_INVALID_PATH" },
  );
});

test("revision streaming does not mistake an upload default for a copy/archive limit", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "fixture");
  const stat = await fs.stat(f.target, { bigint: true });
  let reads = 0;
  const sentinel = Error("first bounded read reached");
  await assert.rejects(
    fileRevision({
      stat: async () => ({ ...stat, type: "file", size: 11n * 1024n ** 3n }),
      read: async (buffer, offset, length, position) => {
        reads++;
        assert.equal(length, 65536);
        assert.equal(position, 0);
        throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );
  assert.equal(reads, 1);
});

async function bounded(operation) {
  return Promise.race([
    operation.then(
      () => ({ completed: true }),
      (error) => ({ error }),
    ),
    delay(100).then(() => ({ timedOut: true })),
  ]);
}

test("awaited publication inside a covering path lease rejects before self-queueing", async (t) => {
  const f = await fixture(t),
    stage = await f.stage();
  await stage.handle.writeFile("retained");
  let publication, outcome;
  await f.locks.withPaths([f.home], async () => {
    publication = f.publisher.publish(f.globalScope, stage, { expectedRevision: null });
    outcome = await bounded(publication);
  });
  await publication.catch(() => {});
  assert.equal(outcome.error?.code, "FILE_INVALID_OPERATION");
  assert.equal(f.locks.queue.length, 0);
  assert.equal(await fs.readFile(stage.file, "utf8"), "retained");
});

test("staging rejects an outer barrier lease even with an independent snapshot queued", async (t) => {
  const f = await fixture(t);
  let stage, snapshot, outcome;
  await f.barrier.run(async () => {
    snapshot = f.barrier.detached(() => f.barrier.snapshot(async () => {}));
    stage = f.stage();
    outcome = await bounded(stage);
  });
  await Promise.allSettled([stage, snapshot]);
  assert.equal(outcome.error?.code, "FILE_INVALID_OPERATION");
  assert.equal(f.store.listPublications().length, 0);
  assert.equal(f.barrier.queue.length, 0);
});

test("a selected symlink replaced with the same target during late hashing conflicts", async (t) => {
  const f = await fixture(t),
    link = `${f.target}.link`;
  await fs.writeFile(f.target, "original");
  await fs.symlink(f.target, link);
  const selected = await resolveFile(f.globalScope, link, { followLeaf: true });
  const source = await fs.open(f.target, "r");
  const revision = await fileRevision(source, selected.linkIdentity);
  await source.close();
  const stage = await f.publisher.stage(f.globalScope, link, {
    jobId: f.jobId,
    followLeaf: true,
  });
  await stage.handle.writeFile("replacement");
  const run = f.native.run.bind(f.native);
  let exchanged = false,
    replaced = false;
  f.native.run = async (op, args) => {
    if (exchanged && op === "read" && !replaced) {
      replaced = true;
      await fs.rename(link, `${link}.retained`);
      await fs.symlink(f.target, link);
    }
    const result = await run(op, args);
    if (op === "exchange") exchanged = true;
    return result;
  };
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(replaced, true);
  assert.notEqual(
    (await resolveFile(f.globalScope, link, { followLeaf: true })).linkIdentity,
    selected.linkIdentity,
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
});
