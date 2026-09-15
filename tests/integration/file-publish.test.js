import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { seedFileJob } from "../helpers/file-explorer.js";
import { fileRevision } from "../../server/features/files/file-publish.js";
import { entryRevision } from "../../server/features/files/file-paths.js";

import { fixture } from "../helpers/file-publisher.js";

test("failed publication never truncates the destination", async (t) => {
  let exchanges = 0;
  const f = await fixture(t, async (op, args, run) => {
    if (op === "exchange") {
      exchanges++;
      throw Error("injected");
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "original");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  assert.equal(exchanges, 1);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
  assert.equal(await fs.readFile(stage.file, "utf8"), "replacement");
  assert.notEqual(f.store.getPublication(stage.id).phase, "resolved");
});

test("new files publish without replacement and private modes survive", async (t) => {
  const f = await fixture(t);
  const stage = await f.stage();
  assert.equal((await fs.stat(path.dirname(stage.file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(stage.file)).mode & 0o777, 0o600);
  await stage.handle.writeFile(Buffer.alloc(150000, 65));
  const result = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: null,
  });
  assert.equal((await fs.readFile(f.target)).length, 150000);
  assert.equal(result.recoveryId, null);
  assert.equal(result.revision, await f.revision());
  assert.equal(f.store.getPublication(stage.id).phase, "resolved");
});

test("new-target collision preserves both versions", async (t) => {
  const f = await fixture(t);
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  await fs.writeFile(f.target, "collision");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: null }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "collision");
  assert.equal(await fs.readFile(stage.file, "utf8"), "new");
});

test("same-size external edits fail the d1 precondition", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "before");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  await fs.writeFile(f.target, "edited");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "edited");
  assert.equal(await fs.readFile(stage.file, "utf8"), "new");
});

test("replacement retains the displaced inode under an unresolved recovery ID", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original");
  const before = await fs.stat(f.target, { bigint: true });
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  const result = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: entryRevision(before),
  });
  assert.equal(result.recoveryId, stage.id);
  assert.equal(await fs.readFile(f.target, "utf8"), "new");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
  assert.equal((await fs.stat(stage.file, { bigint: true })).ino, before.ino);
  assert.equal(f.store.getPublication(stage.id).phase, "swapped");
});

for (const afterWriter of [false, true])
  test(`failure after exchange preserves both versions (external writer ${afterWriter})`, async (t) => {
    const f = await fixture(t, async (op, args, run, f) => {
      const result = await run(op, args);
      if (op === "exchange") {
        if (afterWriter) {
          await fs.rename(f.target, `${f.target}.published`);
          await fs.writeFile(f.target, "unrelated");
        }
        throw Error("after exchange");
      }
      return result;
    });
    await fs.writeFile(f.target, "original");
    const revision = await f.revision();
    const stage = await f.stage();
    await stage.handle.writeFile("replacement");
    await assert.rejects(
      f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    );
    assert.equal(await fs.readFile(stage.file, "utf8"), "original");
    assert.equal(
      await fs.readFile(afterWriter ? `${f.target}.published` : f.target, "utf8"),
      "replacement",
    );
    if (afterWriter) assert.equal(await fs.readFile(f.target, "utf8"), "unrelated");
  });

for (const existing of [false, true])
  test(`unsupported native publication preserves bytes (replacement ${existing})`, async (t) => {
    const f = await fixture(t, (op, args, run) => {
      if (["exchange", "renameNoReplace"].includes(op))
        throw Object.assign(Error("unsupported"), { code: "FILE_NATIVE_UNSUPPORTED" });
      return run(op, args);
    });
    if (existing) await fs.writeFile(f.target, "original");
    const revision = existing ? await f.revision() : null;
    const stage = await f.stage();
    await stage.handle.writeFile("replacement");
    await assert.rejects(
      f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
      { code: "FILE_WRITE_UNSUPPORTED" },
    );
    assert.equal(await fs.readFile(stage.file, "utf8"), "replacement");
    if (existing) assert.equal(await fs.readFile(f.target, "utf8"), "original");
    else await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
  });

