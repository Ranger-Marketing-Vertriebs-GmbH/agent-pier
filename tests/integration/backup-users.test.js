import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";
import { UserStore } from "../../server/features/users/user-store.js";
import { archiveText, loadArchive } from "../helpers/backup-archive.js";
import { applicationFixture } from "../helpers/application.js";

const passphrase = "users backup passphrase";
const anna = { username: "Anna", password: "temporary-user-password" };

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-bu-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "live");
  fs.mkdirSync(dataDir);
  const users = new UserStore({ dataDir });
  const user = await users.create({ ...anna, displayName: "Anna K" });
  users.setOwnerMayRead(user.id, true);
  const token = users.issue(await users.verify(anna));
  const stored = JSON.parse(fs.readFileSync(users.file, "utf8")).users[0];
  return { root, dataDir, user, token, stored };
}
async function restored(root, dataDir, made, options = {}) {
  const target = path.join(root, `restored-${made.backup.id}`);
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    ...options,
  });
  return { target, report };
}

test("a backup holds users without hashes in public members", async (t) => {
  const { dataDir, stored } = await setup(t);
  const backup = new Backup({ dataDir });
  assert.ok(backup.plan({}).components.includes("users"));
  assert.ok(
    backup
      .plan({ withCredentials: true })
      .components.includes("encrypted-user-passwords"),
  );
  for (const withCredentials of [false, true]) {
    const made = await backup.create({
      includeHistory: false,
      withCredentials,
      ...(withCredentials ? { passphrase } : {}),
    });
    const header = await readArchiveHeader(made.file);
    const names = header.members.map((member) => member.path);
    assert.ok(names.includes("users/users.json"), names.join(","));
    const text = archiveText(made.file);
    // The capsule is encrypted: neither value appears anywhere in the archive.
    for (const secret of [stored.salt, stored.hash])
      assert.equal(text.includes(secret), false, secret);
    const archived = loadArchive(made.file).files.find(
      (file) => file.path === "users/users.json",
    );
    const value = JSON.parse(Buffer.from(archived.content, "base64").toString("utf8"));
    assert.deepEqual(Object.keys(value).sort(), ["users", "version"]);
    assert.equal(/"(salt|hash)"/.test(JSON.stringify(value)), false);
    assert.equal(value.users[0].username, "Anna");
    assert.equal(value.users[0].ownerMayRead.enabled, true);
  }
});

test("a restore with credentials keeps passwords", async (t) => {
  const { root, dataDir, user } = await setup(t);
  const made = await new Backup({ dataDir }).create({
    includeHistory: false,
    withCredentials: true,
    passphrase,
  });
  const { target, report } = await restored(root, dataDir, made, { passphrase });
  assert.equal(
    report.credentialsNeedingLogin.some((item) => item.startsWith("user:")),
    false,
  );
  const users = new UserStore({ dataDir: target });
  const [back] = users.list();
  assert.equal(back.id, user.id);
  assert.equal(back.displayName, "Anna K");
  assert.equal(back.mustReset, undefined);
  assert.equal(back.ownerMayRead.enabled, true);
  assert.ok(await users.verify(anna));
});

test("a restore without credentials requires a reset", async (t) => {
  const { root, dataDir, user } = await setup(t);
  const made = await new Backup({ dataDir }).create({ includeHistory: false });
  const { target, report } = await restored(root, dataDir, made);
  assert.ok(report.credentialsNeedingLogin.includes(`user:${user.displayName}`));
  const users = new UserStore({ dataDir: target });
  assert.equal(users.get(user.id).mustReset, true);
  assert.equal(await users.verify(anna), null);
  const f = await applicationFixture(t, {
    prepareDataDir: async (data) => fs.cpSync(target, data, { recursive: true }),
  });
  const refused = await f.request("/auth/login", {
    method: "POST",
    body: anna,
    headers: { cookie: "" },
  });
  assert.equal(refused.status, 401);
  const listed = await (await f.request("/api/users")).json();
  assert.equal(listed[0].mustReset, true);
  const reset = await f.request(`/api/users/${user.id}/password`, {
    method: "POST",
    body: { password: anna.password },
  });
  assert.ok(reset.ok, String(reset.status));
  const login = await f.request("/auth/login", {
    method: "POST",
    body: anna,
    headers: { cookie: "" },
  });
  assert.equal(login.status, 200);
  const after = await (await f.request("/api/users")).json();
  assert.equal(after[0].mustReset, undefined);
});

test("user sessions are never backed up", async (t) => {
  const { root, dataDir, token } = await setup(t);
  const made = await new Backup({ dataDir }).create({
    includeHistory: true,
    withCredentials: true,
    passphrase,
  });
  const header = await readArchiveHeader(made.file);
  for (const member of header.members)
    assert.equal(/session/i.test(member.path) && member.path.startsWith("users/"), false);
  const { target } = await restored(root, dataDir, made, { passphrase });
  const file = JSON.parse(fs.readFileSync(path.join(target, "users/users.json"), "utf8"));
  assert.deepEqual(file.sessions, []);
  assert.equal(new UserStore({ dataDir: target }).session(token), null);
});
