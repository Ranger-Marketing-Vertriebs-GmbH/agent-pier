import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AccountStore,
  cleanEnvironment,
  detectTools,
} from "../../server/features/accounts/account-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

function setup(t, { uid = 501 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentpier-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new AccountStore({ dataDir: dir, home: dir, uid: () => uid }) };
}
test("profiles persist independently and public metadata never contains keys", async (t) => {
  const { dir, store } = setup(t);
  const a = store.create({ name: "Work", tool: "codex", apiKey: "secret-work" });
  const b = store.create({ name: "Personal", tool: "codex", apiKey: "secret-personal" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.hasSecret, true);
  assert.equal(JSON.stringify(store.list()).includes("secret-work"), false);
  const envA = store.environment(a.id),
    envB = store.environment(b.id);
  assert.notEqual(envA.CODEX_HOME, envB.CODEX_HOME);
  assert.equal(
    JSON.parse(readFileSync(path.join(envA.CODEX_HOME, "auth.json"))).OPENAI_API_KEY,
    "secret-work",
  );
  assert.equal(statSync(envA.CODEX_HOME).mode & 0o777, 0o700);
  assert.equal(new AccountStore({ dataDir: dir, home: dir }).get(a.id).name, "Work");
});
test("Claude config and macOS credential store use distinct managed namespaces", async (t) => {
  const { store, dir } = setup(t);
  const a = store.create({ tool: "claude", name: "A" }),
    b = store.create({ tool: "claude", name: "B" });
  const ea = store.environment(a.id),
    eb = store.environment(b.id);
  assert.equal(ea.CLAUDE_CONFIG_DIR, ea.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  assert.notEqual(ea.CLAUDE_SECURESTORAGE_CONFIG_DIR, eb.CLAUDE_SECURESTORAGE_CONFIG_DIR);
  assert.notEqual(ea.CLAUDE_CONFIG_DIR, path.join(dir, ".claude"));
  assert.equal(
    store.environment("local-claude").CLAUDE_SECURESTORAGE_CONFIG_DIR,
    undefined,
  );
});
test("OpenCode gets separate config, data, state and cache directories", (t) => {
  const { store } = setup(t);
  const a = store.create({ tool: "opencode", name: "One" }),
    b = store.create({ tool: "opencode", name: "Two" });
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    assert.notEqual(store.environment(a.id)[key], store.environment(b.id)[key]);
});
test("child environment drops parent account overrides and credentials", async () => {
  const env = cleanEnvironment({
    PATH: "/bin",
    HOME: "/home/example",
    LANG: "de_DE.UTF-8",
    OPENAI_API_KEY: "oops",
    ANTHROPIC_API_KEY: "oops",
    CLAUDE_CODE_OAUTH_TOKEN: "oops",
    CODEX_HOME: "/wrong",
    CLAUDE_CONFIG_DIR: "/wrong",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
    CLAUDECODE: "1",
    AWS_ACCESS_KEY_ID: "oops",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/example");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
});
test("profile validation and local account protections preserve existing profiles", async (t) => {
  const { store } = setup(t);
  assert.throws(() => store.create({ name: "", tool: "codex" }));
  assert.throws(() => store.create({ name: "X", tool: "shell" }));
  assert.throws(() => store.get("../outside"));
  assert.throws(() => store.remove("local-codex"));
  await assert.rejects(async () =>
    store.command("local-codex", { codex: "/bin/echo" }, true),
  );
  const a = store.create({ name: "Old", tool: "codex" });
  store.update(a.id, { name: "New" });
  assert.equal(store.get(a.id).name, "New");
  store.remove(a.id);
  assert.throws(() => store.get(a.id));
});
const CODEX_STORES = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'mcp_oauth_credentials_store="file"',
];
test("command builder uses installed binary and native login without permission bypass", async (t) => {
  const { store } = setup(t);
  const a = store.create({ name: "A", tool: "codex" });
  const b = store.create({ name: "B", tool: "claude" });
  assert.deepEqual((await store.command(a.id, { codex: "/opt/codex" }, true)).args, [
    "login",
    "--device-auth",
    ...CODEX_STORES,
  ]);
  assert.deepEqual((await store.command(b.id, { claude: "/opt/claude" }, true)).args, []);
  await assert.rejects(async () => store.command(a.id, {}));
  assert.equal(
    (await store.command(a.id, { codex: "/opt/codex" })).args.includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
    false,
  );
});
test("session launch defaults preserve native args and permission environment", async (t) => {
  const { store } = setup(t);
  for (const tool of ["codex", "claude", "opencode"]) {
    const native = await store.command(`local-${tool}`, { [tool]: `/opt/${tool}` });
    assert.deepEqual(native.args, []);
    assert.equal(native.launchMode, "default");
    assert.equal(native.env.OPENCODE_PERMISSION, undefined);
    assert.deepEqual(
      await store.command(`local-${tool}`, { [tool]: `/opt/${tool}` }, false, "default"),
      native,
    );
  }
});
test("explicit launch modes use each native CLI flag and leave profile settings unchanged", async (t) => {
  const { store, dir } = setup(t);
  for (const { tool, mode, args } of [
    { tool: "codex", mode: "yolo", args: ["--yolo", ...CODEX_STORES] },
    { tool: "claude", mode: "auto", args: ["--permission-mode", "auto"] },
    { tool: "claude", mode: "bypass", args: ["--dangerously-skip-permissions"] },
    { tool: "opencode", mode: "auto", args: ["--auto"] },
  ]) {
    const account = store.create({ tool, name: tool });
    const before = readFileSync(path.join(dir, "accounts.json"), "utf8");
    const launch = await store.command(
      account.id,
      { [tool]: `/opt/${tool}` },
      false,
      mode,
    );
    assert.equal(launch.command, `/opt/${tool}`);
    assert.deepEqual(launch.args, args);
    assert.equal(launch.launchMode, mode);
    assert.deepEqual(launch.env, store.environment(account.id));
    assert.equal(readFileSync(path.join(dir, "accounts.json"), "utf8"), before);
    assert.deepEqual(
      (await store.command(account.id, { [tool]: `/opt/${tool}` })).args,
      tool === "codex" ? CODEX_STORES : [],
    );
  }
});
test("launch mode validation rejects malformed values and modes from another tool", async (t) => {
  const { store } = setup(t);
  for (const tool of ["codex", "claude", "opencode"]) {
    for (const mode of [
      null,
      {},
      [],
      true,
      1,
      "",
      "default ",
      "--yolo",
      "auto; echo injected",
      "constructor",
      "toString",
      "__proto__",
      tool === "codex" ? "auto" : "yolo",
      ...(tool === "claude" ? ["--dangerously-skip-permissions"] : ["bypass"]),
    ])
      await assert.rejects(
        async () =>
          store.command(`local-${tool}`, { [tool]: `/opt/${tool}` }, false, mode),
        (error) => error.status === 400,
      );
  }
});
test("login commands reject selected launch modes without adding permission flags", async (t) => {
  const { store } = setup(t);
  for (const { tool, mode, args } of [
    { tool: "codex", mode: "yolo", args: ["login", "--device-auth", ...CODEX_STORES] },
    { tool: "claude", mode: "auto", args: [] },
    { tool: "claude", mode: "bypass", args: [] },
    { tool: "opencode", mode: "auto", args: ["auth", "login"] },
  ]) {
    const account = store.create({ tool, name: tool });
    await assert.rejects(
      async () => store.command(account.id, { [tool]: `/opt/${tool}` }, true, mode),
      (error) => error.status === 400,
    );
    const login = await store.command(account.id, { [tool]: `/opt/${tool}` }, true);
    assert.deepEqual(login.args, args);
    assert.equal(login.launchMode, "default");
    assert.equal(login.env.OPENCODE_PERMISSION, undefined);
  }
});
test("skip-permissions mode is refused with a stable message when AgentPier runs as root", async (t) => {
  const { store } = setup(t, { uid: 0 });
  const account = store.create({ tool: "claude", name: "Root" });
  for (const id of ["local-claude", account.id])
    await assert.rejects(
      async () => store.command(id, { claude: "/opt/claude" }, false, "bypass"),
      (error) =>
        error.status === 409 &&
        error.message === serverMessages.accounts.skipPermissionsAsRoot,
    );
  assert.deepEqual(
    (await store.command(account.id, { claude: "/opt/claude" }, false, "auto")).args,
    ["--permission-mode", "auto"],
  );
});
test("skip-permissions root guard reads the process uid when none is injected", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentpier-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AccountStore({ dataDir: dir, home: dir });
  const run = () =>
    store.command("local-claude", { claude: "/opt/claude" }, false, "bypass");
  if (process.getuid?.() === 0)
    await assert.rejects(run, (error) => error.status === 409);
  else assert.deepEqual((await run()).args, ["--dangerously-skip-permissions"]);
});
test("tool detection marks absent executables instead of inventing commands", async () => {
  const result = detectTools({ PATH: "/nonexistent", HOME: "/nonexistent" }, false);
  assert.equal(result.length, 4);
  assert.equal(
    result.filter((t) => t.id !== "shell").every((t) => !t.installed && t.path === null),
    true,
  );
});
test("API-key profiles cannot enter a conflicting OAuth login flow", async (t) => {
  const { store } = setup(t);
  const a = store.create({ tool: "claude", name: "API", apiKey: "secret" });
  await assert.rejects(
    async () => store.command(a.id, { claude: "/opt/claude" }, true),
    /API-Key/,
  );
});
test("replacing saved API key updates the provider auth file without exposing it", async (t) => {
  const { store } = setup(t);
  const a = store.create({ tool: "codex", name: "A", apiKey: "old-key" });
  store.update(a.id, { name: "A new", apiKey: "new-key" });
  assert.equal(store.environment(a.id).OPENAI_API_KEY, "new-key");
  assert.equal(
    JSON.parse(readFileSync(path.join(store.environment(a.id).CODEX_HOME, "auth.json")))
      .OPENAI_API_KEY,
    "new-key",
  );
  store.update(a.id, { name: "A new", apiKey: "" });
  assert.equal(store.environment(a.id).OPENAI_API_KEY, "new-key");
  assert.equal(JSON.stringify(store.list()).includes("new-key"), false);
});
