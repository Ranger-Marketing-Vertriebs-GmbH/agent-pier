import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../../server/features/secrets/secret-store.js";
import { SessionSecrets } from "../../server/features/secrets/session-secrets.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { SECRETS_FILE_ENV } from "../../server/features/secrets/secrets-hint.js";
import { SSH_HINT_ENV } from "../../server/features/ssh/ssh-hook.js";

const owner = { kind: "owner" };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-secrets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretStore({ dataDir });
  t.after(() => store.close());
  const records = [];
  const sessions = { list: async () => records.map((record) => ({ ...record })) };
  const sessionSecrets = new SessionSecrets({ dataDir, store, sessions });
  const launchIn = (projectId) => ({
    command: "/bin/sh",
    args: [],
    env: { KEEP: "1" },
    sshTools: { enabled: true, project: { projectId } },
  });
  const prepare = (input = {}) =>
    sessionSecrets.prepare({
      id: "session-one",
      account: { id: "account", tool: "claude" },
      cwd: dataDir,
      launch: launchIn("P"),
      ...input,
    });
  // The record the session manager keeps for a launched session.
  const launched = (launch, id = "session-one") => {
    const record = { id, tool: "claude", status: "running", secrets: launch.secrets };
    records.push(record);
    return record;
  };
  const read = (id = "session-one") => fs.readFileSync(sessionSecrets.file(id), "utf8");
  return { dataDir, store, records, sessionSecrets, prepare, launched, read, launchIn };
}

test("a claude session gets its project's and its assigned secrets as a file", async (t) => {
  const f = fixture(t);
  const projectSecret = f.store.create(
    { name: "ZABBIX_TOKEN", projectId: "P", value: "zbx-'$HOME" },
    owner,
  );
  const global = f.store.create({ name: "HA_TOKEN", value: "ha-secret" }, owner);
  f.store.create({ name: "OTHER", projectId: "Q", value: "other-secret" }, owner);
  f.store.create({ name: "UNASSIGNED", value: "unassigned-secret" }, owner);
  const launch = await f.prepare({ secretIds: [global.id] });
  const file = f.sessionSecrets.file("session-one");
  assert.equal(
    file,
    path.join(f.dataDir, "secrets", "sessions", "session-one", "secrets.env"),
  );
  assert.equal(launch.env[SECRETS_FILE_ENV], file);
  assert.equal(launch.env.KEEP, "1");
  assert.deepEqual(launch.secrets, { projectId: "P", assignedIds: [global.id] });
  assert.deepEqual(launch.sandboxGrants, [{ access: "read", path: path.dirname(file) }]);
  assert.equal(
    f.read(),
    "# Managed by AgentPier. Do not edit; changes are overwritten.\n" +
      "HA_TOKEN='ha-secret'\nZABBIX_TOKEN='zbx-'\\''$HOME'\n",
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const environment = JSON.stringify(launch.env);
  for (const value of ["zbx-", "ha-secret", "other-secret", "unassigned-secret"])
    assert.equal(environment.includes(value), false);
  assert.equal(JSON.stringify(launch).includes(projectSecret.id), false);
});

test("shell, codex and opencode sessions are eligible as well", async (t) => {
  const f = fixture(t);
  f.store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  for (const tool of ["shell", "codex", "opencode"]) {
    const launch = await f.prepare({ id: `s-${tool}`, account: { id: "a", tool } });
    assert.equal(launch.env[SECRETS_FILE_ENV], f.sessionSecrets.file(`s-${tool}`));
  }
});

test("login and headless pipeline sessions get no folder and no variable", async (t) => {
  const f = fixture(t);
  const global = f.store.create({ name: "GLOBAL", value: "g" }, owner);
  f.store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  for (const input of [
    { purpose: "login", secretIds: [global.id] },
    { headless: true, secretIds: [global.id] },
  ]) {
    const before = f.launchIn("P");
    const launch = await f.prepare({ ...input, launch: before });
    assert.equal(launch, before);
    assert.equal(
      fs.existsSync(path.dirname(f.sessionSecrets.file("session-one"))),
      false,
    );
  }
});

test("a session without secrets still gets its folder, variable, grant and binding", async (t) => {
  const f = fixture(t);
  const launch = await f.prepare({ launch: f.launchIn("EMPTY") });
  const file = f.sessionSecrets.file("session-one");
  assert.equal(launch.env[SECRETS_FILE_ENV], file);
  assert.deepEqual(launch.sandboxGrants, [{ access: "read", path: path.dirname(file) }]);
  assert.deepEqual(launch.secrets, { projectId: "EMPTY", assignedIds: [] });
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(file), false);
});

