import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { openSftp } from "../../server/features/sftp/sftp-client.js";
import { sftpProblem } from "../../server/features/sftp/sftp-errors.js";
import { sshKeyPair, startSftpServer } from "../helpers/sftp-server.js";

async function server(t, options) {
  const fixture = await startSftpServer(options);
  t.after(() => fixture.close());
  return fixture;
}

async function session(t, fixture, connection = {}, options = {}) {
  const opened = await openSftp(
    {
      host: fixture.host,
      port: fixture.port,
      username: "deploy",
      hostKey: fixture.hostKey,
      password: "pw-secret",
      ...connection,
    },
    options,
  );
  t.after(() => opened.close());
  return opened;
}

function assertNoSecret(error, secret = "pw-secret") {
  assert.ok(!String(error).includes(secret));
  assert.ok(!String(error?.stack).includes(secret));
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(!JSON.stringify(Object.getOwnPropertyNames(error)).includes("password"));
}

test("sftpProblem carries the code and its default status", () => {
  const defaults = {
    SFTP_AUTH_FAILED: 502,
    SFTP_HOST_KEY_MISMATCH: 502,
    SFTP_UNREACHABLE: 502,
    SFTP_TIMEOUT: 504,
    SFTP_NOT_FOUND: 404,
    SFTP_PERMISSION: 403,
    SFTP_PATH_REFUSED: 403,
    SFTP_LIMIT: 413,
    SFTP_TYPE_CONFLICT: 409,
    SFTP_PLAN_CHANGED: 409,
    SFTP_JOB_NOT_FOUND: 404,
    SFTP_BUSY: 429,
    SFTP_CANCELLED: 409,
    SFTP_FAILED: 502,
  };
  for (const [code, status] of Object.entries(defaults)) {
    const error = sftpProblem(code);
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
  }
  assert.equal(sftpProblem("SFTP_FAILED", 500).status, 500);
  assert.throws(() => sftpProblem("SFTP_UNKNOWN"));
});

test("password login lists the root", async (t) => {
  const fixture = await server(t);
  await fs.writeFile(path.join(fixture.root, "hello.txt"), "hello");
  await fs.mkdir(path.join(fixture.root, "site"));
  const sftp = await session(t, fixture);
  const entries = await sftp.readdir("/");
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    sorted.map(({ name, type, size }) => ({
      name,
      type,
      size: type === "file" ? size : 0,
    })),
    [
      { name: "hello.txt", type: "file", size: 5 },
      { name: "site", type: "dir", size: 0 },
    ],
  );
  assert.ok(sorted.every((entry) => Number.isFinite(entry.mtimeMs) && entry.mtimeMs > 0));
  assert.equal(sftp.closed, false);
});

test("key login", async (t) => {
  const key = sshKeyPair();
  const fixture = await server(t, { users: { deploy: { publicKey: key.public } } });
  const sftp = await session(t, fixture, {
    password: undefined,
    privateKey: Buffer.from(key.private),
  });
  assert.equal(await sftp.realpath("."), "/");
});

test("keyboard-interactive password login", async (t) => {
  const fixture = await server(t, { keyboardInteractive: true });
  const sftp = await session(t, fixture);
  assert.equal(await sftp.realpath("."), "/");
});

test("an unchrooted server resolves the home folder", async (t) => {
  const fixture = await server(t, { chroot: false });
  const sftp = await session(t, fixture);
  assert.equal(await sftp.realpath("."), "/home/deploy");
});

test("pinned key mismatch is refused", async (t) => {
  const fixture = await server(t);
  const error = await openSftp({
    host: fixture.host,
    port: fixture.port,
    username: "deploy",
    hostKey: fixture.otherHostKey,
    password: "pw-secret",
  }).catch((caught) => caught);
  assert.equal(error.code, "SFTP_HOST_KEY_MISMATCH");
  assert.equal(error.status, 502);
  assert.equal(fixture.authAttempts(), 0);
  assertNoSecret(error);
});

test("wrong password", async (t) => {
  const fixture = await server(t, { users: { deploy: { password: "other-secret" } } });
  const error = await openSftp({
    host: fixture.host,
    port: fixture.port,
    username: "deploy",
    hostKey: fixture.hostKey,
    password: "pw-secret",
  }).catch((caught) => caught);
  assert.equal(error.code, "SFTP_AUTH_FAILED");
  assert.ok(fixture.authAttempts() > 0);
});

