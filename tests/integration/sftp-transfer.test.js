import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sftpLimits } from "../../server/features/sftp/sftp-limits.js";
import {
  prepareTransfer,
  runTransfer,
} from "../../server/features/sftp/sftp-transfer.js";
import { partFiles, transferFixture, tree } from "../helpers/sftp-transfer-fixture.js";

const T0 = 1_700_000_000_000;

function request(fx, operation, direction, remotePath, raw, extra = {}) {
  return {
    operation,
    direction,
    remotePath,
    local: fx.target(raw, { write: direction === "down" }),
    deleteExtra: false,
    checksum: false,
    excludes: [],
    hostId: "host-1",
    hostRevision: 1,
    ...extra,
  };
}

async function transfer(fx, req, options = {}) {
  const prepared = await prepareTransfer(fx.session, req, options);
  const result = await runTransfer(fx.session, prepared, options);
  return { prepared, result };
}

const seconds = (ms) => Math.floor(ms / 1000);

for (const posixRename of [true, false]) {
  test(`folder upload creates folders and counts overwrites (posixRename ${posixRename})`, async (t) => {
    const fx = await transferFixture(t, { posixRename });
    fx.write(fx.local("site/index.html"), "new index", T0);
    fx.write(fx.local("site/css/a.css"), "body{}", T0);
    fx.write(fx.local("site/js/deep/b.js"), "let b;", T0);
    fx.write(fx.remote("www/index.html"), "old");
    const { prepared, result } = await transfer(
      fx,
      request(fx, "upload", "up", "/www", "site"),
    );
    assert.equal(prepared.kind, "folder");
    assert.deepEqual(prepared.summary.update, ["index.html"]);
    assert.equal(prepared.summary.overwrites, 1);
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(result.files, 3);
    assert.equal(result.created, 2);
    assert.equal(result.updated, 1);
    assert.equal(result.bytes, 9 + 6 + 6);
    assert.deepEqual(result.overwritten, ["index.html"]);
    assert.equal(typeof result.durationMs, "number");
    assert.deepEqual(tree(fx.remote("www")), {
      "css/a.css": "body{}",
      "index.html": "new index",
      "js/deep/b.js": "let b;",
    });
    assert.equal(
      seconds(fs.statSync(fx.remote("www/js/deep/b.js")).mtimeMs),
      seconds(T0),
    );
    assert.deepEqual(partFiles(fx.server.root), []);
  });
}

test("single file upload and download use the target's name", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("notes.txt"), "hello", T0);
  fx.write(fx.remote("docs/renamed.txt"), "older");
  const up = await transfer(
    fx,
    request(fx, "upload", "up", "/docs/renamed.txt", "notes.txt"),
  );
  assert.equal(up.prepared.kind, "file");
  assert.equal(up.result.state, "completed", JSON.stringify(up.result));
  assert.deepEqual(up.result.overwritten, ["renamed.txt"]);
  assert.equal(fs.readFileSync(fx.remote("docs/renamed.txt"), "utf8"), "hello");
  const down = await transfer(
    fx,
    request(fx, "download", "down", "/docs/renamed.txt", "back/copy.txt"),
  );
  assert.equal(down.result.state, "completed", JSON.stringify(down.result));
  assert.equal(fs.readFileSync(fx.local("back/copy.txt"), "utf8"), "hello");
});

test("folder download", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/a.txt"), "alpha", T0);
  fx.write(fx.remote("www/sub/b.txt"), "bravo", T0 + 5000);
  fx.write(fx.local("backup/a.txt"), "stale");
  const { result } = await transfer(
    fx,
    request(fx, "download", "down", "/www", "backup"),
  );
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.created, 1);
  assert.deepEqual(result.overwritten, ["a.txt"]);
  assert.deepEqual(tree(fx.local("backup")), { "a.txt": "alpha", "sub/b.txt": "bravo" });
  assert.equal(
    seconds(fs.statSync(fx.local("backup/sub/b.txt")).mtimeMs),
    seconds(T0 + 5000),
  );
  assert.deepEqual(partFiles(fx.project), []);
});

test("download needs a writable local target", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/a.txt"), "alpha");
  const req = {
    ...request(fx, "download", "down", "/www", "backup"),
    local: fx.target(""),
  };
  await assert.rejects(prepareTransfer(fx.session, req), { code: "SFTP_PATH_REFUSED" });
});

test("sync up copies new and changed only", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("site/same.txt"), "same", T0);
  fx.write(fx.local("site/changed.txt"), "changed!", T0);
  fx.write(fx.local("site/new.txt"), "new", T0);
  fx.write(fx.remote("www/same.txt"), "same", T0);
  fx.write(fx.remote("www/changed.txt"), "old", T0);
  const { prepared, result } = await transfer(
    fx,
    request(fx, "sync", "up", "/www", "site"),
  );
  assert.deepEqual(prepared.summary.create, ["new.txt"]);
  assert.deepEqual(prepared.summary.update, ["changed.txt"]);
  assert.equal(prepared.plan.unchanged, 1);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.files, 2);
  assert.deepEqual(tree(fx.remote("www")), {
    "changed.txt": "changed!",
    "new.txt": "new",
    "same.txt": "same",
  });
});

