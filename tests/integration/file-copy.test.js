import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFixture } from "../helpers/file-copy.js";

test("recursive copies deduplicate parent/child selections and preserve links as links", async (t) => {
  const f = await copyFixture(t);
  const source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "child"), "bytes", { mode: 0o640 });
  await fs.chmod(path.join(source, "child"), 0o640);
  await fs.symlink("missing", path.join(source, "link"));
  const job = await f.start(
    f.operation([path.join(source, "child"), source, source], target),
  );
  const done = await f.wait(job.id);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.completedEntries, 3);
  assert.equal(done.completedBytes, 5);
  assert.equal(await fs.readFile(path.join(target, "source", "child"), "utf8"), "bytes");
  assert.equal(await fs.readlink(path.join(target, "source", "link")), "missing");
  assert.equal((await fs.stat(path.join(target, "source", "child"))).mode & 0o777, 0o640);
  await assert.rejects(fs.stat(path.join(target, "child")), { code: "ENOENT" });
});

test("multi-entry failure preserves successful output and separately journals failed source", async (t) => {
  const f = await copyFixture(t);
  const source = path.join(f.home, "good"),
    missing = path.join(f.home, "missing");
  await fs.writeFile(source, "good");
  const job = await f.start(f.operation([source, missing], f.project));
  const done = await f.wait(job.id);
  assert.equal(done.status, "partially_completed", JSON.stringify(done));
  assert.equal(await fs.readFile(path.join(f.project, "good"), "utf8"), "good");
  const rows = f.jobs.entries(f.globalScope, job.id).entries;
  assert.equal(rows.filter((row) => row.status === "completed").length, 1);
  assert.equal(rows.filter((row) => row.status === "failed").length, 1);
});

test("a directory cannot be copied into its own descendant through an alias", async (t) => {
  const f = await copyFixture(t);
  const source = path.join(f.home, "source"),
    alias = path.join(f.home, "alias");
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, "child"));
  await fs.symlink(path.join(source, "child"), alias);
  const job = await f.start(f.operation([source], alias));
  const done = await f.wait(job.id);
  assert.equal(done.status, "failed");
  assert.equal(done.issue.code, "FILE_SAME_PATH");
  assert.deepEqual(await fs.readdir(path.join(source, "child")), []);
});

test("sparse logical bytes and aggregate entries are bounded before publication", async (t) => {
  const f = await copyFixture(t, null, { jobBytes: 1024, jobEntries: 3 });
  const source = path.join(f.home, "sparse");
  const handle = await fs.open(source, "w");
  await handle.truncate(1025);
  await handle.close();
  const job = await f.start(f.operation([source], f.project));
  assert.equal((await f.wait(job.id)).issue.code, "FILE_LIMIT_EXCEEDED");
  assert.deepEqual(await fs.readdir(f.project), []);
});

test("recursive copies report skipped FIFO entries without opening them", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "good"), "ok");
  await promisify(execFile)("mkfifo", [path.join(source, "pipe")]);
  const job = await f.start(f.operation([source], f.project)),
    done = await f.wait(job.id);
  assert.equal(done.status, "partially_completed", JSON.stringify(done));
  assert.equal(await fs.readFile(path.join(f.project, "source", "good"), "utf8"), "ok");
  await assert.rejects(fs.lstat(path.join(f.project, "source", "pipe")), {
    code: "ENOENT",
  });
  assert.ok(
    f.jobs
      .entries(f.globalScope, job.id)
      .entries.some(
        (row) => row.status === "skipped" && row.issue.code === "FILE_UNSUPPORTED_TYPE",
      ),
  );
});

test("job-wide byte caps include separate roots and nesting obeys maxDepth", async (t) => {
  const f = await copyFixture(t, null, { jobBytes: 5, maxDepth: 1 });
  const a = path.join(f.home, "a"),
    b = path.join(f.home, "b");
  await fs.writeFile(a, "123");
  await fs.writeFile(b, "456");
  const job = await f.start(f.operation([a, b], f.project)),
    done = await f.wait(job.id);
  assert.equal(done.status, "partially_completed");
  assert.equal(done.completedBytes, 3);
  assert.equal(await fs.readFile(path.join(f.project, "a"), "utf8"), "123");
  await assert.rejects(fs.lstat(path.join(f.project, "b")), { code: "ENOENT" });
  const dir = path.join(f.home, "dir");
  await fs.mkdir(path.join(dir, "sub"), { recursive: true });
  await fs.writeFile(path.join(dir, "sub", "deep"), "x");
  const deep = await f.start(f.operation([dir], f.project));
  assert.equal((await f.wait(deep.id)).issue.code, "FILE_LIMIT_EXCEEDED");
});

