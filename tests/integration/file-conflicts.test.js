import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readMetadata,
  metadataFingerprint,
} from "../../server/features/files/file-metadata.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { fileErrorMessage } from "../../web/lib/i18n/messages/files.js";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";
import { submitCopy, copyFixture } from "../helpers/file-copy.js";

async function sourceRevisions(f, sources) {
  const revisions = {};
  for (const source of sources) {
    const response = await f.request(
      `/api/files/metadata?path=${encodeURIComponent(source)}`,
    );
    assert.equal(response.status, 200);
    revisions[source] = (await response.json()).revision;
    assert.match(revisions[source], /^e1:[a-f0-9]{64}$/);
  }
  return revisions;
}

async function startConflictingCopy(f) {
  const source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "same.txt"), "source data");
  await fs.writeFile(path.join(target, "same.txt"), "old target");
  const job = await submitCopy(f, [path.join(source, "same.txt")], target);
  return waitForFileJob(f, job.id, { states: ["waiting_for_conflict"] });
}
async function resolve(f, job, decision) {
  const context = await (await f.request("/api/files/context")).json();
  return f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "x-file-scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision, applyToRemaining: false },
  });
}
test("a changed destination invalidates a previous replace decision over actual HTTP", async (t) => {
  const f = await applicationFixture(t),
    job = await startConflictingCopy(f);
  await fs.writeFile(path.join(f.home, "target", "same.txt"), "new external data");
  assert.equal((await resolve(f, job, "replace")).status, 409);
  assert.equal(
    await fs.readFile(path.join(f.home, "target", "same.txt"), "utf8"),
    "new external data",
  );
});
test("a changed source invalidates actual HTTP conflict acceptance", async (t) => {
  const f = await applicationFixture(t),
    job = await startConflictingCopy(f);
  await fs.writeFile(path.join(f.home, "source", "same.txt"), "new source");
  assert.equal((await resolve(f, job, "replace")).status, 409);
  assert.equal(
    await fs.readFile(path.join(f.home, "target", "same.txt"), "utf8"),
    "old target",
  );
});
test("explicit directory merge handles child conflicts and retains cancelled unfinished sources", async (t) => {
  const f = await copyFixture(t);
  const source = path.join(f.home, "source"),
    target = path.join(f.project, "source");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "first"), "first");
  await fs.writeFile(path.join(source, "same"), "source");
  await fs.writeFile(path.join(target, "same"), "target");
  const job = await f.start(f.operation([source], f.project, "move"));
  const merge = await f.wait(job.id, ["waiting_for_conflict", "failed"]);
  assert.equal(merge.status, "waiting_for_conflict");
  assert.ok(merge.conflict.choices.includes("merge"));
  await f.resolve(merge, "merge");
  const child = await f.wait(job.id, ["waiting_for_conflict", "failed"]);
  assert.equal(child.status, "waiting_for_conflict");
  await f.resolve(child, "cancel");
  const done = await f.wait(job.id);
  assert.equal(done.status, "partially_completed", JSON.stringify(done));
  assert.equal(await fs.readFile(path.join(target, "first"), "utf8"), "first");
  assert.equal(await fs.readFile(path.join(source, "same"), "utf8"), "source");
  assert.equal(await fs.readFile(path.join(target, "same"), "utf8"), "target");
});

