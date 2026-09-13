import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { trashFixture } from "../helpers/file-trash.js";
import { entryRevision } from "../../server/features/files/file-paths.js";

async function fixture(t, intercept) {
  const f = await trashFixture(t, intercept);
  const module = await import("../../server/features/files/file-mutations.js").catch(
    (error) => {
      if (error.code === "ERR_MODULE_NOT_FOUND") return {};
      throw error;
    },
  );
  assert.equal(
    typeof module.FileMutations,
    "function",
    "mutation service must be implemented",
  );
  f.mutations = new module.FileMutations(f);
  f.run = (
    method,
    operation,
    conflict = async () => assert.fail("unexpected conflict"),
  ) =>
    f.mutations[method]({
      scope: f.globalScope,
      jobId: f.jobId,
      operation,
      signal: new AbortController().signal,
      report: async () => {},
      conflict,
    });
  f.create = (name, kind = "create_file") => ({
    kind,
    sources: [],
    target: f.home,
    name,
    options: {},
  });
  f.rename = async (source, name) => ({
    kind: "rename",
    sources: [source],
    target: null,
    name,
    options: {
      revisions: { [source]: entryRevision(await fs.lstat(source, { bigint: true })) },
    },
  });
  return f;
}

test("exclusive create preserves occupied entries and reserves an extension-preserving alternate", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "keep");
  await fs.writeFile(path.join(f.home, "keep (2).txt"), "also keep");
  await f.run("createFile", f.create("keep.txt"), async (conflict) => {
    assert.equal(await fs.readFile(f.target, "utf8"), "keep");
    assert.match(conflict.targetRevision, /^e1:/);
    return { decision: "keep_both" };
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(f.home, "keep (2).txt"), "utf8"), "also keep");
  assert.equal(await fs.readFile(path.join(f.home, "keep (3).txt"), "utf8"), "");
});

test("rename uses the original inode, checks source revision and never converts a directory", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original", { mode: 0o640 });
  const before = await fs.lstat(f.target);
  const stale = await f.rename(f.target, "stale.txt");
  await fs.writeFile(f.target, "changed bytes");
  await assert.rejects(f.run("rename", stale), { code: "FILE_CONFLICT_CHANGED" });
  await f.run("rename", await f.rename(f.target, "new.txt"));
  const renamed = path.join(f.home, "new.txt");
  assert.equal((await fs.lstat(renamed)).ino, before.ino);
  assert.equal((await fs.lstat(renamed)).mode, before.mode);
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, "child"), "protected");
  await f.run("rename", await f.rename(renamed, "keep.txt"), async (conflict) => {
    assert.equal(conflict.choices.includes("replace"), false);
    return { decision: "skip" };
  });
  assert.equal(await fs.readFile(renamed, "utf8"), "changed bytes");
  assert.equal(await fs.readFile(path.join(f.target, "child"), "utf8"), "protected");
});

test("case-only rename preserves the inode and selects a link without following it", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original");
  const before = await fs.lstat(f.target);
  await f.run("rename", await f.rename(f.target, "KEEP.txt"));
  assert.equal((await fs.lstat(path.join(f.home, "KEEP.txt"))).ino, before.ino);
  assert.equal((await fs.readdir(f.home)).includes("keep.txt"), false);
  const link = path.join(f.home, "broken");
  await fs.symlink("missing", link);
  const operation = await f.rename(link, "renamed-link");
  const { resolveFile } = await import("../../server/features/files/file-paths.js");
  const selected = await resolveFile(f.globalScope, link, { followLeaf: false });
  operation.options.revisions[link] = entryRevision(selected.stat, selected.linkIdentity);
  await f.run("rename", operation);
  assert.equal(await fs.readlink(path.join(f.home, "renamed-link")), "missing");
});

