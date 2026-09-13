import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileFixture } from "../helpers/file-explorer.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";
import { FileListingStore } from "../../server/features/files/file-listing.js";
import { metadata } from "../../server/features/files/file-reading.js";

function names(listing) {
  return listing.entries.map((entry) => entry.name);
}

test("listings keep directories first for every sort and direction", async (t) => {
  const f = await fileFixture(t);
  const directory = path.join(f.project, "z-directory");
  const older = path.join(f.project, "a-small.txt");
  const newer = path.join(f.project, "b-large.txt");
  const link = path.join(f.project, "0-link");
  await fs.mkdir(directory);
  await fs.writeFile(older, "1");
  await fs.writeFile(newer, "12345");
  await fs.symlink("a-small.txt", link);
  await fs.utimes(older, new Date(1_000), new Date(1_000));
  await fs.lutimes(link, new Date(1_500), new Date(1_500));
  await fs.utimes(newer, new Date(2_000), new Date(2_000));
  const store = new FileListingStore({
    limits: { listPageSize: 200, listEntries: 100 },
  });

  const expected = {
    name: {
      asc: ["z-directory", "0-link", "a-small.txt", "b-large.txt"],
      desc: ["z-directory", "b-large.txt", "a-small.txt", "0-link"],
    },
    type: {
      asc: ["z-directory", "a-small.txt", "b-large.txt", "0-link"],
      desc: ["z-directory", "0-link", "b-large.txt", "a-small.txt"],
    },
    size: {
      asc: ["z-directory", "a-small.txt", "b-large.txt", "0-link"],
      desc: ["z-directory", "b-large.txt", "a-small.txt", "0-link"],
    },
    modifiedAt: {
      asc: ["z-directory", "a-small.txt", "0-link", "b-large.txt"],
      desc: ["z-directory", "b-large.txt", "0-link", "a-small.txt"],
    },
  };
  for (const sort of ["name", "type", "size", "modifiedAt"])
    for (const direction of ["asc", "desc"])
      assert.deepEqual(
        names(await store.list(f.projectScope, { path: "", sort, direction })),
        expected[sort][direction],
        `${sort} ${direction}`,
      );
});

test("listing hides dot entries by default, includes .git on request and retains dangling links", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.project, ".git"));
  await fs.writeFile(path.join(f.project, ".env"), "secret");
  await fs.writeFile(path.join(f.project, "visible"), "ok");
  await fs.symlink("missing", path.join(f.project, "dangling"));
  const store = new FileListingStore({ limits: { listPageSize: 200, listEntries: 20 } });

  assert.deepEqual(names(await store.list(f.projectScope, { path: "" })), [
    "dangling",
    "visible",
  ]);
  const shown = await store.list(f.projectScope, { path: "", hidden: true });
  assert.deepEqual(names(shown), [".git", ".env", "dangling", "visible"]);
  const link = shown.entries.find((entry) => entry.name === "dangling");
  assert.equal(link.type, "symlink");
  assert.equal(link.linkTarget, "missing");
  assert.match(link.revision, /^e1:[a-f0-9]{64}$/);
});

test("snapshots keep stable pages, bind their query and expire explicitly", async (t) => {
  const f = await fileFixture(t);
  for (const name of ["a", "b", "c"])
    await fs.writeFile(path.join(f.project, name), name);
  let clock = 10_000;
  const store = new FileListingStore({
    limits: { listPageSize: 2, listEntries: 20 },
    now: () => clock,
  });
  const first = await store.list(f.projectScope, { path: "" });
  await fs.unlink(path.join(f.project, "b"));
  await fs.writeFile(path.join(f.project, "d"), "d");
  const second = await store.list(f.projectScope, {
    path: "",
    page: 2,
    snapshot: first.snapshotId,
  });
  assert.deepEqual(names(first), ["a", "b"]);
  assert.deepEqual(names(second), ["c"]);
  await assert.rejects(
    store.list(f.projectScope, {
      path: "",
      page: 1,
      hidden: true,
      snapshot: first.snapshotId,
    }),
    { code: "FILE_SNAPSHOT_EXPIRED", status: 409 },
  );
  const otherScope = await makeFileScope({
    home: f.home,
    session: { id: "other", cwd: f.project },
  });
  await assert.rejects(store.list(otherScope, { path: "", snapshot: first.snapshotId }), {
    code: "FILE_SNAPSHOT_EXPIRED",
    status: 409,
  });
  clock += 30_001;
  await assert.rejects(
    store.list(f.projectScope, { path: "", page: 2, snapshot: first.snapshotId }),
    { code: "FILE_SNAPSHOT_EXPIRED", status: 409 },
  );
});