test("apply-to-remaining never authorizes changed target revisions or a type mismatch", async (t) => {
  const f = await copyFixture(t);
  const sources = ["a", "b", "c"].map((name) => path.join(f.home, name));
  for (const source of sources) await fs.writeFile(source, "source");
  await fs.writeFile(path.join(f.project, "a"), "old a");
  await fs.writeFile(path.join(f.project, "b"), "old b");
  await fs.mkdir(path.join(f.project, "c"));
  const job = await f.start(f.operation(sources, f.project));
  const first = await f.wait(job.id, ["waiting_for_conflict"]);
  await fs.writeFile(path.join(f.project, "b"), "external b");
  await f.resolve(first, "replace", true);
  const changed = await f.wait(job.id, ["waiting_for_conflict"]);
  assert.equal(changed.conflict.target, path.join(f.project, "b"));
  await f.resolve(changed, "skip");
  const mismatch = await f.wait(job.id, ["waiting_for_conflict"]);
  assert.equal(mismatch.conflict.choices.includes("replace"), false);
  await f.resolve(mismatch, "skip");
  assert.equal((await f.wait(job.id)).status, "completed");
  assert.equal(await fs.readFile(path.join(f.project, "b"), "utf8"), "external b");
  assert.equal((await fs.stat(path.join(f.project, "c"))).isDirectory(), true);
});

test("HTTP copy/move validation and restart preserve immutable request IDs and finished rows", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.writeFile(source, "keep");
  await fs.mkdir(target);
  const context = await (await f.request("/api/files/context")).json();
  const operation = {
    requestId: `${Date.now()}:${crypto.randomUUID()}`,
    kind: "move",
    sources: [source],
    target,
    name: null,
    options: {},
  };
  const submit = (body) =>
    f.request("/api/files/operations", {
      method: "POST",
      headers: { "X-File-Scope": context.scopeId },
      body,
    });
  for (const invalid of [
    { sources: [] },
    { options: { overwrite: true } },
    { name: "other" },
    { target: null },
  ])
    assert.equal((await submit({ ...operation, ...invalid })).status, 400);
  const response = await submit(operation);
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  await f.restart();
  const repeated = await submit(operation);
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).id, job.id);
  assert.equal((await submit({ ...operation, kind: "copy" })).status, 409);
  const rows = (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json())
    .entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceRemoved, true);
  assert.equal(rows[0].path, path.join(target, "source"));
  assert.equal(await fs.readFile(path.join(target, "source"), "utf8"), "keep");
});