test("permission failure does not truncate an occupied target", async (t) => {
  const f = await fixture(t, (op, args, run) => {
    if (op === "exchange") throw Object.assign(Error(), { code: "EACCES" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "keep");
  await assert.rejects(
    f.run("createFile", f.create("keep.txt"), async () => ({ decision: "replace" })),
    { code: "FILE_ACCESS_DENIED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "keep");
});

test("rename replacement preserves both original inodes and durably adopts the displaced target", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "replacement", { mode: 0o640 });
  await fs.writeFile(f.target, "old target");
  const sourceStat = await fs.lstat(source),
    oldStat = await fs.lstat(f.target);
  await f.run("rename", await f.rename(source, "keep.txt"), async (conflict) => {
    assert.equal(await fs.readFile(source, "utf8"), "replacement");
    assert.equal(await fs.readFile(f.target, "utf8"), "old target");
    assert.match(conflict.sourceRevision, /^e1:/);
    return { decision: "replace" };
  });
  assert.equal((await fs.lstat(f.target)).ino, sourceStat.ino);
  assert.equal((await fs.lstat(f.target)).mode, sourceStat.mode);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  const payload = path.join(f.dataDir, "files", "trash", entry.id, "payload");
  assert.equal((await fs.lstat(payload)).ino, oldStat.ino);
  assert.equal(await fs.readFile(payload, "utf8"), "old target");
  assert.equal(entry.availability, "recoverable");
});

test("failed rename publication restores the original source without touching the target", async (t) => {
  const f = await fixture(t, (op, args, run) => {
    if (op === "exchange") throw Object.assign(Error(), { code: "EACCES" });
    return run(op, args);
  });
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(f.target, "old target");
  await assert.rejects(
    f.run("rename", await f.rename(source, "keep.txt"), async () => ({
      decision: "replace",
    })),
    { code: "FILE_ACCESS_DENIED" },
  );
  assert.equal(await fs.readFile(source, "utf8"), "source");
  assert.equal(await fs.readFile(f.target, "utf8"), "old target");
});

test("keep-both truncates Unicode stems at the UTF8 limit and protects competing reservations", async (t) => {
  let raced = false;
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.newName.includes(" (2)") && !raced) {
      raced = true;
      await fs.writeFile(path.join(f.home, args.newName), "competitor");
    }
    return run(op, args);
  });
  const name = `${"ä".repeat(125)}.txt`;
  await fs.writeFile(path.join(f.home, name), "keep");
  await f.run("createFile", f.create(name), async () => ({ decision: "keep_both" }));
  const files = (await fs.readdir(f.home)).filter((name) => name.endsWith(".txt"));
  assert.equal(files.length, 3);
  for (const name of files) assert.ok(Buffer.byteLength(name) <= 255);
  assert.equal(
    await fs.readFile(path.join(f.home, `${"ä".repeat(123)} (2).txt`), "utf8"),
    "competitor",
  );
  assert.equal(
    await fs.readFile(path.join(f.home, `${"ä".repeat(123)} (3).txt`), "utf8"),
    "",
  );
});

test("rename never treats distinct hardlinks as one case-insensitive directory entry", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "shared");
  const alias = path.join(f.home, "alias.txt");
  await fs.link(f.target, alias);
  await assert.rejects(f.run("rename", await f.rename(f.target, "alias.txt")), {
    code: "FILE_SAME_PATH",
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "shared");
  assert.equal(await fs.readFile(alias, "utf8"), "shared");
});

test("a new original-path occupant is preserved and the interrupted source is recoverable from trash", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "exchange") {
      await fs.writeFile(path.join(f.home, "source.txt"), "external");
      throw Object.assign(Error(), { code: "EACCES" });
    }
    return run(op, args);
  });
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "source bytes");
  await fs.writeFile(f.target, "old target");
  await assert.rejects(
    f.run("rename", await f.rename(source, "keep.txt"), async () => ({
      decision: "replace",
    })),
    { code: "FILE_RENAME_RECOVERY" },
  );
  assert.equal(await fs.readFile(source, "utf8"), "external");
  assert.equal(await fs.readFile(f.target, "utf8"), "old target");
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.originalPath, source);
  assert.equal(entry.reason, "interrupted_rename");
  assert.equal(entry.availability, "recoverable");
  const restored = path.join(f.home, "recovered.txt");
  await f.trash.restore(f.globalScope, entry.id, restored, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(restored, "utf8"), "source bytes");
  assert.equal(await fs.readFile(source, "utf8"), "external");
});