test("failed nested metadata copy cleans proven private children and preserves source", async (t) => {
  const f = await copyFixture(t, (op, args, run) => {
    if (op === "copyMetadata") throw Object.assign(Error(), { code: "EACCES" });
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "keep");
  const job = await f.start(f.operation([source], f.project));
  assert.equal((await f.wait(job.id)).status, "failed");
  assert.deepEqual(await fs.readdir(f.project), []);
  assert.equal(await fs.readFile(path.join(source, "child"), "utf8"), "keep");
});

test("copy keep-both atomically retries an alternate occupied during publication", async (t) => {
  let raced = false;
  const f = await copyFixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.newName === "a (2).txt" && !raced) {
      raced = true;
      await fs.writeFile(path.join(f.project, args.newName), "competitor");
    }
    return run(op, args);
  });
  const source = path.join(f.home, "a.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(path.join(f.project, "a.txt"), "original");
  const job = await f.start(f.operation([source], f.project));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "keep_both");
  assert.equal((await f.wait(job.id)).status, "completed");
  assert.equal(
    await fs.readFile(path.join(f.project, "a (2).txt"), "utf8"),
    "competitor",
  );
  assert.equal(await fs.readFile(path.join(f.project, "a (3).txt"), "utf8"), "source");
  assert.equal(
    (await fs.readdir(f.project)).filter((name) => name.startsWith(".agentpier-stage-"))
      .length,
    0,
  );
});

test("a child created before its identity checkpoint remains pinned instead of guessed cleanup", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "keep");
  const put = f.store.putEntry.bind(f.store);
  let interrupted = false;
  f.store.putEntry = (jobId, row) => {
    if (row.relativePath === "child" && row.phase === "copying" && !interrupted) {
      interrupted = true;
      throw Error("injected checkpoint");
    }
    return put(jobId, row);
  };
  const job = await f.start(f.operation([source], f.project));
  assert.equal((await f.wait(job.id)).status, "failed");
  const [record] = f.store.listPublications().filter((record) => record.jobId === job.id);
  assert.notEqual(record.phase, "resolved");
  assert.equal(
    (await fs.lstat(path.join(record.document.staged, "child"))).isFile(),
    true,
  );
  assert.equal(await fs.readFile(path.join(source, "child"), "utf8"), "keep");
  await assert.rejects(fs.lstat(path.join(f.project, "source")), { code: "ENOENT" });
});

test("cancelled streaming cleans proven unpublished entries and retains all source bytes", async (t) => {
  let cancelled = false,
    id;
  const f = await copyFixture(t, async (op, args, run, f) => {
    const result = await run(op, args);
    if (op === "write" && !cancelled) {
      cancelled = true;
      await f.jobs.cancel(f.globalScope, id);
    }
    return result;
  });
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), Buffer.alloc(200000, 42));
  const job = await f.start(f.operation([source], f.project));
  id = job.id;
  assert.equal((await f.wait(job.id)).status, "cancelled");
  assert.deepEqual(await fs.readdir(f.project), []);
  assert.deepEqual(
    await fs.readFile(path.join(source, "child")),
    Buffer.alloc(200000, 42),
  );
});

test("cleanup preserves an observed external change to a privately staged inode", async (t) => {
  let changed;
  const f = await copyFixture(t, async (op, args, run, f) => {
    if (op === "copyMetadata") {
      const record = f.store
        .listPublications()
        .find((record) => record.document.type === "directory");
      changed = path.join(record.document.staged, "child");
      await fs.writeFile(changed, "external stage data");
      throw Object.assign(Error(), { code: "EACCES" });
    }
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "source");
  const job = await f.start(f.operation([source], f.project));
  assert.equal((await f.wait(job.id)).status, "failed");
  assert.equal(await fs.readFile(changed, "utf8"), "external stage data");
  assert.equal(await fs.readFile(path.join(source, "child"), "utf8"), "source");
});

test("finished-stage cleanup retains an edit observed after its scan and before its path lock", async (t) => {
  let collision = false,
    edited = false,
    retained;
  const f = await copyFixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.newName === "source (2)" && !collision) {
      collision = true;
      await fs.mkdir(path.join(f.project, "source (2)"));
    }
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "original");
  await fs.mkdir(path.join(f.project, "source"));
  const withPaths = f.locks.withPaths.bind(f.locks);
  f.locks.withPaths = async (paths, action, signal) => {
    if (collision && !edited && paths.includes(path.join(f.project, "source (2)"))) {
      const record = f.store
        .listPublications()
        .find((record) => record.document.target === path.join(f.project, "source (2)"));
      retained = path.join(record.document.staged, "child");
      await fs.writeFile(retained, "external content after cleanup scan");
      edited = true;
    }
    return withPaths(paths, action, signal);
  };
  const job = await f.start(f.operation([source], f.project));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "keep_both");
  assert.equal((await f.wait(job.id)).status, "completed");
  assert.equal(collision, true);
  assert.equal(edited, true);
  assert.equal(
    await fs.readFile(retained, "utf8"),
    "external content after cleanup scan",
  );
  assert.equal(
    await fs.readFile(path.join(f.project, "source (3)", "child"), "utf8"),
    "original",
  );
  assert.equal(await fs.readFile(path.join(source, "child"), "utf8"), "original");
  const record = f.store
    .listPublications()
    .find((record) => record.document.staged === path.dirname(retained));
  assert.notEqual(record.phase, "resolved");
});