test("a secret added after launch reaches a session that started with none", async (t) => {
  const f = fixture(t);
  f.launched(await f.prepare({ launch: f.launchIn("EMPTY") }));
  f.store.create({ name: "LATE", projectId: "EMPTY", value: "late" }, owner);
  await f.sessionSecrets.syncAll();
  assert.match(f.read(), /^LATE='late'$/m);
});

test("a sandboxed CLI without SSH tools gets the start hook for the secrets hint", async (t) => {
  const f = fixture(t);
  for (const tool of ["claude", "codex", "opencode"]) {
    const id = `hint-${tool}`;
    const launch = await f.prepare({
      id,
      account: { id: "a", tool },
      launch: { command: "/bin/sh", args: [], env: {}, sshTools: undefined },
    });
    const folder = path.dirname(f.sessionSecrets.file(id));
    assert.equal(launch.env[SSH_HINT_ENV], "0", tool);
    assert.ok(launch.sandboxGrants.some((g) => g.path === process.execPath));
    if (tool === "claude") {
      const plugin = path.join(folder, "plugin");
      assert.deepEqual(launch.args, ["--plugin-dir", plugin]);
      const hooks = JSON.parse(
        fs.readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8"),
      );
      assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /ssh-hook\.js/);
      assert.ok(fs.existsSync(path.join(plugin, ".claude-plugin", "plugin.json")));
    } else if (tool === "codex")
      assert.ok(launch.args.some((arg) => arg.startsWith("hooks.SessionStart=")));
    else
      assert.match(
        JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).plugin[0],
        /ssh-opencode\.js$/,
      );
  }
  const ssh = await f.prepare({ id: "with-ssh" });
  assert.equal(ssh.env[SSH_HINT_ENV], undefined);
  assert.deepEqual(ssh.args, []);
  const shell = await f.prepare({
    id: "shell",
    account: { id: "local-shell", tool: "shell" },
    launch: { command: "/bin/sh", args: [], env: {}, sshTools: { enabled: false } },
  });
  assert.equal(shell.env[SSH_HINT_ENV], undefined);
  assert.deepEqual(shell.args, []);
});

test("a session without an SSH project binding resolves its project from the folder", async (t) => {
  const f = fixture(t);
  const { projectId } = await createSshProjectBinding(f.dataDir);
  f.store.create({ name: "TOKEN", projectId, value: "v" }, owner);
  const launch = await f.prepare({ launch: { command: "/bin/sh", args: [], env: {} } });
  assert.deepEqual(launch.secrets, { projectId, assignedIds: [] });
  assert.match(f.read(), /^TOKEN='v'$/m);
});

test("unknown or too many assigned secrets are refused", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.prepare({ secretIds: ["missing"] }), {
    status: 409,
    code: "SECRET_NOT_FOUND",
  });
  const many = Array.from({ length: 51 }, (_, i) => `id-${i}`);
  await assert.rejects(f.prepare({ secretIds: many }), { status: 400 });
  assert.throws(() => f.sessionSecrets.validate("x"), { status: 400 });
  assert.throws(() => f.sessionSecrets.validate(["a", "a"]), { status: 400 });
  assert.deepEqual(f.sessionSecrets.validate(undefined), []);
});