test("publisher close drains an accepted rename through its internal stages", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, async (op, args, run) => {
    if (op === "createDirectory" && args.name.startsWith(".agentpier-stage-")) {
      entered.resolve();
      await release.promise;
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "source");
  const revision = (await f.rename(f.target, "renamed.txt")).options.revisions[f.target];
  const moving = f.publisher.rename(
    f.globalScope,
    f.target,
    path.join(f.home, "renamed.txt"),
    { jobId: f.jobId, sourceRevision: revision, expectedRevision: null },
  );
  await entered.promise;
  const closing = f.publisher.close();
  release.resolve();
  await moving;
  await closing;
  assert.equal(await fs.readFile(path.join(f.home, "renamed.txt"), "utf8"), "source");
});

test("startup retries interrupted source registration without losing its prior location or restore evidence", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "exchange") {
      await fs.writeFile(path.join(f.home, "source.txt"), "external");
      throw Object.assign(Error(), { code: "EACCES" });
    }
    return run(op, args);
  });
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "retained");
  await fs.writeFile(f.target, "old");
  const operation = await f.rename(source, "keep.txt");
  const save = f.trash.save.bind(f.trash);
  f.trash.save = () => {
    throw Object.assign(Error(), { code: "ENOSPC" });
  };
  await assert.rejects(f.run("rename", operation, async () => ({ decision: "replace" })));
  f.trash.save = save;
  const { recoverPublications } =
    await import("../../server/features/files/file-recovery.js");
  await recoverPublications(f);
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.availability, "recoverable");
  const before = f.store.getTrash(entry.id);
  await f.trash.retainRenameSource(f.globalScope, entry.id);
  await f.trash.recover();
  const after = f.store.getTrash(entry.id);
  assert.deepEqual(after.location, before.location);
  assert.deepEqual(after.payloadManifest, before.payloadManifest);
  await f.trash.purge(f.globalScope, entry.id, {
    jobId: f.jobId,
    confirmation: { id: entry.id, revision: entry.revision },
  });
  assert.equal(f.store.getPublication(entry.id).phase, "resolved");
  assert.equal(await fs.readFile(source, "utf8"), "external");
  assert.equal(await fs.readFile(f.target, "utf8"), "old");
});

test("recovery restores a source when interruption occurs just after native adoption and before its journal update", async (t) => {
  let failRestoration = true,
    adopted = false;
  const f = await fixture(t, async (op, args, run) => {
    if (op === "renameNoReplace" && args.newName === "keep.txt" && failRestoration)
      throw Object.assign(Error(), { code: "EACCES" });
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "content" && !adopted) {
      adopted = true;
      throw Object.assign(Error(), { code: "EIO" });
    }
    return result;
  });
  await fs.writeFile(f.target, "original");
  const sourceRevision = (await f.rename(f.target, "renamed.txt")).options.revisions[
    f.target
  ];
  await assert.rejects(
    f.publisher.rename(f.globalScope, f.target, path.join(f.home, "renamed.txt"), {
      jobId: f.jobId,
      sourceRevision,
      expectedRevision: null,
    }),
  );
  failRestoration = false;
  const { recoverPublications } =
    await import("../../server/features/files/file-recovery.js");
  await recoverPublications(f);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
  assert.equal(
    f.store.listPublications().every((record) => record.phase === "resolved"),
    true,
  );
  await recoverPublications(f);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
});

test("publisher rejects source revisions changed during stage preparation", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "createDirectory" && args.name.startsWith(".agentpier-stage-"))
      await fs.writeFile(f.target, "external updated source");
    return run(op, args);
  });
  await fs.writeFile(f.target, "original");
  await assert.rejects(f.run("rename", await f.rename(f.target, "renamed.txt")), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "external updated source");
});

