import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  prepareTransfer,
  runTransfer,
} from "../../server/features/sftp/sftp-transfer.js";
import { partFiles, transferFixture, tree } from "../helpers/sftp-transfer-fixture.js";

const MB = 1024 * 1024;

function request(fx, operation, direction, remotePath, raw, extra = {}) {
  return {
    operation,
    direction,
    remotePath,
    local: fx.target(raw, { write: direction === "down" }),
    excludes: [],
    ...extra,
  };
}

for (const posixRename of [true, false]) {
  test(`dropped connection leaves no part files (upload, posixRename ${posixRename})`, async (t) => {
    const fx = await transferFixture(t, { posixRename });
    fx.write(fx.local("site/a.txt"), "small");
    fx.write(fx.local("site/big.bin"), randomBytes(2 * MB));
    const req = request(fx, "sync", "up", "/www", "site");
    const prepared = await prepareTransfer(fx.session, req);
    fx.server.dropAfterBytes(MB);
    const result = await runTransfer(fx.session, prepared, { reopen: fx.connect });
    assert.equal(result.state, "failed");
    assert.equal(result.code, "SFTP_UNREACHABLE");
    assert.equal(result.failedPath, "big.bin");
    assert.equal(result.files, 1);
    assert.deepEqual(partFiles(fx.server.root), []);
    // Re-running the sync completes.
    const session = await fx.connect();
    const again = await prepareTransfer(session, req);
    assert.deepEqual(again.summary.create, ["big.bin"]);
    const rerun = await runTransfer(session, again);
    assert.equal(rerun.state, "completed", JSON.stringify(rerun));
    assert.equal(fs.statSync(fx.remote("www/big.bin")).size, 2 * MB);
  });
}

test("dropped connection leaves no part files (download)", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.remote("www/big.bin"), randomBytes(2 * MB));
  const prepared = await prepareTransfer(
    fx.session,
    request(fx, "download", "down", "/www", "copy"),
  );
  fx.server.dropAfterBytes(MB);
  const result = await runTransfer(fx.session, prepared);
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_UNREACHABLE");
  assert.equal(result.failedPath, "big.bin");
  assert.deepEqual(partFiles(fx.project), []);
  assert.ok(!fs.existsSync(fx.local("copy/big.bin")));
});

for (const direction of ["up", "down"]) {
  test(`cancel mid-transfer (${direction})`, async (t) => {
    const fx = await transferFixture(t, { posixRename: false });
    if (direction === "up") fx.write(fx.local("site/big.bin"), randomBytes(4 * MB));
    else fx.write(fx.remote("www/big.bin"), randomBytes(4 * MB));
    const req =
      direction === "up"
        ? request(fx, "upload", "up", "/www", "site")
        : request(fx, "download", "down", "/www", "site");
    const prepared = await prepareTransfer(fx.session, req);
    const controller = new AbortController();
    const seen = [];
    const result = await runTransfer(fx.session, prepared, {
      signal: controller.signal,
      onProgress(progress) {
        seen.push(progress);
        if (progress.bytesDone > 0) controller.abort();
      },
    });
    assert.equal(result.state, "cancelled");
    assert.equal(result.code, "SFTP_CANCELLED");
    assert.equal(result.files, 0);
    assert.equal(seen[0].files, 1);
    assert.equal(seen[0].bytes, 4 * MB);
    assert.deepEqual(partFiles(fx.server.root), []);
    assert.deepEqual(partFiles(fx.project), []);
    if (direction === "up") assert.ok(!fs.existsSync(fx.remote("www/big.bin")));
    else assert.ok(!fs.existsSync(fx.local("site/big.bin")));
  });
}

test("stillAuthorized false stops before the next file", async (t) => {
  const fx = await transferFixture(t);
  for (const name of ["a", "b", "c"]) fx.write(fx.local(`site/${name}.txt`), name);
  const prepared = await prepareTransfer(
    fx.session,
    request(fx, "upload", "up", "/www", "site"),
  );
  let calls = 0;
  const result = await runTransfer(fx.session, prepared, {
    stillAuthorized: async () => ++calls <= 1,
  });
  assert.equal(result.state, "revoked");
  assert.equal(result.files, 1);
  assert.deepEqual(tree(fx.remote("www")), { "a.txt": "a" });
});

test("stillAuthorized is checked during a long file", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/big.bin"), randomBytes(MB));
  const prepared = await prepareTransfer(
    fx.session,
    request(fx, "upload", "up", "/www", "site"),
  );
  fx.server.stallNext("WRITE");
  // Revoked only once the file is being written, whatever the timer order.
  const result = await runTransfer(fx.session, prepared, {
    stillAuthorized: async () => !fx.server.ops().includes("WRITE"),
    authorizeEveryMs: 20,
  });
  assert.equal(result.state, "revoked");
  assert.equal(result.files, 0);
  assert.equal(result.failedPath, "big.bin");
  assert.deepEqual(partFiles(fx.server.root), []);
});

test("dropped connection during the delete phase of a sync", async (t) => {
  const fx = await transferFixture(t, { posixRename: false });
  fx.write(fx.local("site/a.txt"), "alpha");
  for (const name of ["x", "y"]) fx.write(fx.remote(`www/${name}.txt`), name);
  const req = request(fx, "sync", "up", "/www", "site", { deleteExtra: true });
  const prepared = await prepareTransfer(fx.session, req);
  fx.server.dropNext("REMOVE");
  const result = await runTransfer(fx.session, prepared, { reopen: fx.connect });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_UNREACHABLE");
  assert.equal(result.files, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.failedPath, "x.txt");
  assert.deepEqual(partFiles(fx.server.root), []);
  const session = await fx.connect();
  const rerun = await runTransfer(session, await prepareTransfer(session, req));
  assert.equal(rerun.state, "completed", JSON.stringify(rerun));
  assert.equal(rerun.deleted, 2);
  assert.deepEqual(tree(fx.remote("www")), { "a.txt": "alpha" });
});

test("a throwing stillAuthorized revokes a transfer", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/a.txt"), "a");
  const prepared = await prepareTransfer(
    fx.session,
    request(fx, "upload", "up", "/www", "site"),
  );
  const result = await runTransfer(fx.session, prepared, {
    stillAuthorized: async () => {
      throw new Error("store unavailable");
    },
  });
  assert.equal(result.state, "revoked");
  assert.equal(result.files, 0);
  assert.ok(!fs.existsSync(fx.remote("www/a.txt")));
});

test("a delete checks the planned size and mtime first", async (t) => {
  const fx = await transferFixture(t);
  fx.write(fx.local("site/a.txt"), "alpha");
  fx.write(fx.remote("www/stray.txt"), "stray");
  const req = request(fx, "sync", "up", "/www", "site", { deleteExtra: true });
  const prepared = await prepareTransfer(fx.session, req);
  // Changed between the re-plan and the delete: lstat now reports another size.
  const racing = new Proxy(fx.session, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== "lstat")
        return typeof value === "function" ? value.bind(target) : value;
      return async (p) => {
        const stat = await target.lstat(p);
        return p.endsWith("stray.txt") && stat ? { ...stat, size: 99 } : stat;
      };
    },
  });
  const result = await runTransfer(racing, prepared);
  assert.equal(result.state, "failed");
  assert.equal(result.code, "SFTP_PLAN_CHANGED");
  assert.equal(result.failedPath, "stray.txt");
  assert.equal(fs.readFileSync(fx.remote("www/stray.txt"), "utf8"), "stray");
});
