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
  let calls = 0;
  fx.server.stallNext("WRITE");
  const result = await runTransfer(fx.session, prepared, {
    stillAuthorized: async () => ++calls <= 1,
    authorizeEveryMs: 20,
  });
  assert.equal(result.state, "revoked");
  assert.equal(result.files, 0);
  assert.equal(result.failedPath, "big.bin");
  assert.deepEqual(partFiles(fx.server.root), []);
});