for (const kind of ["create_file", "rename"])
  test(`${kind} rechecks retained ancestor authority after waiting for its mutation lease`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.target, "source");
    const operation =
      kind === "rename"
        ? await f.rename(f.target, "renamed.txt")
        : f.create("created.txt");
    const run = f.barrier.run.bind(f.barrier);
    let moved = false;
    const detached = path.join(f.root, "detached-home");
    f.barrier.run = async (action) => {
      if (!moved && f.locks.hasLease() && !f.barrier.hasLease()) {
        moved = true;
        await fs.rename(f.home, detached);
        await fs.mkdir(f.home);
      }
      return run(action);
    };
    await assert.rejects(f.run(kind === "rename" ? "rename" : "createFile", operation));
    assert.equal(await fs.readFile(path.join(detached, "keep.txt"), "utf8"), "source");
    assert.equal(
      (await fs.readdir(detached)).includes(
        kind === "rename" ? "renamed.txt" : "created.txt",
      ),
      false,
    );
    assert.deepEqual(await fs.readdir(f.home), []);
  });

test("cancellation after adoption restores the original inode before the operation settles", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, async (op, args, run) => {
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "content") controller.abort();
    return result;
  });
  await fs.writeFile(f.target, "original");
  const inode = (await fs.lstat(f.target)).ino;
  const sourceRevision = (await f.rename(f.target, "renamed.txt")).options.revisions[
    f.target
  ];
  await assert.rejects(
    f.publisher.rename(f.globalScope, f.target, path.join(f.home, "renamed.txt"), {
      jobId: f.jobId,
      sourceRevision,
      expectedRevision: null,
      signal: controller.signal,
    }),
  );
  assert.equal((await fs.lstat(f.target)).ino, inode);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
  assert.equal(
    f.store.listPublications().every((record) => record.phase === "resolved"),
    true,
  );
});

for (const kind of ["create_file", "rename"])
  test(`${kind} refreshes readonly authority at its actual namespace mutation`, async (t) => {
    const f = await fixture(t);
    let readonly = false;
    f.mutations.context = async () => ({ ...f.globalScope, readOnly: readonly });
    await fs.writeFile(f.target, "original");
    const operation =
      kind === "rename"
        ? await f.rename(f.target, "renamed.txt")
        : f.create("created.txt");
    const run = f.barrier.run.bind(f.barrier);
    f.barrier.run = (action) => {
      if (f.locks.hasLease() && !f.barrier.hasLease()) readonly = true;
      return run(action);
    };
    await assert.rejects(f.run(kind === "rename" ? "rename" : "createFile", operation), {
      code: "FILE_READ_ONLY",
    });
    assert.equal(await fs.readFile(f.target, "utf8"), "original");
    assert.equal(
      (await fs.readdir(f.home)).includes(
        kind === "rename" ? "renamed.txt" : "created.txt",
      ),
      false,
    );
  });

test("a target arriving after rename adoption suspends with a renewed source revision and preserves both entries", async (t) => {
  let raced = false;
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.newName === "renamed.txt" && !raced) {
      raced = true;
      await fs.writeFile(path.join(f.home, "renamed.txt"), "competitor");
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "source");
  let conflicted = false;
  await f.run("rename", await f.rename(f.target, "renamed.txt"), async (conflict) => {
    conflicted = true;
    assert.match(conflict.sourceRevision, /^e1:/);
    await conflict.revalidate();
    return { decision: "skip" };
  });
  assert.equal(conflicted, true);
  assert.equal(await fs.readFile(f.target, "utf8"), "source");
  assert.equal(await fs.readFile(path.join(f.home, "renamed.txt"), "utf8"), "competitor");
});

test("a retained directory source remains visibly pending until its bounded tree manifest can be verified", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.newName === "renamed") {
      await fs.mkdir(f.target);
      await fs.writeFile(path.join(f.target, "external"), "new occupant");
      throw Object.assign(Error(), { code: "EACCES" });
    }
    return run(op, args);
  });
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, "child"), "source child");
  const limits = f.trash.limits;
  f.trash.limits = { ...limits, jobEntries: 1 };
  await assert.rejects(f.run("rename", await f.rename(f.target, "renamed")), {
    code: "FILE_RENAME_RECOVERY",
  });
  const [pending] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(pending.availability, "pending");
  assert.equal(pending.reason, "interrupted_rename");
  assert.equal(pending.revision, null);
  const restored = path.join(f.home, "recovered");
  await assert.rejects(
    f.trash.restore(f.globalScope, pending.id, restored, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
  );
  f.trash.limits = limits;
  await f.trash.recover();
  assert.equal(
    (await f.trash.list(f.globalScope)).entries[0].availability,
    "recoverable",
  );
  await f.trash.restore(f.globalScope, pending.id, restored, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(path.join(restored, "child"), "utf8"), "source child");
  assert.equal(
    await fs.readFile(path.join(f.target, "external"), "utf8"),
    "new occupant",
  );
});

