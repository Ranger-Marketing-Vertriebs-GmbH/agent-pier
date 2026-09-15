import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { trashFixture } from "../helpers/file-trash.js";

test("replay makes a moved payload recoverable after the post-rename journal fails", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "recover this");
  const put = f.store.putTrash.bind(f.store);
  let failed = false;
  f.store.putTrash = (record) => {
    if (record.phase === "moved" && !failed) {
      failed = true;
      throw Error("journal failure");
    }
    return put(record);
  };
  await assert.rejects(
    f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
  );
  await fs.writeFile(f.target, "unrelated replacement");
  await f.trash.recover();
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.availability, "recoverable");
  assert.equal(await fs.readFile(f.target, "utf8"), "unrelated replacement");
  assert.equal(
    await fs.readFile(
      path.join(f.dataDir, "files", "trash", entry.id, "payload"),
      "utf8",
    ),
    "recover this",
  );
});

test("partial purge replay removes only remaining recorded entries", async (t) => {
  let removed = 0,
    armed = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "removeEntry" && armed && ++removed === 2)
      throw Error("interrupted purge");
    return run(op, args);
  });
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, "a"), "a");
  await fs.writeFile(path.join(f.target, "b"), "b");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  armed = true;
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: entry.revision },
    }),
  );
  armed = false;
  await f.trash.recover();
  assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
  assert.equal(f.store.trashItems(id).length, 0);
});

test("purge replay refuses an unrelated file at an already removed recorded path", async (t) => {
  let removed = 0,
    armed = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "removeEntry" && armed && ++removed === 2)
      throw Error("interrupted purge");
    return run(op, args);
  });
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, "a"), "a");
  await fs.writeFile(path.join(f.target, "b"), "b");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  armed = true;
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: entry.revision },
    }),
  );
  const removedEntry = f.store.trashItems(id).find((row) => row.removed);
  const replaced = path.join(
    f.dataDir,
    "files",
    "trash",
    id,
    "payload",
    removedEntry.relativePath,
  );
  await fs.writeFile(replaced, "unrelated");
  armed = false;
  await f.trash.recover();
  assert.equal(await fs.readFile(replaced, "utf8"), "unrelated");
  assert.equal((await f.trash.list(f.globalScope)).entries.length, 1);
});

test("failed central adoption stays visible and replay adopts displaced bytes", async (t) => {
  let fail = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && fail)
      throw Object.assign(Error(), { code: "ENOSPC" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "old");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  const published = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: revision,
  });
  fail = true;
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, published.recoveryId));
  assert.equal((await f.trash.list(f.globalScope)).entries[0].availability, "pending");
  assert.equal(await fs.readFile(stage.file, "utf8"), "old");
  assert.notEqual(f.store.getPublication(stage.id).phase, "resolved");
  fail = false;
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.availability, "recoverable");
  assert.equal(
    await fs.readFile(
      path.join(f.dataDir, "files", "trash", entry.id, "payload"),
      "utf8",
    ),
    "old",
  );
  assert.equal(f.store.getPublication(stage.id).phase, "resolved");
});

test("failed restore publication keeps adopted bytes discoverable after replay", async (t) => {
  let fail = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && fail && args.newName === "keep.txt")
      throw Object.assign(Error(), { code: "ENOSPC" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  fail = true;
  await assert.rejects(
    f.trash.restore(f.globalScope, id, f.target, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
  );
  fail = false;
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.availability, "recoverable");
  await f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "saved");
});

test(
  "EXDEV partial source removal resumes only recorded remaining identities",
  { skip: process.platform === "linux" },
  async (t) => {
    let rename = true,
      removed = 0;
    const f = await trashFixture(t, (op, args, run) => {
      if (op === "renameNoReplace" && rename) {
        rename = false;
        throw Object.assign(Error(), { code: "EXDEV" });
      }
      if (op === "removeEntry" && ++removed === 2) throw Error("removal failure");
      return run(op, args);
    });
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, "a"), "a");
    await fs.writeFile(path.join(f.target, "b"), "b");
    await assert.rejects(
      f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
    );
    assert.equal(
      (await f.trash.list(f.globalScope)).entries[0].availability,
      "recoverable",
    );
    await f.trash.recover();
    await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  },
);

test("registered trash parent replacement is preserved during interrupted adoption", async (t) => {
  let fail = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && fail) throw Error("interrupted");
    return run(op, args);
  });
  await fs.writeFile(f.target, "old");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  const published = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: revision,
  });
  fail = true;
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, published.recoveryId));
  const directory = path.join(f.dataDir, "files", "trash", published.recoveryId);
  await fs.rename(directory, `${directory}-retained`);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "external"), "keep external");
  fail = false;
  await f.trash.recover();
  assert.equal(await fs.readFile(stage.file, "utf8"), "old");
  assert.equal(
    await fs.readFile(path.join(directory, "external"), "utf8"),
    "keep external",
  );
  assert.equal((await f.trash.list(f.globalScope)).entries[0].availability, "pending");
});

test("restore journal failure after publication resolves the original trash obligation on replay", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const del = f.store.deleteTrash.bind(f.store);
  let fail = true;
  f.store.deleteTrash = (value) => {
    if (fail) throw Error("final journal failure");
    return del(value);
  };
  await assert.rejects(
    f.trash.restore(f.globalScope, id, f.target, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
  );
  fail = false;
  await f.trash.recover();
  assert.equal(await fs.readFile(f.target, "utf8"), "saved");
  assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
});

