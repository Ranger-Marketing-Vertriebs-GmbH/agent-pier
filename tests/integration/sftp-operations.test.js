import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  planDelete,
  runDelete,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpStat,
} from "../../server/features/sftp/sftp-operations.js";
import { transferFixture, tree } from "../helpers/sftp-transfer-fixture.js";

const T0 = 1_700_000_000_000;
const counts = (result) => [result.state, result.files, result.dirs];

test("list truncates at limit", async (t) => {
  const fx = await transferFixture(t);
  for (const name of ["c.txt", "a.txt", "b.txt"])
    fx.write(fx.remote(`www/${name}`), name, T0);
  fs.mkdirSync(fx.remote("www/dir"));
  fx.write(fx.remote("www/bad\nname"), "x");
  const all = await sftpList(fx.session, "/www");
  assert.deepEqual(
    all.entries.map((e) => [e.name, e.type]),
    [
      ["a.txt", "file"],
      ["b.txt", "file"],
      ["c.txt", "file"],
      ["dir", "dir"],
    ],
  );
  assert.equal(all.entries[0].size, 5);
  assert.equal(all.entries[0].mtime, new Date(T0).toISOString());
  assert.equal(all.truncated, false);
  const capped = await sftpList(fx.session, "/www", { limit: 2 });
  assert.deepEqual(
    capped.entries.map((e) => e.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(capped.truncated, true);
  assert.equal(capped.path, "/www");
});

test("stat and mkdir", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/a.txt"), "alpha", T0);
  assert.deepEqual(await sftpStat(fx.session, "/www/a.txt"), {
    path: "/www/a.txt",
    type: "file",
    size: 5,
    mtime: new Date(T0).toISOString(),
  });
  await assert.rejects(sftpStat(fx.session, "/nope"), { code: "SFTP_NOT_FOUND" });
  await assert.rejects(sftpMkdir(fx.session, "/x/y/z"), { code: "SFTP_NOT_FOUND" });
  assert.deepEqual(await sftpMkdir(fx.session, "/x/y/z", { parents: true }), {
    path: "/x/y/z",
    created: true,
  });
  assert.equal((await sftpMkdir(fx.session, "/x/y/z")).created, false);
  await assert.rejects(sftpMkdir(fx.session, "/www/a.txt"), {
    code: "SFTP_TYPE_CONFLICT",
  });
});

test("rename refuses existing target", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("a.txt"), "a");
  fx.write(fx.remote("b.txt"), "b");
  await assert.rejects(sftpRename(fx.session, "/a.txt", "/b.txt"), {
    code: "SFTP_TYPE_CONFLICT",
  });
  assert.deepEqual(tree(fx.server.root), { "a.txt": "a", "b.txt": "b" });
  await assert.rejects(sftpRename(fx.session, "/missing", "/c.txt"), {
    code: "SFTP_NOT_FOUND",
  });
  assert.deepEqual(await sftpRename(fx.session, "/a.txt", "/c.txt"), {
    from: "/a.txt",
    to: "/c.txt",
  });
  assert.deepEqual(tree(fx.server.root), { "b.txt": "b", "c.txt": "a" });
});

test("non-recursive delete refuses a non-empty folder", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("full/a.txt"), "a");
  fs.mkdirSync(fx.remote("empty"));
  fx.write(fx.remote("file.txt"), "abc");
  await assert.rejects(planDelete(fx.session, "/full", { root: "/" }), {
    code: "SFTP_TYPE_CONFLICT",
  });
  const empty = await planDelete(fx.session, "/empty", { root: "/" });
  assert.deepEqual(empty, {
    path: "/empty",
    recursive: false,
    files: [],
    dirs: ["/empty"],
    bytes: 0,
  });
  assert.deepEqual(counts(await runDelete(fx.session, empty, { root: "/" })), [
    "completed",
    0,
    1,
  ]);
  const file = await planDelete(fx.session, "/file.txt", { root: "/" });
  assert.equal(file.bytes, 3);
  assert.deepEqual(counts(await runDelete(fx.session, file, { root: "/" })), [
    "completed",
    1,
    0,
  ]);
  assert.deepEqual(tree(fx.server.root), { "full/a.txt": "a" });
  await assert.rejects(planDelete(fx.session, "/", { root: "/" }), {
    code: "SFTP_PATH_REFUSED",
  });
});

test("recursive delete removes a link, not its target", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("keep/precious.txt"), "precious");
  fx.write(fx.remote("doomed/sub/a.txt"), "a");
  fs.symlinkSync("../keep", fx.remote("doomed/sub/link"));
  const plan = await planDelete(fx.session, "/doomed", { recursive: true, root: "/" });
  assert.deepEqual(plan.files, ["/doomed/sub/a.txt", "/doomed/sub/link"]);
  assert.deepEqual(plan.dirs, ["/doomed/sub", "/doomed"]);
  const progress = [];
  const done = await runDelete(fx.session, plan, {
    root: "/",
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(counts(done), ["completed", 2, 2]);
  assert.equal(typeof done.durationMs, "number");
  assert.ok(progress.length >= 4);
  assert.ok(!fs.existsSync(fx.remote("doomed")));
  assert.deepEqual(tree(fx.server.root), { "keep/precious.txt": "precious" });
});

