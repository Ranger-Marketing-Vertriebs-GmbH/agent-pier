import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

test("a snapshot proceeds while a gated text descriptor read holds no physical lease", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "read");
  await fs.writeFile(target, "x".repeat(150000));
  const run = f.publisher.native.run.bind(f.publisher.native),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let gated = false;
  f.publisher.native.run = async (op, args) => {
    if (op === "read" && !gated) {
      gated = true;
      entered.resolve();
      await gate.promise;
    }
    return run(op, args);
  };
  const reading = f.text.read(f.scope, target);
  try {
    await entered.promise;
    assert.equal(f.barrier.active, 0);
    assert.equal(f.locks.active.size, 0);
    assert.equal(
      await f.barrier.snapshot(() => "independent snapshot"),
      "independent snapshot",
    );
  } finally {
    gate.resolve();
  }
  assert.equal((await reading).text.length, 150000);
});

test("an injected first close failure still closes every owned read descriptor", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "close");
  await fs.writeFile(target, "accepted");
  const run = f.publisher.native.run.bind(f.publisher.native),
    handles = new Set();
  let failed = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (["openRoot", "openFile"].includes(op)) handles.add(result.handle);
    if (op === "closeHandle") {
      handles.delete(args.handle);
      if (!failed) {
        failed = true;
        throw new Error("fixture first close failure");
      }
    }
    return result;
  };
  await assert.rejects(f.text.read(f.scope, target));
  assert.equal(failed, true);
  assert.equal(handles.size, 0);
});

test("shutdown drains accepted staged bytes and releases all text owners before store close", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "shutdown");
  const run = f.publisher.native.run.bind(f.publisher.native),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const handles = new Set();
  f.publisher.native.run = async (op, args) => {
    if (op === "write") {
      entered.resolve();
      await gate.promise;
    }
    const result = await run(op, args);
    if (["openRoot", "openFile", "createDirectory", "createFile"].includes(op))
      handles.add(result.handle);
    if (op === "closeHandle") handles.delete(args.handle);
    return result;
  };
  const saving = f.text
    .save(f.scope, target, Buffer.from("accepted"), {
      revision: null,
      requestId: uploadRequest(),
    })
    .catch((error) => error);
  await entered.promise;
  const closing = f.close();
  gate.resolve();
  const outcome = await saving;
  await closing;
  assert.equal(outcome.code, "FILE_CANCELLED");
  assert.equal(f.text.bodies.size, 0);
  assert.equal(f.text.pending.size, 0);
  assert.equal(handles.size, 0);
  assert.equal(await fs.stat(target).catch(() => null), null);
  assert.equal(
    (await fs.readdir(f.home)).some((name) => name.startsWith(".agentpier-stage-")),
    false,
  );
});

test("an existing generic request ID cannot acquire text authority and private retries stay unavailable", async (t) => {
  const f = await uploadFixture(t),
    requestId = uploadRequest(),
    target = path.join(f.home, "bound");
  const generic = await f.jobs.start(f.scope, {
    requestId,
    kind: "create_file",
    sources: [],
    target: f.home,
    name: "generic",
    options: {},
  });
  await f.jobs.join(f.scope, generic.id);
  await assert.rejects(
    f.text.save(f.scope, target, Buffer.from("draft"), { revision: null, requestId }),
    { code: "FILE_REQUEST_CONFLICT" },
  );
  const failedId = uploadRequest();
  await fs.writeFile(target, "original");
  await assert.rejects(
    f.text.save(f.scope, target, Buffer.from("draft"), {
      revision: null,
      requestId: failedId,
    }),
  );
  const job = f.jobs.list(f.scope).jobs.find((job) => job.kind === "text_save");
  assert.equal(job.uploadGroupId, undefined);
  await assert.rejects(f.retries.preview(f.scope, job.id), {
    code: "FILE_RETRY_UNAVAILABLE",
  });
  await assert.rejects(
    f.jobs.start(f.scope, {
      ...f.store.getOperation(job.id),
      requestId: uploadRequest(),
      parentJobId: generic.id,
      entryId: "forged",
    }),
    { code: "FILE_INVALID_OPERATION" },
  );
  assert.equal(await fs.readFile(target, "utf8"), "original");
});