test("confirmed purge closes only its recorded storage directory and retains an observed replacement", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const record = f.store.getTrash(id);
  await fs.rename(
    path.dirname(record.location.file),
    `${path.dirname(record.location.file)}-retained`,
  );
  await fs.mkdir(path.dirname(record.location.file));
  await assert.rejects(f.trash.finish(record));
  assert.ok(f.store.getTrash(id));
});

test("replay cleans proven failed cross-device staging while retaining the original", async (t) => {
  let first = true;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && first) {
      first = false;
      throw Object.assign(Error(), { code: "EXDEV" });
    }
    if (op === "copyMetadata")
      throw Object.assign(Error(), { code: "FILE_METADATA_UNSUPPORTED", status: 409 });
    return run(op, args);
  });
  await fs.writeFile(f.target, "keep original");
  await assert.rejects(
    f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
  );
  await f.trash.recover();
  assert.equal(await fs.readFile(f.target, "utf8"), "keep original");
  assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "files", "trash")), []);
});

test("replay adopts centrally moved displaced bytes after a failed moved journal", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "old");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  const published = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: revision,
  });
  const put = f.store.putTrash.bind(f.store);
  let failed = false;
  f.store.putTrash = (record) => {
    if (record.reason === "replaced" && record.phase === "moved" && !failed) {
      failed = true;
      throw Error("moved journal failure");
    }
    return put(record);
  };
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, published.recoveryId));
  await f.trash.recover();
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.availability, "recoverable");
  assert.equal(
    await fs.readFile(
      path.join(f.dataDir, "files", "trash", entry.id, "payload"),
      "utf8",
    ),
    "old",
  );
  assert.equal(f.store.getPublication(stage.id).phase, "resolved");
});

test("failed restore adoption before movement makes the retained source recoverable on replay", async (t) => {
  let fail = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && fail && args.newName === "content")
      throw Object.assign(Error(), { code: "ENOSPC" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  fail = true;
  await assert.rejects(
    f.trash.restore(f.globalScope, id, f.target, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
  );
  fail = false;
  await f.trash.recover();
  assert.equal(
    (await f.trash.list(f.globalScope)).entries[0].availability,
    "recoverable",
  );
  await f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "saved");
});

test("failed strict cross-device restore cleans only its registered clone and retains recoverable trash", async (t) => {
  let stageParent,
    mismatch = false;
  const f = await trashFixture(t, async (op, args, run) => {
    const result = await run(op, args);
    if (op === "stat" && args.handle === stageParent && mismatch) {
      mismatch = false;
      return { ...result, dev: result.dev + 1n };
    }
    return result;
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const original = f.publisher.stage.bind(f.publisher);
  f.publisher.stage = async (...args) => {
    const stage = await original(...args);
    stageParent = stage.parentHandle.handle;
    mismatch = true;
    return stage;
  };
  const run = f.native.run.bind(f.native);
  f.native.run = (op, args) =>
    op === "copyMetadata"
      ? Promise.reject(
          Object.assign(Error(), { code: "FILE_METADATA_UNSUPPORTED", status: 409 }),
        )
      : run(op, args);
  await assert.rejects(
    f.trash.restore(f.globalScope, id, f.target, {
      jobId: f.jobId,
      expectedRevision: null,
    }),
    { code: "FILE_METADATA_UNSUPPORTED" },
  );
  await f.trash.recover();
  assert.equal(
    (await f.trash.list(f.globalScope)).entries[0].availability,
    "recoverable",
  );
  assert.equal(
    await fs.readFile(path.join(f.dataDir, "files", "trash", id, "payload"), "utf8"),
    "saved",
  );
  assert.equal(
    (await fs.readdir(f.home)).some((name) => name.startsWith(".agentpier-stage-")),
    false,
  );
});

test(
  "cross-device restore resumes journaled source cleanup after publication",
  { skip: process.platform === "linux" },
  async (t) => {
    let stageParent,
      mismatch = false,
      removals = 0;
    const f = await trashFixture(t, async (op, args, run) => {
      if (op === "removeEntry" && ["a", "b"].includes(args.name) && ++removals === 2)
        throw Error("cleanup interrupted");
      const result = await run(op, args);
      if (op === "stat" && args.handle === stageParent && mismatch) {
        mismatch = false;
        return { ...result, dev: result.dev + 1n };
      }
      return result;
    });
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, "a"), "a");
    await fs.writeFile(path.join(f.target, "b"), "b");
    const id = await f.trash.capture(f.globalScope, f.target, {
      jobId: f.jobId,
      reason: "deleted",
    });
    const original = f.publisher.stage.bind(f.publisher);
    f.publisher.stage = async (...args) => {
      const stage = await original(...args);
      stageParent = stage.parentHandle.handle;
      mismatch = true;
      return stage;
    };
    await assert.rejects(
      f.trash.restore(f.globalScope, id, f.target, {
        jobId: f.jobId,
        expectedRevision: null,
      }),
    );
    await f.trash.recover();
    assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
    assert.equal(await fs.readFile(path.join(f.target, "a"), "utf8"), "a");
    assert.equal(await fs.readFile(path.join(f.target, "b"), "utf8"), "b");
  },
);