test("keep-both skips the current source spelling when generating an alternate rename", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "target");
  const source = path.join(f.home, "keep (2).txt");
  await fs.writeFile(source, "source");
  await f.run("rename", await f.rename(source, "keep.txt"), async () => ({
    decision: "keep_both",
  }));
  assert.equal(await fs.readFile(path.join(f.home, "keep (3).txt"), "utf8"), "source");
  assert.equal(await fs.readFile(f.target, "utf8"), "target");
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
});

test("relocated source ancestors remain visible as pending metadata without granting restore or purge authority", async (t) => {
  let relocated = false;
  const f = await fixture(t, async (op, args, run, f) => {
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "content" && !relocated) {
      relocated = true;
      await fs.rename(f.home, path.join(f.root, "relocated-home"));
      await fs.mkdir(f.home);
      throw Object.assign(Error(), { code: "EIO" });
    }
    return result;
  });
  await fs.writeFile(f.target, "original source");
  await assert.rejects(f.run("rename", await f.rename(f.target, "renamed.txt")), {
    code: "FILE_RENAME_RECOVERY",
  });
  const [pending] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(pending.availability, "pending");
  assert.equal(pending.revision, null);
  assert.equal(pending.originalPath, f.target);
  assert.equal(JSON.stringify(pending).includes("agentpier-stage"), false);
  const destination = path.join(f.home, "restored.txt");
  await assert.rejects(
    f.trash.restore(f.globalScope, pending.id, destination, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
  );
  await assert.rejects(
    f.trash.purge(f.globalScope, pending.id, {
      jobId: f.jobId,
      confirmation: { id: pending.id, revision: null },
    }),
  );
  const before = f.store.getTrash(pending.id);
  await f.trash.recover();
  f.store.transition(f.jobId, "queued", "completed");
  f.store.prune(Date.now() + 100 * 86400000);
  assert.equal(f.store.getJob(f.globalScope, f.jobId).id, f.jobId);
  assert.deepEqual(f.store.getTrash(pending.id).location, before.location);
  assert.notEqual(f.store.getPublication(pending.id).phase, "resolved");
  assert.deepEqual(await fs.readdir(f.home), []);
  await fs.rmdir(f.home);
  await fs.rename(path.join(f.root, "relocated-home"), f.home);
  const { recoverPublications } =
    await import("../../server/features/files/file-recovery.js");
  await recoverPublications(f);
  await f.trash.recover();
  assert.equal(await fs.readFile(f.target, "utf8"), "original source");
  assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
});

test("startup recognizes completed exchange and never exposes the displaced target as the rename source", async (t) => {
  let interrupted = false;
  const f = await fixture(t, async (op, args, run) => {
    const result = await run(op, args);
    if (op === "exchange" && !interrupted) {
      interrupted = true;
      throw Object.assign(Error(), { code: "EIO" });
    }
    return result;
  });
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(f.target, "old target");
  await assert.rejects(
    f.run("rename", await f.rename(source, "keep.txt"), async () => ({
      decision: "replace",
    })),
  );
  const before = (await f.trash.list(f.globalScope)).entries;
  assert.equal(
    before.every((entry) => entry.availability === "pending"),
    true,
  );
  const { recoverPublications } =
    await import("../../server/features/files/file-recovery.js");
  await recoverPublications(f);
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.reason, "replaced");
  assert.equal(entry.originalPath, f.target);
  assert.equal(entry.availability, "recoverable");
  assert.equal(await fs.readFile(f.target, "utf8"), "source");
  const restored = path.join(f.home, "old-target.txt");
  await f.trash.restore(f.globalScope, entry.id, restored, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(restored, "utf8"), "old target");
});