test("connect timeout", async (t) => {
  const sockets = new Set();
  const silent = net.createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => silent.close(resolve));
  });
  const fixture = await server(t);
  const started = Date.now();
  const error = await openSftp(
    {
      host: "127.0.0.1",
      port: silent.address().port,
      username: "deploy",
      hostKey: fixture.hostKey,
      password: "pw-secret",
    },
    { connectMs: 200 },
  ).catch((caught) => caught);
  assert.equal(error.code, "SFTP_TIMEOUT");
  assert.equal(error.status, 504);
  assert.ok(Date.now() - started < 5000);
});

test("refused connection is unreachable", async (t) => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const fixture = await server(t);
  const error = await openSftp({
    host: "127.0.0.1",
    port,
    username: "deploy",
    hostKey: fixture.hostKey,
    password: "pw-secret",
  }).catch((caught) => caught);
  assert.equal(error.code, "SFTP_UNREACHABLE");
});

test("abort signal closes the session", async (t) => {
  const fixture = await server(t);
  const controller = new AbortController();
  const sftp = await session(t, fixture, {}, { signal: controller.signal });
  controller.abort();
  assert.equal(sftp.closed, true);
  await assert.rejects(sftp.readdir("/"), { code: "SFTP_CANCELLED" });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(session(t, fixture, {}, { signal: aborted.signal }), {
    code: "SFTP_CANCELLED",
  });
});

test("without posix-rename, overwrite replaces a file with a plain rename", async (t) => {
  const fixture = await server(t, { posixRename: false });
  await fs.writeFile(path.join(fixture.root, "upload.part"), "new");
  await fs.writeFile(path.join(fixture.root, "index.html"), "old");
  await fs.writeFile(path.join(fixture.root, "fresh.part"), "fresh");
  const sftp = await session(t, fixture);
  await sftp.rename("/upload.part", "/index.html", { overwrite: true });
  assert.equal(await fs.readFile(path.join(fixture.root, "index.html"), "utf8"), "new");
  assert.equal(await sftp.lstat("/upload.part"), null);
  await sftp.rename("/fresh.part", "/fresh.txt", { overwrite: true });
  assert.equal(await fs.readFile(path.join(fixture.root, "fresh.txt"), "utf8"), "fresh");
  assert.ok(!fixture.ops().includes("posix-rename@openssh.com"));
  assert.ok(fixture.ops().includes("RENAME"));
});

test("overwrite never replaces a directory or a link", async (t) => {
  for (const posixRename of [false, true]) {
    const fixture = await server(t, { posixRename });
    await fs.writeFile(path.join(fixture.root, "file.part"), "new");
    await fs.mkdir(path.join(fixture.root, "site"));
    await fs.writeFile(path.join(fixture.root, "site/keep.txt"), "keep");
    await fs.writeFile(path.join(fixture.root, "real.txt"), "real");
    await fs.symlink("real.txt", path.join(fixture.root, "link.txt"));
    const sftp = await session(t, fixture);
    const refused = posixRename ? "SFTP_FAILED" : "SFTP_TYPE_CONFLICT";
    await assert.rejects(sftp.rename("/file.part", "/site", { overwrite: true }), {
      code: refused,
    });
    assert.equal(
      await fs.readFile(path.join(fixture.root, "site/keep.txt"), "utf8"),
      "keep",
    );
    if (!posixRename)
      await assert.rejects(sftp.rename("/file.part", "/link.txt", { overwrite: true }), {
        code: "SFTP_TYPE_CONFLICT",
      });
    assert.equal(await fs.readlink(path.join(fixture.root, "link.txt")), "real.txt");
    assert.equal(await fs.readFile(path.join(fixture.root, "file.part"), "utf8"), "new");
  }
});

test("stream errors carry only the bare code", async (t) => {
  const fixture = await server(t);
  const sftp = await session(t, fixture);
  const error = await (async () => {
    for await (const chunk of sftp.readStream("/missing dir/secret.txt"))
      assert.ok(chunk);
  })().catch((caught) => caught);
  assert.equal(error.code, "SFTP_NOT_FOUND");
  assert.equal(error.status, 404);
  assert.equal(error.message, "SFTP_NOT_FOUND");
  for (const text of [String(error), String(error.stack), JSON.stringify(error)]) {
    assert.ok(!text.includes("secret.txt"));
    assert.ok(!text.includes(fixture.root));
  }
});