test("second sync is a no-op", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("site/a.txt"), "alpha", T0 + 123);
  fx.write(fx.local("site/sub/b.txt"), "bravo", T0 + 4567);
  const up = request(fx, "sync", "up", "/www", "site");
  assert.equal((await transfer(fx, up)).result.files, 2);
  assert.equal((await prepareTransfer(fx.session, up)).plan.files, 0);
  const down = request(fx, "sync", "down", "/www", "mirror");
  assert.equal((await transfer(fx, down)).result.files, 2);
  const again = await prepareTransfer(fx.session, down);
  assert.equal(again.plan.files, 0);
  assert.equal(again.plan.unchanged, 2);
  assert.equal((await prepareTransfer(fx.session, up)).plan.files, 0);
});

test("deleteExtra removes target-only files and empty folders", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("site/keep.txt"), "keep", T0);
  fx.write(fx.remote("www/keep.txt"), "keep", T0);
  fx.write(fx.remote("www/stray.txt"), "x");
  fx.write(fx.remote("www/old/x.txt"), "x");
  fx.write(fx.remote("www/old/deep/y.txt"), "y");
  fx.write(fx.remote("www/conf/.env"), "TOKEN=1");
  fx.write(fx.remote("www/conf/z.txt"), "z");
  const plain = await prepareTransfer(
    fx.session,
    request(fx, "sync", "up", "/www", "site"),
  );
  assert.equal(plain.plan.deletes, 0);
  const req = request(fx, "sync", "up", "/www", "site", { deleteExtra: true });
  const { prepared, result } = await transfer(fx, req);
  assert.deepEqual(prepared.summary.delete, [
    "conf/z.txt",
    "old/deep/y.txt",
    "old/x.txt",
    "stray.txt",
  ]);
  assert.deepEqual(prepared.summary.deleteDirs, ["old/deep", "old"]);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.deleted, 4);
  assert.deepEqual(tree(fx.remote("www")), {
    "conf/.env": "TOKEN=1",
    "keep.txt": "keep",
  });
  assert.ok(!fs.existsSync(fx.remote("www/old")));
});

test("deleteExtra on a server-to-local sync removes local extras", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/a.txt"), "alpha", T0);
  fx.write(fx.local("backup/a.txt"), "alpha", T0);
  fx.write(fx.local("backup/gone/old.txt"), "old");
  fx.write(fx.local("backup/.git/HEAD"), "ref");
  const req = request(fx, "sync", "down", "/www", "backup", { deleteExtra: true });
  const { result } = await transfer(fx, req);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.deleted, 1);
  assert.ok(!fs.existsSync(fx.local("backup/gone")));
  assert.ok(fs.existsSync(fx.local("backup/.git/HEAD")));
});

test("default excludes keep .git and .env local", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/.git/config"), "[remote]");
  fx.write(fx.local("site/.env"), "TOKEN=1");
  fx.write(fx.local("site/.env.local"), "TOKEN=2");
  fx.write(fx.local("site/debug.log"), "log");
  fx.write(fx.local("site/a.txt"), "alpha");
  const req = request(fx, "upload", "up", "/www", "site", { excludes: ["*.log"] });
  const { result } = await transfer(fx, req);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.deepEqual(tree(fx.remote("www")), { "a.txt": "alpha" });
});

test("pre-scan over the file cap fails before writing", async (t) => {
  const fx = await transferFixture(t);
  for (const name of ["a", "b", "c", "d"]) fx.write(fx.local(`site/${name}.txt`), name);
  await assert.rejects(
    prepareTransfer(fx.session, request(fx, "upload", "up", "/www", "site"), {
      limits: { ...sftpLimits, maxFiles: 3 },
    }),
    (error) => error.code === "SFTP_LIMIT" && error.details.files === 4,
  );
  assert.ok(!fs.existsSync(fx.remote("www")));
});

test("checksum finds same-size same-mtime change", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/a.txt"), "aaaa", T0);
  fx.write(fx.local("site/b.txt"), "same", T0);
  fx.write(fx.remote("www/a.txt"), "bbbb", T0);
  fx.write(fx.remote("www/b.txt"), "same", T0);
  const plain = request(fx, "sync", "up", "/www", "site");
  assert.equal((await prepareTransfer(fx.session, plain)).plan.files, 0);
  const { prepared, result } = await transfer(fx, { ...plain, checksum: true });
  assert.deepEqual(prepared.summary.update, ["a.txt"]);
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(fs.readFileSync(fx.remote("www/a.txt"), "utf8"), "aaaa");
});