test("post-exchange in-place writes are conflicts and retain the displaced original", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    const value = await run(op, args);
    if (op === "exchange") await fs.writeFile(f.target, "external write");
    return value;
  });
  await fs.writeFile(f.target, "original");
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "external write");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
});

test("new publication and discard remove only their empty owned stage directory", async (t) => {
  const f = await fixture(t);
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  await f.publisher.publish(f.globalScope, stage, { expectedRevision: null });
  await assert.rejects(fs.stat(path.dirname(stage.file)), { code: "ENOENT" });
  f.target += ".discard";
  const discarded = await f.stage();
  await f.publisher.discard(discarded);
  await assert.rejects(fs.stat(path.dirname(discarded.file)), { code: "ENOENT" });
});

test("symlink staging is one-shot and replaces the selected entry without touching its target", async (t) => {
  const f = await fixture(t),
    outside = `${f.target}.outside`;
  await fs.writeFile(outside, "sentinel");
  await fs.symlink(outside, f.target);
  const { resolveFile } = await import("../../server/features/files/file-paths.js");
  const before = await resolveFile(f.globalScope, f.target, { followLeaf: false });
  const stage = await f.publisher.stage(f.globalScope, f.target, {
    jobId: f.jobId,
    type: "symlink",
  });
  assert.equal(stage.handle, null);
  await stage.createLink("missing-target");
  await assert.rejects(stage.createLink("other"), { code: "FILE_INVALID_OPERATION" });
  const result = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: entryRevision(before.stat, before.linkIdentity),
  });
  const after = await resolveFile(f.globalScope, f.target, { followLeaf: false });
  assert.equal(result.revision, entryRevision(after.stat, after.linkIdentity));
  assert.equal(await fs.readlink(f.target), "missing-target");
  assert.equal(await fs.readlink(stage.file), outside);
  assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
});

test("strict metadata failure keeps originals and staged bytes", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original");
  const source = await fs.open(f.target, "r");
  t.after(() => source.close());
  const stage = await f.stage();
  await stage.handle.writeFile("replacement");
  const revision = await f.revision();
  const run = f.native.run.bind(f.native);
  let copies = 0;
  f.native.run = (op, args) => {
    if (op === "copyMetadata") {
      copies++;
      throw Object.assign(Error("strict incomplete"), {
        code: "FILE_METADATA_UNSUPPORTED",
        status: 409,
      });
    }
    return run(op, args);
  };
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, {
      expectedRevision: revision,
      metadataSource: source,
    }),
    { code: "FILE_METADATA_UNSUPPORTED" },
  );
  assert.equal(copies, 1);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
  assert.equal(await fs.readFile(stage.file, "utf8"), "replacement");
});

test("stage rejects filesystem/project roots and storage ancestors", async (t) => {
  const f = await fixture(t);
  for (const [scope, target] of [
    [f.globalScope, "/"],
    [f.projectScope, ""],
    [f.globalScope, f.dataDir],
  ])
    await assert.rejects(
      f.publisher.stage(scope, target, { jobId: seedFileJob(f.store, scope).id }),
      { code: "FILE_PROTECTED_PATH" },
    );
});

test("the atomic no-replace syscall catches a last-moment collision", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace") await fs.writeFile(f.target, "last-moment writer");
    return run(op, args);
  });
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: null }),
    { code: "FILE_EXISTS" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "last-moment writer");
  assert.equal(await fs.readFile(stage.file, "utf8"), "new");
});

test("an unexpected displaced inode causes a conflict without overwriting either version", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    if (op === "exchange") {
      await fs.rename(f.target, `${f.target}.original`);
      await fs.writeFile(f.target, "racing version");
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "original");
  const original = await fs.stat(f.target, { bigint: true });
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
  assert.equal(await fs.readFile(stage.file, "utf8"), "racing version");
  assert.equal(await fs.readFile(`${f.target}.original`, "utf8"), "original");
  assert.equal(
    (await fs.stat(`${f.target}.original`, { bigint: true })).ino,
    original.ino,
  );
});