test("the client loads in an eval process like the release smoke check", async () => {
  const client = pathToFileURL(path.resolve("server/features/sftp/sftp-client.js")).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(client)}); console.log(typeof m.openSftp);`,
  ]);
  assert.equal(stdout.trim(), "function");
});

test("rename overwrite uses posix-rename", async (t) => {
  const fixture = await server(t);
  await fs.writeFile(path.join(fixture.root, "new.txt"), "new");
  await fs.writeFile(path.join(fixture.root, "old.txt"), "old");
  const sftp = await session(t, fixture);
  await assert.rejects(sftp.rename("/new.txt", "/old.txt"), { code: "SFTP_FAILED" });
  assert.ok(!fixture.ops().includes("posix-rename@openssh.com"));
  await sftp.rename("/new.txt", "/old.txt", { overwrite: true });
  assert.ok(fixture.ops().includes("posix-rename@openssh.com"));
  assert.equal(await fs.readFile(path.join(fixture.root, "old.txt"), "utf8"), "new");
  assert.equal(await sftp.lstat("/new.txt"), null);
  await sftp.rename("/old.txt", "/moved.txt");
  assert.equal((await sftp.lstat("/moved.txt")).type, "file");
});

test("file and folder operations map types, times and statuses", async (t) => {
  const fixture = await server(t);
  const sftp = await session(t, fixture);
  await sftp.mkdir("/site");
  assert.equal((await sftp.lstat("/site")).type, "dir");
  await pipeline(
    Readable.from([Buffer.from("päge ")]),
    sftp.writeStream("/site/a b.txt"),
  );
  await sftp.setTimes("/site/a b.txt", 1_700_000_000_000);
  const stat = await sftp.lstat("/site/a b.txt");
  assert.deepEqual(stat, { type: "file", size: 6, mtimeMs: 1_700_000_000_000 });
  const chunks = [];
  for await (const chunk of sftp.readStream("/site/a b.txt")) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "päge ");
  await fs.symlink("a b.txt", path.join(fixture.root, "site/link"));
  assert.equal((await sftp.lstat("/site/link")).type, "link");
  assert.equal(await sftp.lstat("/missing"), null);
  await assert.rejects(sftp.readdir("/missing"), { code: "SFTP_NOT_FOUND", status: 404 });
  fixture.failNext("REMOVE", "PERMISSION_DENIED");
  await assert.rejects(sftp.unlink("/site/a b.txt"), { code: "SFTP_PERMISSION" });
  await sftp.unlink("/site/link");
  await sftp.unlink("/site/a b.txt");
  await sftp.rmdir("/site");
  assert.deepEqual(await sftp.readdir("/"), []);
});

test("an unanswered call times out after the idle limit", async (t) => {
  const fixture = await server(t);
  const sftp = await session(t, fixture, {}, { idleMs: 200 });
  fixture.stallNext("OPENDIR");
  await assert.rejects(sftp.readdir("/"), { code: "SFTP_TIMEOUT" });
  assert.equal(sftp.closed, true);
});

test("a dropped connection fails the stream", async (t) => {
  const fixture = await server(t);
  await fs.writeFile(path.join(fixture.root, "big.bin"), Buffer.alloc(512 * 1024, 7));
  const sftp = await session(t, fixture);
  fixture.dropAfterBytes(64 * 1024);
  await assert.rejects(async () => {
    for await (const chunk of sftp.readStream("/big.bin")) assert.ok(chunk.length);
  });
  assert.equal(sftp.closed, true);
  await assert.rejects(sftp.realpath("."), { code: "SFTP_UNREACHABLE" });
});

test("password never in error message", async (t) => {
  const fixture = await server(t, { users: { deploy: { password: "other-secret" } } });
  for (const hostKey of [fixture.hostKey, fixture.otherHostKey]) {
    const error = await openSftp({
      host: fixture.host,
      port: fixture.port,
      username: "deploy",
      hostKey,
      password: "pw-secret",
    }).catch((caught) => caught);
    assert.ok(error instanceof Error);
    assertNoSecret(error);
  }
});
