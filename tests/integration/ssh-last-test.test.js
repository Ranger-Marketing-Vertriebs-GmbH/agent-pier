import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { SshCatalog } from "../../server/features/ssh/ssh-catalog.js";
import { SshAccessStore } from "../../server/features/ssh/ssh-access-store.js";
import { runOpenSsh } from "../../server/features/ssh/ssh-keys.js";
import { archiveText } from "../helpers/backup-archive.js";
import { startSftpServer } from "../helpers/sftp-server.js";

const password = "pw-secret-91d2e";
const passphrase = "last test backup passphrase";

/** Starts the SSH catalog of a data folder the way the server does. */
function start(dataDir, run) {
  const catalog = new SshCatalog({ dataDir });
  catalog.migrate();
  return new SshAccessStore({ dataDir, catalog, ...(run ? { run } : {}) });
}

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-lt-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startSftpServer({ users: { deploy: { password } } });
  t.after(() => server.close());
  const dataDir = path.join(root, "live");
  fs.mkdirSync(dataDir);
  const endpoint = { host: server.host, port: server.port, username: "deploy" };
  const sftp = (name, extra) => ({
    name,
    ...endpoint,
    hostKey: server.hostKey,
    type: "sftp",
    auth: "password",
    password,
    ...extra,
  });
  return { root, dataDir, server, endpoint, sftp };
}

const lastTest = (store, id) =>
  store.withLastTests(store.list()).find((access) => access.id === id).lastTest;
const resultsFile = (dataDir) => path.join(dataDir, "ssh", "test-results.json");

test("SFTP test results persist across a reload and name the cause", async (t) => {
  const { dataDir, server, sftp } = await setup(t);
  const store = start(dataDir);
  const good = await store.create(sftp("Good"));
  const wrong = await store.create(sftp("Wrong", { password: "not-the-password" }));
  const moved = await store.create(
    sftp("Moved", { username: "other", hostKey: server.otherHostKey }),
  );
  assert.equal(lastTest(store, good.id), null);
  assert.deepEqual(await store.test(good.id), { ok: true });
  for (const access of [wrong, moved])
    await assert.rejects(store.test(access.id), { status: 502 });

  const reloaded = start(dataDir);
  const ok = lastTest(reloaded, good.id);
  assert.equal(ok.ok, true);
  assert.match(ok.at, /^\d{4}-\d{2}-\d{2}T/);
  const auth = lastTest(reloaded, wrong.id);
  assert.equal(auth.ok, false);
  assert.equal(auth.code, "SFTP_AUTH_FAILED");
  assert.equal(auth.hostKeyMismatch, false);
  assert.equal(auth.messageKey, "ssh.connectionFailed");
  const hostKey = lastTest(reloaded, moved.id);
  assert.equal(hostKey.code, "SFTP_HOST_KEY_MISMATCH");
  assert.equal(hostKey.hostKeyMismatch, true);
  const stored = fs.readFileSync(resultsFile(dataDir), "utf8");
  for (const secret of [password, "not-the-password"])
    assert.equal(stored.includes(secret), false);

  // A new credential is a new revision: the earlier failure no longer applies.
  await reloaded.update(wrong.id, { password });
  assert.equal(lastTest(reloaded, wrong.id), null);
  assert.equal(lastTest(reloaded, good.id).ok, true);
  await reloaded.remove(good.id);
  assert.equal(stored.includes(good.id), true);
  assert.equal(fs.readFileSync(resultsFile(dataDir), "utf8").includes(good.id), false);
});

test("SSH test failures keep a sanitized OpenSSH line and the host key state", async (t) => {
  const { dataDir, endpoint, server } = await setup(t);
  let answer = null;
  const run = async (command, args, options) => {
    if (command !== "ssh") return runOpenSsh(command, args, options);
    if (answer) throw answer;
    return { stdout: "", stderr: "" };
  };
  const store = start(dataDir, run);
  const access = await store.create({
    name: "Shell",
    ...endpoint,
    hostKey: server.hostKey,
  });
  answer = Object.assign(new Error("Command failed: ssh SECRET-ARGS"), {
    code: 255,
    stderr:
      "@@@@@@@@@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n" +
      "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nHost key verification failed.\n",
  });
  await assert.rejects(store.test(access.id), (error) => {
    assert.equal(error.status, 502);
    assert.equal(JSON.stringify(error).includes("ghp_"), false);
    return true;
  });
  const failed = lastTest(start(dataDir, run), access.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.hostKeyMismatch, true);
  assert.equal(failed.code, null);
  assert.equal(failed.detail, "Host key verification failed.");
  assert.equal(fs.readFileSync(resultsFile(dataDir), "utf8").includes("ghp_"), false);

  answer = Object.assign(new Error("Command failed"), {
    code: 255,
    stderr: "deploy@127.0.0.1: Permission denied (publickey,password=hunter2).\n",
  });
  await assert.rejects(store.test(access.id), { status: 502 });
  const denied = lastTest(store, access.id);
  assert.equal(denied.hostKeyMismatch, false);
  assert.equal(denied.detail.includes("hunter2"), false);

  answer = null;
  await store.test(access.id);
  assert.equal(lastTest(store, access.id).ok, true);
  // A host that is not there is no test result.
  await assert.rejects(store.test("0b8f9a52-3a4e-4c55-9d1e-2b1c8e2f6a10"), {
    status: 404,
  });
  assert.equal(
    Object.keys(JSON.parse(fs.readFileSync(resultsFile(dataDir), "utf8")).results).length,
    1,
  );
});

test("backups leave test results out and a restore starts untested", async (t) => {
  const { root, dataDir, sftp } = await setup(t);
  const store = start(dataDir);
  const host = await store.create(sftp("Webspace"));
  await store.test(host.id);
  assert.ok(fs.existsSync(resultsFile(dataDir)));
  for (const options of [
    { includeHistory: false },
    { includeHistory: false, withCredentials: true, passphrase },
  ]) {
    const made = await new Backup({ dataDir }).create(options);
    assert.equal(archiveText(made.file).includes("test-results"), false);
    if (!options.withCredentials) continue;
    const target = path.join(root, "restored");
    await new Restore({ dataDir }).apply({
      archive: made.file,
      targetDataDir: target,
      passphrase,
    });
    const restored = start(target);
    assert.deepEqual(
      restored.list().map((row) => row.id),
      [host.id],
    );
    assert.equal(lastTest(restored, host.id), null);
  }
});