test("a followed selected link retargeted during exchange causes a conflict", async (t) => {
  const f = await fixture(t),
    link = `${f.target}.link`,
    outside = `${f.target}.outside`;
  await fs.writeFile(f.target, "original");
  await fs.writeFile(outside, "sentinel");
  await fs.symlink(f.target, link);
  const { resolveFile } = await import("../../server/features/files/file-paths.js");
  const before = await resolveFile(f.globalScope, link, { followLeaf: true });
  const source = await fs.open(f.target, "r");
  const revision = await fileRevision(source, before.linkIdentity);
  await source.close();
  const stage = await f.publisher.stage(f.globalScope, link, {
    jobId: f.jobId,
    followLeaf: true,
  });
  await stage.handle.writeFile("replacement");
  const run = f.native.run.bind(f.native);
  f.native.run = async (op, args) => {
    if (op === "exchange") {
      await fs.unlink(link);
      await fs.symlink(outside, link);
    }
    return run(op, args);
  };
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
  assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  assert.equal(await fs.readlink(link), outside);
});

test("parent replacement after staging fails without writing into the replacement parent", async (t) => {
  const f = await fixture(t),
    stage = await f.stage();
  await stage.handle.writeFile("retained");
  await fs.rename(f.home, `${f.home}.retained`);
  await fs.mkdir(f.home);
  await fs.writeFile(f.target, "unrelated");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: null }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "unrelated");
  assert.equal(
    await fs.readFile(stage.file.replace(f.home, `${f.home}.retained`), "utf8"),
    "retained",
  );
});

test("directory stages own descriptors and publish private directories", async (t) => {
  const f = await fixture(t);
  const stage = await f.publisher.stage(f.globalScope, f.target, {
    jobId: f.jobId,
    type: "directory",
  });
  assert.equal((await stage.handle.stat()).type, "directory");
  const result = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: null,
  });
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o700);
  assert.match(result.revision, /^e1:/);
});

for (const token of [undefined, "unknown:token", "d1:" + "a".repeat(64)])
  test(`invalid or stale revision cannot recreate a missing original (${token?.slice(0, 8)})`, async (t) => {
    const f = await fixture(t),
      stage = await f.stage();
    await stage.handle.writeFile("new");
    await assert.rejects(
      f.publisher.publish(f.globalScope, stage, { expectedRevision: token }),
      { code: "FILE_CONFLICT_CHANGED" },
    );
    await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
    assert.equal(await fs.readFile(stage.file, "utf8"), "new");
  });

test("real strict metadata publication follows the native completeness capability", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original");
  await fs.chmod(f.target, 0o740);
  const revision = await f.revision(),
    source = await fs.open(f.target, "r"),
    stage = await f.stage();
  t.after(() => source.close());
  await stage.handle.writeFile("replacement");
  const before = await fs.stat(stage.file, { bigint: true });
  const publication = f.publisher.publish(f.globalScope, stage, {
    expectedRevision: revision,
    metadataSource: source,
  });
  if (process.platform === "linux") {
    await assert.rejects(publication, { code: "FILE_METADATA_UNSUPPORTED" });
    assert.equal((await fs.stat(stage.file, { bigint: true })).ctimeNs, before.ctimeNs);
    assert.equal(await fs.readFile(f.target, "utf8"), "original");
    assert.equal(await fs.readFile(stage.file, "utf8"), "replacement");
  } else {
    await publication;
    assert.equal((await fs.stat(f.target)).mode & 0o777, 0o740);
    assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
    assert.equal(await fs.readFile(stage.file, "utf8"), "original");
  }
});

test("d1 changes when ctime changes even if content, mode and mtime return to their old values", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "unchanged");
  await fs.chmod(f.target, 0o600);
  const before = await fs.stat(f.target, { bigint: true }),
    revision = await f.revision();
  await fs.chmod(f.target, 0o640);
  await fs.chmod(f.target, 0o600);
  const after = await fs.stat(f.target, { bigint: true });
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.mode, before.mode);
  assert.notEqual(await f.revision(), revision);
});