test("project secret changes reach the running session's file", async (t) => {
  const f = fixture(t);
  const first = f.store.create({ name: "A_TOKEN", projectId: "P", value: "one" }, owner);
  f.launched(await f.prepare());
  const added = f.store.create({ name: "B_TOKEN", projectId: "P", value: "two" }, owner);
  await f.sessionSecrets.syncAll();
  assert.match(f.read(), /^A_TOKEN='one'\nB_TOKEN='two'\n$/m);
  f.store.update(first.id, { value: "changed" }, owner);
  await f.sessionSecrets.syncAll();
  assert.match(f.read(), /^A_TOKEN='changed'$/m);
  f.store.remove(added.id, owner);
  await f.sessionSecrets.syncAll();
  assert.doesNotMatch(f.read(), /B_TOKEN/);
  f.store.remove(first.id, owner);
  await f.sessionSecrets.syncAll();
  assert.equal(fs.existsSync(f.sessionSecrets.file("session-one")), false);
});

test("a deleted assigned secret is skipped and the coalesced refresh follows changes", async (t) => {
  const f = fixture(t);
  const global = f.store.create({ name: "GLOBAL", value: "g" }, owner);
  f.store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  const record = f.launched(await f.prepare({ secretIds: [global.id] }));
  assert.deepEqual(f.sessionSecrets.assigned(record), [global.id]);
  f.store.remove(global.id, owner);
  assert.deepEqual(f.sessionSecrets.assigned(record), []);
  await Promise.all([f.sessionSecrets.refresh(), f.sessionSecrets.refresh()]);
  assert.equal(f.read().includes("GLOBAL"), false);
  assert.match(f.read(), /^TOKEN='v'$/m);
});

test("stopped, discarded and other sessions are never written", async (t) => {
  const f = fixture(t);
  const secret = f.store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  const record = f.launched(await f.prepare());
  f.records.push({ id: "plain", tool: "claude", status: "running" });
  record.status = "stopped";
  f.store.update(secret.id, { value: "w" }, owner);
  await f.sessionSecrets.syncAll();
  assert.match(f.read(), /^TOKEN='v'$/m);
  assert.equal(
    fs.existsSync(path.join(f.dataDir, "secrets", "sessions", "plain")),
    false,
  );
  record.status = "running";
  f.sessionSecrets.discard("session-one");
  assert.equal(fs.existsSync(path.dirname(f.sessionSecrets.file("session-one"))), false);
  await f.sessionSecrets.syncAll();
  assert.equal(fs.existsSync(path.dirname(f.sessionSecrets.file("session-one"))), false);
  assert.doesNotThrow(() => f.sessionSecrets.discard("../escape"));
});

test("a discard during a running sync never brings the folder back", async (t) => {
  const f = fixture(t);
  f.store.create({ name: "TOKEN", projectId: "P", value: "v" }, owner);
  f.launched(await f.prepare());
  const entries = f.store.projectEntries.bind(f.store);
  f.store.projectEntries = (projectId) => {
    // The session stops between the sync's start and its write.
    f.sessionSecrets.discard("session-one");
    return entries(projectId);
  };
  assert.equal(await f.sessionSecrets.syncAll(), undefined);
  assert.equal(fs.existsSync(path.dirname(f.sessionSecrets.file("session-one"))), false);
});

test("moving a project re-points its secrets to the new project", async (t) => {
  const f = fixture(t);
  f.store.create({ name: "TOKEN", projectId: "OLD", value: "v" }, owner);
  f.store.moveProject("OLD", "NEW");
  const launch = await f.prepare({ launch: f.launchIn("NEW") });
  assert.deepEqual(launch.secrets, { projectId: "NEW", assignedIds: [] });
  assert.match(f.read(), /^TOKEN='v'$/m);
});