test("runDelete refuses a changed plan and paths outside it", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("dir/a.txt"), "a");
  const plan = await planDelete(fx.session, "/dir", { recursive: true, root: "/" });
  fx.write(fx.remote("dir/b.txt"), "b");
  const changed = await runDelete(fx.session, plan, { root: "/" });
  assert.deepEqual(counts(changed), ["failed", 0, 0]);
  assert.equal(changed.code, "SFTP_PLAN_CHANGED");
  assert.deepEqual(tree(fx.remote("dir")), { "a.txt": "a", "b.txt": "b" });
  fx.write(fx.remote("other.txt"), "o");
  const forged = {
    ...(await planDelete(fx.session, "/dir/a.txt", { root: "/" })),
    files: ["/other.txt"],
  };
  assert.equal(
    (await runDelete(fx.session, forged, { root: "/" })).code,
    "SFTP_PLAN_CHANGED",
  );
  const root = await planDelete(fx.session, "/dir/a.txt", { root: "/" });
  assert.equal(
    (await runDelete(fx.session, root, { root: "/elsewhere" })).code,
    "SFTP_PATH_REFUSED",
  );
  assert.ok(fs.existsSync(fx.remote("other.txt")));
  assert.ok(fs.existsSync(fx.remote("dir/a.txt")));
});

test("recursive delete of the allowed folder itself is refused", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("site/a.txt"), "a");
  fx.write(fx.remote("site/sub/b.txt"), "b");
  for (const target of ["/site", "/", "/other", "/site/.."])
    await assert.rejects(
      planDelete(fx.session, target, { recursive: true, root: "/site" }),
      { code: "SFTP_PATH_REFUSED" },
    );
  // A plan made without the root cannot run against it either.
  const unconfined = await planDelete(fx.session, "/site", {
    recursive: true,
    root: "/",
  });
  const result = await runDelete(fx.session, unconfined, { root: "/site" });
  assert.deepEqual(counts(result), ["failed", 0, 0]);
  assert.equal(result.code, "SFTP_PATH_REFUSED");
  assert.deepEqual(tree(fx.remote("site")), { "a.txt": "a", "sub/b.txt": "b" });
  const inside = await planDelete(fx.session, "/site/sub", {
    recursive: true,
    root: "/site",
  });
  assert.equal(
    (await runDelete(fx.session, inside, { root: "/site" })).state,
    "completed",
  );
  assert.deepEqual(tree(fx.remote("site")), { "a.txt": "a" });
});

test("a link in an ancestor of the delete target is not followed", async (t) => {
  const fx = await transferFixture(t, { resolveLinks: true });
  fx.write(fx.remote("other/f.txt"), "outside");
  fx.write(fx.remote("site/keep.txt"), "keep");
  fs.symlinkSync("../other", fx.remote("site/out"));
  const options = { recursive: true, root: "/site" };
  await assert.rejects(planDelete(fx.session, "/site/out/f.txt", options), {
    code: "SFTP_PATH_REFUSED",
  });
  const link = await planDelete(fx.session, "/site/out", options);
  assert.deepEqual(link.files, ["/site/out"]);
  assert.equal((await runDelete(fx.session, link, { root: "/site" })).state, "completed");
  assert.equal(fs.readFileSync(fx.remote("other/f.txt"), "utf8"), "outside");
  assert.deepEqual(tree(fx.remote("site")), { "keep.txt": "keep" });
});

test("runDelete stops when cancelled", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("dir/a.txt"), "a");
  const plan = await planDelete(fx.session, "/dir", { recursive: true, root: "/" });
  const controller = new AbortController();
  controller.abort();
  const result = await runDelete(fx.session, plan, {
    root: "/",
    signal: controller.signal,
  });
  assert.deepEqual(counts(result), ["cancelled", 0, 0]);
  assert.equal(result.code, "SFTP_CANCELLED");
  assert.ok(fs.existsSync(fx.remote("dir/a.txt")));
});

test("cancel mid-delete stops before the next step", async (t) => {
  const fx = await transferFixture(t);
  for (const name of ["a", "b", "c"]) fx.write(fx.remote(`dir/${name}.txt`), name);
  const plan = await planDelete(fx.session, "/dir", { recursive: true, root: "/" });
  const controller = new AbortController();
  const result = await runDelete(fx.session, plan, {
    root: "/",
    signal: controller.signal,
    onProgress: ({ files }) => files === 1 && controller.abort(),
  });
  assert.deepEqual(counts(result), ["cancelled", 1, 0]);
  assert.deepEqual(tree(fx.remote("dir")), { "b.txt": "b", "c.txt": "c" });
});

test("stillAuthorized false or throwing revokes a delete", async (t) => {
  const fx = await transferFixture(t);
  for (const name of ["a", "b"]) fx.write(fx.remote(`dir/${name}.txt`), name);
  const plan = await planDelete(fx.session, "/dir", { recursive: true, root: "/" });
  let calls = 0;
  const revoked = await runDelete(fx.session, plan, {
    root: "/",
    stillAuthorized: async () => ++calls <= 2,
  });
  assert.deepEqual(counts(revoked), ["revoked", 1, 0]);
  assert.equal(revoked.code, undefined);
  const again = await planDelete(fx.session, "/dir", { recursive: true, root: "/" });
  const thrown = await runDelete(fx.session, again, {
    root: "/",
    stillAuthorized: async () => {
      throw new Error("store unavailable");
    },
  });
  assert.deepEqual(counts(thrown), ["revoked", 0, 0]);
  assert.deepEqual(tree(fx.remote("dir")), { "b.txt": "b" });
});