test("symlinks are skipped and reported", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/a.txt"), "alpha");
  fs.symlinkSync("a.txt", fx.local("site/link.txt"));
  const up = await transfer(fx, request(fx, "upload", "up", "/www", "site"));
  assert.deepEqual(up.result.skipped, { links: 1, special: 0, unsafe: 0 });
  assert.deepEqual(tree(fx.remote("www")), { "a.txt": "alpha" });
  fs.symlinkSync("a.txt", fx.remote("www/remote-link"));
  const down = await transfer(fx, request(fx, "download", "down", "/www", "copy"));
  assert.equal(down.prepared.skipped.links, 1);
  assert.deepEqual(tree(fx.local("copy")), { "a.txt": "alpha" });
});

test("remote root confinement", async (t) => {
  const fx = await transferFixture(t, { resolveLinks: true });
  fx.write(fx.local("site/a.txt"), "alpha");
  fx.write(fx.remote("site/ok.txt"), "ok");
  fs.mkdirSync(fx.remote("other"));
  fs.symlinkSync("../other", fx.remote("site/out"));
  const confined = (remotePath) =>
    request(fx, "upload", "up", remotePath, "site", { remoteRoot: "/site" });
  for (const remotePath of ["/other", "/site/../other", "/site/out", "/site/out/x"])
    await assert.rejects(prepareTransfer(fx.session, confined(remotePath)), {
      code: "SFTP_PATH_REFUSED",
    });
  const { result } = await transfer(fx, confined("/site/www"));
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(fx.remote("other")), []);
  assert.equal(fs.readFileSync(fx.remote("site/www/a.txt"), "utf8"), "alpha");
});

test("unusual names", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  const names = ["a b.txt", "ä.txt", "-x.txt"];
  for (const name of names) fx.write(fx.local(`site/${name}`), name);
  fx.write(fx.local("site/bad\nname.txt"), "bad");
  const { result } = await transfer(fx, request(fx, "upload", "up", "/www", "site"));
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.equal(result.skipped.unsafe, 1);
  assert.deepEqual(tree(fx.remote("www")), Object.fromEntries(names.map((n) => [n, n])));
  const back = await transfer(fx, request(fx, "download", "down", "/www", "back"));
  assert.equal(back.result.files, 3);
  assert.deepEqual(tree(fx.local("back")), Object.fromEntries(names.map((n) => [n, n])));
  await assert.rejects(
    prepareTransfer(fx.session, request(fx, "upload", "up", "/we\nb", "site")),
    { code: "SFTP_PATH_REFUSED" },
  );
  assert.ok(!fs.existsSync(fx.remote("we\nb")));
});

test("type conflict fails without deleting", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("site/a/b.txt"), "b");
  fx.write(fx.remote("www/a"), "a file where a folder goes");
  fx.write(fx.remote("www/stray.txt"), "stray");
  const req = request(fx, "sync", "up", "/www", "site", { deleteExtra: true });
  const { result } = await transfer(fx, req);
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_TYPE_CONFLICT");
  assert.equal(result.failedPath, "a/b.txt");
  assert.deepEqual(tree(fx.remote("www")), {
    a: "a file where a folder goes",
    "stray.txt": "stray",
  });
  fx.write(fx.local("other/x"), "file");
  fx.write(fx.remote("dst/x/inner.txt"), "inner");
  const reverse = await transfer(
    fx,
    request(fx, "sync", "up", "/dst", "other", { deleteExtra: true }),
  );
  assert.equal(reverse.result.code, "SFTP_TYPE_CONFLICT");
  assert.equal(reverse.result.failedPath, "x");
  assert.equal(fs.readFileSync(fx.remote("dst/x/inner.txt"), "utf8"), "inner");
  assert.deepEqual(partFiles(fx.server.root), []);
});

test("an approved plan that changed refuses to run", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/a.txt"), "alpha", T0);
  const req = request(fx, "upload", "up", "/www", "site");
  const prepared = await prepareTransfer(fx.session, req);
  fx.write(fx.local("site/b.txt"), "bravo", T0);
  const result = await runTransfer(fx.session, prepared);
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_PLAN_CHANGED");
  assert.equal(result.files, 0);
  assert.ok(!fs.existsSync(fx.remote("www")));
});

test("a server stream longer than planned never writes more", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/a.txt"), "alpha", T0);
  const req = request(fx, "download", "down", "/www", "copy");
  const prepared = await prepareTransfer(fx.session, req);
  const { Readable } = await import("node:stream");
  const hostile = new Proxy(fx.session, {
    get(target, prop) {
      if (prop === "readStream")
        return () => Readable.from([Buffer.from("alpha-and-more")]);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await runTransfer(hostile, prepared);
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_PLAN_CHANGED");
  assert.equal(result.failedPath, "a.txt");
  assert.ok(!fs.existsSync(path.join(fx.project, "copy", "a.txt")));
  assert.deepEqual(partFiles(fx.project), []);
});
