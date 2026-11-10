import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AccountAuthStatus } from "../../server/features/accounts/auth-status.js";
import {
  ManagedLogins,
  managedLogins,
} from "../../server/features/accounts/managed-logins.js";
import { serviceName } from "../../server/features/clis/claude/login-store.js";
import { NonoSandbox } from "../../server/features/nono/nono-launch.js";
import { refuseKeychain } from "../helpers/application.js";

const login = JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 5 } });

/** A keychain holding items by service name; `real` is where the stand-in forwards to. */
function setup(t, { platform = "darwin", items = {}, running = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-managed-logins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ dataDir: dir, home: dir });
  const calls = [];
  const log = path.join(dir, "real-security.log");
  const real = path.join(dir, "real-security");
  fs.writeFileSync(real, `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`, { mode: 0o700 });
  store.logins = new ManagedLogins({
    dataDir: dir,
    platform,
    user: "me",
    security: real,
    running: async (id) => running(id),
    run: async (args) => {
      calls.push(args);
      const service = args.at(-1);
      if (args[0] === "find-generic-password")
        return service in items
          ? { code: 0, stdout: `${items[service]}\n` }
          : { code: 44, stdout: "" };
      const found = service in items;
      delete items[service];
      return { code: found ? 0 : 44, stdout: "" };
    },
  });
  const service = (id) => serviceName(path.join(store.profile(id), "claude"));
  const realCalls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { dir, store, calls, items, service, realCalls };
}
/** An account as an AgentPier without the file store created it. */
function legacyAccount(store, name) {
  const logins = store.logins;
  store.logins = null;
  try {
    return store.create({ tool: "claude", name });
  } finally {
    store.logins = logins;
  }
}
const shimDirectory = (dir) => path.join(dir, "login-shims", "claude");
const first = (env) => env.PATH.split(path.delimiter)[0];
const credentials = (store, id) =>
  path.join(store.profile(id), "claude", ".credentials.json");

test("a managed Claude account's sign-in and sessions run with the stand-in first on PATH", async (t) => {
  const { dir, store } = setup(t);
  const account = store.create({ tool: "claude", name: "Work" });
  for (const signIn of [true, false]) {
    const launch = await store.command(account.id, { claude: "/opt/claude" }, signIn);
    assert.equal(first(launch.env), shimDirectory(dir), `sign-in ${signIn}`);
    assert.deepEqual(
      launch.sandboxGrants.filter((grant) => grant.path === shimDirectory(dir)),
      [{ access: "read", path: shimDirectory(dir) }],
    );
  }
  // Status probes, history, plugins and every other process read this environment.
  assert.equal(first(store.environment(account.id)), shimDirectory(dir));
  const shim = path.join(shimDirectory(dir), "security");
  assert.equal(fs.statSync(shim).mode & 0o100, 0o100);
});

test("the existing keychain login of an idle account moves before its next launch", async (t) => {
  const { dir, store, items, service } = setup(t);
  const account = legacyAccount(store, "Old");
  items[service(account.id)] = login;
  assert.notEqual(first(store.environment(account.id)), shimDirectory(dir));
  const launch = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(first(launch.env), shimDirectory(dir));
  assert.equal(fs.readFileSync(credentials(store, account.id), "utf8"), login);
  assert.equal(fs.statSync(credentials(store, account.id)).mode & 0o777, 0o600);
  assert.deepEqual(items, {}, "the keychain item is gone");
});

test("an account with running sessions keeps the keychain for every new process", async (t) => {
  let busy = true;
  const { dir, store, items, service } = setup(t, { running: () => busy });
  const account = store.create({ tool: "claude", name: "Busy" });
  await store.settleLogin(account.id);
  items[service(account.id)] = login;
  const legacy = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(legacy.env.PATH.includes(shimDirectory(dir)), false);
  assert.equal(
    legacy.sandboxGrants.some((grant) => grant.path === shimDirectory(dir)),
    false,
  );
  assert.equal(fs.existsSync(credentials(store, account.id)), false);
  assert.deepEqual(store.hiddenLogins()[account.id], "pending");
  busy = false;
  const moved = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(first(moved.env), shimDirectory(dir));
  assert.equal(store.hiddenLogins()[account.id], undefined);
});

