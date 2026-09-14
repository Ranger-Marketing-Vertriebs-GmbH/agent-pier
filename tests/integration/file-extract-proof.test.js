import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";

test("publication retains the certified original-name witness and parent policy journal", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(source, extractionZip([{ name: "a", bytes: "payload" }]));
  const run = f.publisher.native.run.bind(f.publisher.native);
  let observed = false;
  f.publisher.native.run = (op, args) => {
    if (op === "renameNoReplace" && args.newName === "a") {
      const output = f.store
        .listPublications()
        .find((record) => record.document.extract?.role === "output");
      assert.ok(output.document.extractProof);
      const probe = f.store.getPublication(output.document.extractProof.publicationId);
      assert.equal(probe.document.extractNamesValidated, 1);
      assert.equal(probe.document.extractDiscarded, true);
      assert.equal(probe.document.extractPolicy.identity, output.document.targetParent);
      assert.deepEqual(probe.document.extractPolicy, output.document.extractProof.policy);
      assert.equal(f.store.getEntry(output.jobId, "0").witness.stageId, probe.id);
      observed = true;
    }
    return run(op, args);
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.equal(observed, true);
});

test("a later planned target changing during preparation refuses the entire fanout", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "a", bytes: "first" },
      { name: "b", bytes: "second" },
    ]),
  );
  const run = f.publisher.native.run.bind(f.publisher.native);
  let changed = false;
  f.publisher.native.run = async (op, args) => {
    const value = await run(op, args);
    if (!changed && op === "write") {
      changed = true;
      await fs.writeFile(path.join(f.project, "b"), "native arrival");
    }
    return value;
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "FILE_CONFLICT_CHANGED");
  assert.deepEqual(await fs.readdir(f.project), ["b"]);
  assert.equal(await fs.readFile(path.join(f.project, "b"), "utf8"), "native arrival");
});

for (const change of ["source", "scope", "inheritance"])
  test(`changed ${change} evidence refuses all output`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(source, extractionZip([{ name: "a", bytes: "payload" }]));
    const run = f.publisher.native.run.bind(f.publisher.native),
      probes = new Set();
    let changed = false;
    f.publisher.native.run = async (op, args) => {
      const result = await run(op, args);
      if (op === "createDirectory" && args.name === "content") probes.add(result.handle);
      if (change === "inheritance" && op === "namePolicy" && probes.has(args.handle)) {
        changed = true;
        return { ...result, caseFlags: result.caseFlags ^ 0x100 };
      }
      if (!changed && op === "write") {
        changed = true;
        if (change === "source") await fs.appendFile(source, "changed source revision");
        else if (change === "scope")
          f.extracts.context = async () => ({ ...f.scope, readOnly: true });
      }
      return result;
    };
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    const result = await f.jobs.join(f.scope, job.id);
    assert.equal(result.status, "failed");
    assert.equal(
      result.issue.code,
      {
        source: "FILE_CONFLICT_CHANGED",
        scope: "FILE_READ_ONLY",
        inheritance: "FILE_EXTRACT_UNSUPPORTED",
      }[change],
    );
    assert.equal(changed, true);
    assert.deepEqual(await fs.readdir(f.project), []);
  });

test("extraction admission shares transfer slots and queued cancellation opens no source", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(source, extractionZip(["a"]));
  const gate = Promise.withResolvers();
  const occupied = Array.from({ length: 3 }, () =>
    f.jobs.runDirectTransfer(f.scope, () => gate.promise),
  );
  await f.until(() => f.jobs.transfers === 3);
  const run = f.publisher.native.run.bind(f.publisher.native);
  let opened = 0;
  f.publisher.native.run = (op, args) => {
    if (op === "openFile" && args.path === "input.zip") opened++;
    return run(op, args);
  };
  try {
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    assert.equal(f.jobs.get(f.scope, job.id).status, "queued");
    assert.equal((await f.jobs.cancel(f.scope, job.id)).status, "cancelled");
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "cancelled");
    assert.equal(opened, 0);
  } finally {
    gate.resolve();
    await Promise.all(occupied);
  }
});

test("startup resumes a proven probe cleanup interrupted after unlink", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "a", bytes: "a" },
      { name: "b", bytes: "b" },
    ]),
  );
  const run = f.publisher.native.run.bind(f.publisher.native);
  let interrupted = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (!interrupted && op === "removeEntry" && args.name === "b") {
      interrupted = true;
      throw Error("lost cleanup completion checkpoint");
    }
    return result;
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
  assert.equal(interrupted, true);
  assert.equal((await fs.readdir(f.project)).length, 1);
  assert.ok((await fs.readdir(f.project))[0].startsWith(".agentpier-stage-"));
  await f.restart();
  assert.deepEqual(await fs.readdir(f.project), []);
  assert.ok(
    f.store
      .listPublications()
      .every((record) => record.phase === "resolved" && record.document.extractDiscarded),
  );
});

test("an uncheckpointed created witness is pinned, never adopted or guessed away", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(source, extractionZip([{ name: "a", bytes: "a" }]));
  const run = f.publisher.native.run.bind(f.publisher.native);
  let inserted = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (!inserted && op === "createFile" && args.name === "a") {
      inserted = true;
      await run("closeHandle", { handle: result.handle });
      throw Error("created but not checkpointed");
    }
    return result;
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
  const [directory] = await fs.readdir(f.project);
  const witness = path.join(f.project, directory, "content", "a");
  const before = await fs.stat(witness);
  await f.restart();
  assert.equal((await fs.stat(witness)).ino, before.ino);
  assert.equal(f.store.listPublications().length, 1);
  assert.equal(f.jobs.get(f.scope, job.id).completedEntries, 0);
});

for (const afterOutput of [false, true])
  test(`an observed name policy change ${afterOutput ? "after" : "before"} first output invalidates proof`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(
      source,
      extractionZip([
        { name: "a", bytes: "a" },
        { name: "b", bytes: "b" },
      ]),
    );
    const run = f.publisher.native.run.bind(f.publisher.native);
    let writes = 0,
      published = 0;
    f.publisher.native.run = async (op, args) => {
      const result = await run(op, args);
      if (op === "write") writes++;
      if (op === "renameNoReplace" && ["a", "b"].includes(args.newName)) published++;
      if (op === "namePolicy" && (afterOutput ? published : writes))
        return { ...result, caseFlags: result.caseFlags ^ 0x100 };
      return result;
    };
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    const result = await f.jobs.join(f.scope, job.id);
    assert.equal(result.status, afterOutput ? "partially_completed" : "failed");
    assert.equal(result.issue.code, "FILE_PATH_CHANGED");
    assert.deepEqual(await fs.readdir(f.project), afterOutput ? ["a"] : []);
    assert.equal(published, afterOutput ? 1 : 0);
  });