test("completed snapshots use bounded LRU eviction", async (t) => {
  const f = await fileFixture(t);
  for (let index = 0; index < 9; index++)
    await fs.mkdir(path.join(f.project, `d${index}`));
  let clock = 0;
  const store = new FileListingStore({
    limits: { listPageSize: 1, listEntries: 20 },
    now: () => ++clock,
  });
  const listings = [];
  for (let index = 0; index < 8; index++)
    listings.push(await store.list(f.projectScope, { path: `d${index}` }));
  await store.list(f.projectScope, { path: "d0", snapshot: listings[0].snapshotId });
  await store.list(f.projectScope, { path: "d8" });

  await store.list(f.projectScope, { path: "d0", snapshot: listings[0].snapshotId });
  await assert.rejects(
    store.list(f.projectScope, { path: "d1", snapshot: listings[1].snapshotId }),
    { code: "FILE_SNAPSHOT_EXPIRED", status: 409 },
  );
});

test("nine concurrent snapshot builds reject only while all eight slots are pinned", async (t) => {
  const f = await fileFixture(t);
  for (let index = 0; index < 9; index++)
    await fs.mkdir(path.join(f.project, `d${index}`));
  const store = new FileListingStore({ limits: { listPageSize: 1, listEntries: 20 } });
  const originalOpendir = fs.opendir;
  let started = 0;
  let signalStarted;
  const allStarted = new Promise((resolve) => {
    signalStarted = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fs.opendir = async (...args) => {
    started += 1;
    if (started === 8) signalStarted();
    await gate;
    return originalOpendir(...args);
  };
  t.after(() => {
    fs.opendir = originalOpendir;
    release();
  });

  const builds = Array.from({ length: 8 }, (_, index) =>
    store.list(f.projectScope, { path: `d${index}` }),
  );
  await allStarted;
  await assert.rejects(store.list(f.projectScope, { path: "d8" }), {
    code: "FILE_LIMIT_EXCEEDED",
    status: 413,
    args: { limit: 8 },
  });
  release();
  await Promise.all(builds);
  assert.equal((await store.list(f.projectScope, { path: "d8" })).path, "d8");
});

test("listing stops at the entry cap before returning a partial sorted snapshot", async (t) => {
  const f = await fileFixture(t);
  for (const name of ["c", "a", "b"])
    await fs.writeFile(path.join(f.project, name), name);
  const store = new FileListingStore({ limits: { listPageSize: 2, listEntries: 2 } });
  await assert.rejects(store.list(f.projectScope, { path: "" }), {
    code: "FILE_LIMIT_EXCEEDED",
    status: 413,
    args: { limit: 2 },
  });
});

test("metadata exposes bounded public fields, permission hints and special entries", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.project, "private.txt");
  await fs.writeFile(file, "hello", { mode: 0o600 });
  const link = path.join(f.project, "alias");
  await fs.symlink("private.txt", link);
  const socketPath = path.join(f.project, "s");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const entry = await metadata(f.projectScope, "private.txt");
  assert.deepEqual(Object.keys(entry), [
    "path",
    "name",
    "type",
    "size",
    "modifiedAt",
    "mode",
    "readable",
    "writable",
    "linkTarget",
    "revision",
  ]);
  assert.equal(entry.size, 5);
  assert.equal(entry.mode, 0o600);
  assert.equal(typeof entry.modifiedAt, "string");
  assert.doesNotThrow(() => JSON.stringify(entry));
  const linked = await metadata(f.projectScope, "alias");
  assert.equal(linked.type, "symlink");
  assert.equal(linked.size, null);
  assert.equal(linked.linkTarget, "private.txt");
  assert.equal(linked.readable, null);
  assert.equal(linked.writable, null);
  const special = await metadata(f.projectScope, "s");
  assert.equal(special.type, "special");
  assert.equal(special.readable, null);
  assert.equal(special.writable, null);
  const listedSpecial = (
    await new FileListingStore({ limits: { listPageSize: 20, listEntries: 20 } }).list(
      f.projectScope,
      { path: "" },
    )
  ).entries.find((candidate) => candidate.name === "s");
  assert.equal(listedSpecial.type, "special");

  await fs.chmod(file, 0o000);
  t.after(() => fs.chmod(file, 0o600).catch(() => {}));
  try {
    await fs.access(file);
    assert.equal(process.getuid?.(), 0, "permission test unexpectedly retained access");
  } catch {
    const denied = await metadata(f.projectScope, "private.txt");
    assert.equal(denied.readable, false);
    assert.equal(denied.writable, false);
  }
});

test("listing inputs reject misleading pages and unsupported query values", async (t) => {
  const f = await fileFixture(t);
  const store = new FileListingStore({ limits: { listPageSize: 2, listEntries: 20 } });
  for (const page of [0, -1, 1.5, "1", NaN])
    await assert.rejects(store.list(f.projectScope, { path: "", page }), {
      code: "FILE_INVALID_PAGE",
      status: 400,
    });
  await assert.rejects(store.list(f.projectScope, { path: "", sort: "mtime" }), {
    code: "FILE_INVALID_SORT",
  });
  await assert.rejects(store.list(f.projectScope, { path: "", direction: "sideways" }), {
    code: "FILE_INVALID_SORT",
  });
  await assert.rejects(store.list(f.projectScope, { path: "", snapshot: "" }), {
    code: "FILE_SNAPSHOT_EXPIRED",
    status: 409,
  });
});