test("a process started with the account's environment never reaches the keychain for the login", async (t) => {
  const { store, service, realCalls } = setup(t);
  const account = store.create({ tool: "claude", name: "Probe" });
  await store.settleLogin(account.id);
  // Stands for `claude auth status`: looks its login up the way Claude Code does.
  const cli = path.join(store.dataDir, "claude");
  fs.writeFileSync(
    cli,
    [
      "#!/bin/sh",
      `security find-generic-password -a "$USER" -w -s "${service(account.id)}" 2>/dev/null`,
      'code=$?; security find-generic-password -s "other" >/dev/null',
      'if [ "$code" = 44 ] && [ -s "$CLAUDE_CONFIG_DIR/.credentials.json" ]',
      "then echo '{\"loggedIn\":true}'; else echo '{\"loggedIn\":false}'; fi",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(credentials(store, account.id), login, { mode: 0o600 });
  const status = new AccountAuthStatus({
    accounts: store,
    tools: () => [{ id: "claude", installed: true, path: cli }],
    home: store.dataDir,
  });
  t.after(() => status.close());
  assert.equal((await status.get(account.id)).state, "authenticated");
  assert.equal(realCalls(), "find-generic-password -s other\n");
});

test("local accounts, other CLIs and other platforms keep their environment", async (t) => {
  const { dir, store, calls } = setup(t);
  const codex = store.create({ tool: "codex", name: "Codex" });
  for (const id of ["local-claude", "local-shell", codex.id]) {
    const tool = store.get(id).tool;
    const launch = await store.command(id, {
      [tool]: tool === "shell" ? "/bin/sh" : "/opt/x",
    });
    assert.equal(launch.env.PATH.includes("login-shims"), false, id);
  }
  assert.deepEqual(calls, [], "no keychain call for them");
  assert.equal(fs.existsSync(path.join(dir, "login-shims")), false);

  const linux = setup(t, { platform: "linux" });
  const account = linux.store.create({ tool: "claude", name: "Linux" });
  const launch = await linux.store.command(account.id, { claude: "/opt/claude" });
  assert.equal(launch.env.PATH.includes("login-shims"), false);
  assert.deepEqual(linux.calls, []);
  assert.deepEqual(linux.store.hiddenLogins(), {});
});

test("an account store without managed logins behaves as before", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-managed-logins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ dataDir: dir, home: dir });
  const account = store.create({ tool: "claude", name: "Plain" });
  const launch = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(launch.env.PATH.includes("login-shims"), false);
  assert.deepEqual(store.hiddenLogins(), {});
  await store.settleLogins();
  store.remove(account.id);
});

test("removing an account deletes its folder and its keychain item", async (t) => {
  const { store, items, service, calls } = setup(t);
  const account = store.create({ tool: "claude", name: "Gone" });
  await store.settleLogin(account.id);
  const name = service(account.id);
  const folder = store.profile(account.id);
  // A leftover an older version or a manual run may have written.
  items[name] = login;
  calls.length = 0;
  store.remove(account.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["delete-generic-password", "-a", "me", "-s", name]]);
  assert.deepEqual(items, {});
  assert.equal(fs.existsSync(folder), false);
});

test("renaming an account keeps its folder, so its login stays where it is", async (t) => {
  const { dir, store } = setup(t);
  const account = store.create({ tool: "claude", name: "Before" });
  await store.settleLogin(account.id);
  fs.writeFileSync(credentials(store, account.id), login, { mode: 0o600 });
  const before = store.environment(account.id);
  store.update(account.id, { name: "After" });
  const after = store.environment(account.id);
  assert.equal(
    after.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    before.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  );
  assert.equal(first(after), shimDirectory(dir));
  assert.equal(fs.readFileSync(credentials(store, account.id), "utf8"), login);
});

test("startup settles every idle managed account and skips the busy ones", async (t) => {
  const busy = new Set();
  const { store, items, service } = setup(t, { running: (id) => busy.has(id) });
  const idle = legacyAccount(store, "Idle");
  const running = legacyAccount(store, "Running");
  busy.add(running.id);
  items[service(idle.id)] = login;
  items[service(running.id)] = login;
  await store.settleLogins();
  assert.deepEqual(Object.keys(items), [service(running.id)]);
  assert.equal(fs.readFileSync(credentials(store, idle.id), "utf8"), login);
  assert.equal(fs.existsSync(credentials(store, running.id)), false);
});

test("the launch dialog learns which logins a sandbox cannot read", async (t) => {
  const { dir, store } = setup(t);
  const settled = store.create({ tool: "claude", name: "Settled" });
  await store.settleLogin(settled.id);
  const withKey = store.create({ tool: "claude", name: "Key", apiKey: "sk-test" });
  assert.deepEqual(store.hiddenLogins(), { "local-claude": "local" });
  assert.equal(store.hiddenLogins()[withKey.id], undefined);
  // The CLI's own profile with a login file can be read inside a sandbox.
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), login);
  assert.deepEqual(store.hiddenLogins(), {});
});

test("a sandboxed session of a settled account may read and run the stand-in", async (t) => {
  const { dir, store } = setup(t);
  const account = store.create({ tool: "claude", name: "Boxed" });
  const launch = await store.command(account.id, { claude: "/opt/claude" });
  const sandbox = new NonoSandbox({
    detect: () => [{ id: "nono", installed: true, path: "/bin/nono" }],
    readProfiles: async () => ["dev"],
    prepareCli: (_tool, prepared) => prepared,
  });
  const wrapped = await sandbox.prepare({ launch, profile: "dev", tool: "claude" });
  const index = wrapped.args.indexOf(shimDirectory(dir));
  assert.equal(wrapped.args[index - 1], "--read");
  assert.equal(first(wrapped.env), shimDirectory(dir));
});

test("the application's instance reads the keychain through the configured runner", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-managed-logins-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = { list: async () => [{ accountId: "a", status: "running" }] };
  const logins = managedLogins(
    { dataDir: dir, keychainRun: refuseKeychain },
    () => sessions,
  );
  assert.equal(logins.run, refuseKeychain);
  assert.equal(await logins.running("a"), true);
  assert.equal(await logins.running("b"), false);
  // A fixture's refusing runner leaves accounts on the CLI's own store.
  logins.platform = "darwin";
  const store = new AccountStore({ dataDir: dir, home: dir });
  store.logins = logins;
  const account = store.create({ tool: "claude", name: "Fixture" });
  const launch = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(launch.env.PATH.includes("login-shims"), false);
});
