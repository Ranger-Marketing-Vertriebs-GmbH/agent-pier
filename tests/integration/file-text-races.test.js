import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { attachAttributes, observeAttributes } from "../helpers/file-native-metadata.js";
import {
  publicationSnapshot,
  ownedHandle,
  openParent,
} from "../../server/features/files/file-stage.js";

const save = (f, target, bytes, revision = null) =>
  f.text.save(f.scope, target, Buffer.from(bytes), {
    revision,
    requestId: uploadRequest(),
  });

test("two writers and a third conflict-resolution edit cannot consent with an earlier d1", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "writers");
  await fs.writeFile(target, "first");
  const first = await f.text.read(f.scope, target);
  const before = await fs.stat(target);
  await fs.writeFile(target, "other");
  await fs.utimes(target, before.atime, before.mtime);
  await assert.rejects(save(f, target, "draft", first.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
  const latest = await f.text.read(f.scope, target);
  assert.notEqual(first.metadataRevision, latest.metadataRevision);
  await fs.writeFile(target, "third");
  await assert.rejects(save(f, target, "draft", latest.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(await fs.readFile(target, "utf8"), "third");
  assert.equal(f.store.listPublications().length, 0);
  const current = await f.text.read(f.scope, target);
  if (process.platform === "linux")
    await assert.rejects(save(f, target, "draft", current.revision), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
  else {
    const result = await save(f, target, "draft", current.revision);
    const parent = await openParent(f.publisher.native, target);
    const handle = ownedHandle(
      f.publisher.native,
      await f.publisher.native.run("openFile", {
        directory: parent.handle,
        path: path.basename(target),
      }),
    );
    try {
      const observed = await publicationSnapshot(handle);
      assert.equal(result.revision, observed.revision);
      assert.equal(result.metadataRevision, observed.metadataRevision);
    } finally {
      await handle.close();
      await parent.close();
    }
  }
});

test("strict save independently preserves real ACL and xattrs without restoring content mtime", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "attributes");
  await fs.writeFile(target, "old", { mode: 0o750 });
  const source = await fs.open(target, "r+");
  t.after(() => source.close());
  attachAttributes(source.fd, "user.agentpier-text", Buffer.from([0, 1, 255, 17]));
  if (process.platform === "darwin")
    execFileSync("chmod", ["+a", "everyone allow readattr,readextattr", target]);
  await source.utimes(100, 101);
  const attributes = observeAttributes(source.fd),
    before = await source.stat({ bigint: true });
  const acl =
    process.platform === "darwin"
      ? execFileSync("ls", ["-lde", target], { encoding: "utf8" }).split("\n").slice(1)
      : null;
  const document = await f.text.read(f.scope, target);
  if (process.platform === "linux") {
    assert.equal(document.readOnly, true);
    await assert.rejects(save(f, target, "new", document.revision), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
    assert.equal(await fs.readFile(target, "utf8"), "old");
    return;
  }
  await save(f, target, "new", document.revision);
  const handle = await fs.open(target, "r");
  try {
    const after = await handle.stat({ bigint: true });
    assert.deepEqual(observeAttributes(handle.fd), attributes);
    assert.deepEqual(
      execFileSync("ls", ["-lde", target], { encoding: "utf8" }).split("\n").slice(1),
      acl,
    );
    for (const key of ["mode", "uid", "gid"]) assert.equal(after[key], before[key]);
    assert.notEqual(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ino, before.ino);
  } finally {
    await handle.close();
  }
});

for (const race of ["collision", "parent", "hardlink", "retarget", "same_link"])
  test(`late ${race} change preserves the intervening writer and registered bytes`, async (t) => {
    const f = await uploadFixture(t),
      directory = path.join(f.home, "selected-parent"),
      elsewhere = path.join(f.home, "target-parent");
    await fs.mkdir(directory);
    await fs.mkdir(elsewhere);
    const selected = path.join(directory, "selected"),
      target = path.join(elsewhere, "target"),
      other = path.join(elsewhere, "other");
    let revision = null;
    if (["hardlink", "retarget", "same_link"].includes(race)) {
      await fs.writeFile(target, "original");
      await fs.writeFile(other, "other");
      await fs.symlink(target, selected);
      revision = (await f.text.read(f.scope, selected)).revision;
      if (process.platform === "linux") {
        await assert.rejects(save(f, selected, "draft", revision), {
          code: "FILE_METADATA_UNSUPPORTED",
        });
        assert.equal(await fs.readFile(target, "utf8"), "original");
        return;
      }
    }
    let changed = false,
      mutations = 0;
    const put = f.store.putPublication.bind(f.store),
      run = f.publisher.native.run.bind(f.publisher.native);
    // Queue external filesystem work after the durable prepared checkpoint, before namespace checks.
    const barrier = f.publisher.locks.withPaths.bind(f.publisher.locks);
    f.publisher.locks.withPaths = async (...args) => {
      if (
        !changed &&
        f.store.listPublications().some((record) => record.phase === "prepared")
      ) {
        changed = true;
        if (race === "collision") await fs.writeFile(selected, "intervening");
        if (race === "parent") {
          await fs.rename(directory, directory + "-moved");
          await fs.mkdir(directory);
          await fs.writeFile(selected, "replacement-parent");
        }
        if (race === "hardlink") await fs.link(target, target + "-hard");
        if (["retarget", "same_link"].includes(race)) {
          await fs.unlink(selected);
          await fs.symlink(race === "retarget" ? other : target, selected);
        }
      }
      return barrier(...args);
    };
    f.store.putPublication = (record) => {
      assert.ok(f.barrier.active > 0, "journals hold a physical mutation lease");
      return put(record);
    };
    f.publisher.native.run = async (op, args) => {
      if (["exchange", "renameNoReplace"].includes(op)) {
        mutations++;
        assert.ok(f.barrier.active > 0);
      }
      return run(op, args);
    };
    await assert.rejects(save(f, selected, "draft", revision));
    assert.equal(changed, true);
    assert.equal(mutations, 0);
    assert.equal(
      await fs.readFile(selected, "utf8"),
      race === "collision"
        ? "intervening"
        : race === "parent"
          ? "replacement-parent"
          : race === "retarget"
            ? "other"
            : "original",
    );
    if (revision) {
      assert.equal(await fs.readFile(target, "utf8"), "original");
      assert.equal(await fs.readFile(other, "utf8"), "other");
    }
    const record = f.store.listPublications()[0];
    assert.notEqual(record.phase, "resolved");
    const staged =
      race === "parent"
        ? record.document.staged.replace(directory, directory + "-moved")
        : record.document.staged;
    assert.equal(await fs.readFile(staged, "utf8"), "draft");
  });

test("a same-target link replacement during the final output hash cannot report a stale d1/e1 pair", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "target"),
    selected = path.join(f.home, "selected");
  await fs.writeFile(target, "old");
  await fs.symlink(target, selected);
  const document = await f.text.read(f.scope, selected);
  if (process.platform === "linux") {
    await assert.rejects(save(f, selected, "new", document.revision), {
      code: "FILE_METADATA_UNSUPPORTED",
    });
    return;
  }
  const run = f.publisher.native.run.bind(f.publisher.native);
  let reads = 0,
    exchanged = false,
    replaced = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "exchange") exchanged = true;
    // Displaced proof + staged proof precede the final paired output observation.
    if (
      op === "read" &&
      exchanged &&
      args.position === 0 &&
      args.length > 1 &&
      ++reads === 3
    ) {
      await fs.unlink(selected);
      await fs.symlink(target, selected);
      replaced = true;
    }
    return result;
  };
  await assert.rejects(save(f, selected, "new", document.revision), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(target, "utf8"), "new");
  const record = f.store.listPublications()[0];
  assert.equal(f.store.text.get(record.jobId).result, undefined);
  assert.equal(await fs.readFile(record.document.staged, "utf8"), "old");
});