test("copy conflict waits release both leases and revoked project scope rejects HTTP resolve", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "same"), "source");
  await fs.writeFile(path.join(target, "same"), "target");
  await f.application.sessions.save({
    id: "copy-project",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: f.home,
  });
  const base = "/api/sessions/copy-project/files/explorer";
  const context = await (await f.request(`${base}/context`)).json();
  const response = await f.request(`${base}/operations`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: {
      requestId: `${Date.now()}:${crypto.randomUUID()}`,
      kind: "copy",
      sources: ["source/same"],
      target: "target",
      name: null,
      options: {},
    },
  });
  assert.equal(response.status, 202);
  const job = await waitForFileJob(f, (await response.json()).id, {
    base,
    states: ["waiting_for_conflict"],
  });
  const files = f.application.files;
  assert.equal(files.locks.active.size, 0);
  await f.application.sessions.save({
    id: "copy-project",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: source,
  });
  const resolveResponse = await f.request(`${base}/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision: "replace", applyToRemaining: false },
  });
  assert.equal(resolveResponse.status, 409);
  assert.equal(await fs.readFile(path.join(target, "same"), "utf8"), "target");
});

for (const kind of ["copy", "move"])
  test(`${kind} merge preserves existing destination attributes and reports the localized exception`, async (t) => {
    const f = await copyFixture(t),
      source = path.join(f.home, "source"),
      target = path.join(f.project, "source");
    await fs.mkdir(source);
    await fs.mkdir(target);
    await fs.chmod(source, 0o700);
    await fs.chmod(target, 0o750);
    await fs.writeFile(path.join(source, "child"), "source");
    await fs.writeFile(path.join(target, "existing"), "keep");
    if (process.platform === "darwin") {
      await promisify(execFile)("/usr/bin/xattr", [
        "-w",
        "com.agentpier.fixture",
        "retained",
        target,
      ]);
      await promisify(execFile)("/bin/chmod", ["+a", "everyone allow readattr", target]);
    }
    const original = await fs.stat(target);
    const fingerprint = async () => {
      const handle = await fs.open(target, "r");
      try {
        return metadataFingerprint(await readMetadata(handle));
      } finally {
        await handle.close();
      }
    };
    const before = await fingerprint();
    const job = await f.start(f.operation([source], f.project, kind));
    await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
    const done = await f.wait(job.id);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal((await fs.stat(target)).ino, original.ino);
    assert.equal(await fingerprint(), before);
    const root = f.jobs
      .entries(f.globalScope, job.id)
      .entries.find((row) => row.source === source);
    assert.equal(root.issue?.code, "FILE_MERGE_METADATA_RETAINED");
    assert.equal(await fs.readFile(path.join(target, "existing"), "utf8"), "keep");
    setLanguage("en");
    try {
      assert.match(fileErrorMessage(root.issue.code), /existing destination folder/i);
    } finally {
      setLanguage("de");
    }
  });

for (const kind of ["copy", "move"]) {
  test(`HTTP ${kind} accepts exact clipboard revisions and binds them to the request ID`, async (t) => {
    const f = await applicationFixture(t);
    const source = path.join(f.home, "source"),
      child = path.join(source, "child"),
      target = path.join(f.home, "target");
    await fs.mkdir(source);
    await fs.mkdir(target);
    await fs.writeFile(child, "selected bytes");
    const sources = [source, child, source],
      revisions = await sourceRevisions(f, sources);
    const options = { revisions },
      requestId = `${Date.now()}:${crypto.randomUUID()}`;
    const job = await submitCopy(f, sources, target, { kind, options, requestId });
    const done = await waitForFileJob(f, job.id);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(done.completedEntries, 2);
    assert.equal(
      await fs.readFile(path.join(target, "source", "child"), "utf8"),
      "selected bytes",
    );
    if (kind === "move") await assert.rejects(fs.lstat(source), { code: "ENOENT" });
    else assert.equal(await fs.readFile(child, "utf8"), "selected bytes");
    assert.equal(
      (await submitCopy(f, sources, target, { kind, options, requestId })).id,
      job.id,
    );
    const context = await (await f.request("/api/files/context")).json();
    const changed = await f.request("/api/files/operations", {
      method: "POST",
      headers: { "X-File-Scope": context.scopeId },
      body: {
        requestId,
        kind,
        sources,
        target,
        name: null,
        options: { revisions: { ...revisions, [child]: `e1:${"a".repeat(64)}` } },
      },
    });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).code, "FILE_REQUEST_CONFLICT");
  });

  test(`HTTP ${kind} rejects stale selection revisions before changing any source or destination`, async (t) => {
    const f = await applicationFixture(t);
    const first = path.join(f.home, "first"),
      stale = path.join(f.home, "stale"),
      target = path.join(f.home, "target");
    await fs.mkdir(target);
    await fs.writeFile(first, "first bytes");
    await fs.writeFile(stale, "selected bytes");
    const sources = [first, stale],
      revisions = await sourceRevisions(f, sources);
    await fs.writeFile(stale, "new external bytes");
    const job = await submitCopy(f, sources, target, { kind, options: { revisions } });
    const done = await waitForFileJob(f, job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.issue.code, "FILE_CONFLICT_CHANGED");
    assert.equal(done.completedEntries, 0);
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal(await fs.readFile(first, "utf8"), "first bytes");
    assert.equal(await fs.readFile(stale, "utf8"), "new external bytes");
    assert.equal(
      f.application.files.store
        .listPublications()
        .filter((record) => record.jobId === job.id).length,
      0,
    );
  });

  test(`HTTP ${kind} checks a stale selected child before parent deduplication`, async (t) => {
    const f = await applicationFixture(t);
    const source = path.join(f.home, "source"),
      child = path.join(source, "child"),
      target = path.join(f.home, "target");
    await fs.mkdir(source);
    await fs.mkdir(target);
    await fs.writeFile(child, "before");
    const sources = [source, child],
      revisions = await sourceRevisions(f, sources);
    await fs.writeFile(child, "after!");
    assert.equal((await sourceRevisions(f, [source]))[source], revisions[source]);
    const job = await submitCopy(f, sources, target, { kind, options: { revisions } });
    const done = await waitForFileJob(f, job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.issue.code, "FILE_CONFLICT_CHANGED");
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal(await fs.readFile(child, "utf8"), "after!");
  });

  test(`HTTP ${kind} keeps clipboard preconditions bound through the planning scan`, async (t) => {
    const f = await applicationFixture(t);
    const source = path.join(f.home, "source"),
      child = path.join(source, "child"),
      target = path.join(f.home, "target");
    await fs.mkdir(source);
    await fs.mkdir(target);
    await fs.writeFile(child, "before");
    const sources = [source, child],
      revisions = await sourceRevisions(f, sources);
    const publisher = f.application.files.publisher,
      assertExpected = publisher.assertExpected.bind(publisher);
    let raced = false;
    publisher.assertExpected = async (scope, selected, ...args) => {
      const result = await assertExpected(scope, selected, ...args);
      if (selected === child && !raced) {
        raced = true;
        await fs.writeFile(child, "after!");
      }
      return result;
    };
    const job = await submitCopy(f, sources, target, { kind, options: { revisions } });
    const done = await waitForFileJob(f, job.id);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.issue.code, "FILE_CONFLICT_CHANGED");
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal(await fs.readFile(child, "utf8"), "after!");
  });
}

test("HTTP clipboard preconditions treat a disappeared ancestor as a changed source", async (t) => {
  const f = await applicationFixture(t),
    parent = path.join(f.home, "parent"),
    source = path.join(parent, "source"),
    target = path.join(f.home, "target");
  await fs.mkdir(parent);
  await fs.mkdir(target);
  await fs.writeFile(source, "before");
  const revisions = await sourceRevisions(f, [source]);
  await fs.rm(parent, { recursive: true });
  const job = await submitCopy(f, [source], target, { options: { revisions } });
  const done = await waitForFileJob(f, job.id);
  assert.equal(done.status, "failed");
  assert.equal(done.issue.code, "FILE_CONFLICT_CHANGED");
  assert.deepEqual(await fs.readdir(target), []);
});

test("HTTP clipboard revisions reject missing/extra keys, coercion, schemes and unknown options", async (t) => {
  const f = await applicationFixture(t),
    source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.writeFile(source, "keep");
  await fs.mkdir(target);
  const revisions = await sourceRevisions(f, [source]),
    revision = revisions[source];
  const context = await (await f.request("/api/files/context")).json();
  for (const kind of ["copy", "move"])
    for (const options of [
      { revisions: null },
      { revisions: [] },
      { revisions: revision },
      { revisions: {} },
      { revisions: { ...revisions, extra: revision } },
      { revisions: { [source]: [revision] } },
      { revisions: { [source]: { toString: revision } } },
      { revisions: { [source]: 17 } },
      { revisions: { [source]: revision.replace("e1:", "d1:") } },
      { revisions: { [source]: revision.replace("e1:", "p1:") } },
      { revisions: { [source]: "e1:invalid" } },
      { revisions, overwrite: true },
    ]) {
      const response = await f.request("/api/files/operations", {
        method: "POST",
        headers: { "X-File-Scope": context.scopeId },
        body: {
          requestId: `${Date.now()}:${crypto.randomUUID()}`,
          kind,
          sources: [source],
          target,
          name: null,
          options,
        },
      });
      assert.equal(response.status, 400, JSON.stringify({ kind, options }));
      assert.equal((await response.json()).code, "FILE_INVALID_OPERATION");
    }
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal(await fs.readFile(source, "utf8"), "keep");
});
