import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { PluginStore } from "../../server/features/plugins/plugin-store.js";

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-plugins-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home });
  const calls = [];
  const run = async (command, args, opts) => {
    calls.push({ command, args, ...opts });
    if (args.includes("--help"))
      return "Commands: plugin <module> install plugin and update config";
    if (args.includes("marketplace") && args.includes("list"))
      return JSON.stringify(
        command === "claude"
          ? [{ name: "fixture", source: "github", repo: "example/plugins" }]
          : {
              marketplaces: [
                {
                  name: "fixture",
                  marketplaceSource: {
                    sourceType: "git",
                    source: "https://github.com/example/plugins",
                  },
                },
              ],
            },
      );
    if (args.includes("list"))
      return JSON.stringify(
        command === "claude"
          ? {
              installed: [
                { id: "demo@fixture", version: "1.2", scope: "user", enabled: true },
              ],
              available: [
                {
                  pluginId: "other@fixture",
                  name: "other",
                  marketplaceName: "fixture",
                  description: "Catalog description",
                },
              ],
            }
          : {
              installed: [
                {
                  pluginId: "demo@fixture",
                  name: "demo",
                  marketplaceName: "fixture",
                  version: "1.2",
                  installed: true,
                  enabled: true,
                },
              ],
              available: [
                { pluginId: "other@fixture", name: "other", marketplaceName: "fixture" },
              ],
            },
      );
    return "{}";
  };
  const store = new PluginStore({
    accounts,
    home,
    resolveTool: (tool) => tool,
    run,
    ...options,
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, accounts, store, calls };
}

for (const tool of ["codex", "claude"])
  test(`${tool} lists native catalog and mutates only the selected profile with fixed arguments`, async (t) => {
    const { accounts, store, calls } = setup(t);
    const account = accounts.create({ name: "Fixture", tool });
    const list = await store.list(account.id);
    assert.equal(list.available, true);
    assert.equal(list.installed[0].id, "demo@fixture");
    assert.equal(list.catalog[0].id, "other@fixture");
    assert.equal(
      list.marketplaces[0].source,
      tool === "claude" ? "example/plugins" : "https://github.com/example/plugins",
    );
    assert.equal(list.capabilities.enable, tool === "claude");
    await store.mutate(account.id, { action: "install", pluginId: "other@fixture" });
    assert.deepEqual(
      calls.at(-1).args,
      tool === "codex"
        ? ["plugin", "add", "other@fixture", "--json"]
        : ["plugin", "install", "other@fixture", "--scope", "user"],
    );
    assert.equal(calls.at(-1).cwd, accounts.profile(account.id));
    assert.equal(
      calls.at(-1).env[tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"],
      path.join(accounts.profile(account.id), tool),
    );
    await store.mutate(account.id, { action: "remove", pluginId: "demo@fixture" });
    assert.deepEqual(
      calls.at(-1).args,
      tool === "codex"
        ? ["plugin", "remove", "demo@fixture", "--json"]
        : ["plugin", "uninstall", "demo@fixture", "--scope", "user", "--keep-data"],
    );
  });

test("marketplace operations reject flags, credentials, private addresses and unlisted selectors", async (t) => {
  const { store, calls } = setup(t);
  for (const source of [
    "--help",
    "/tmp/plugins",
    "git@github.com:owner/repo",
    "https://user:secret@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "https://127.0.0.1/repo",
    "https://192.168.1.2/repo",
    "https://localhost/repo",
    "https://[::1]/repo",
    "https://example.local/repo",
  ])
    await assert.rejects(
      store.mutate("local-codex", { action: "marketplace-add", source }),
      { status: 400 },
    );
  assert.equal(calls.length, 0);
  await store.mutate("local-codex", {
    action: "marketplace-add",
    source: "example/plugins",
  });
  assert.deepEqual(calls.at(-1).args, [
    "plugin",
    "marketplace",
    "add",
    "example/plugins",
    "--json",
  ]);
  await assert.rejects(
    store.mutate("local-claude", { action: "remove", pluginId: "unknown@fixture" }),
    { status: 404 },
  );
  await assert.rejects(
    store.mutate("local-codex", { action: "enable", pluginId: "demo@fixture" }),
    { status: 409 },
  );
  await store.mutate("local-claude", {
    action: "marketplace-remove",
    marketplace: "fixture",
  });
  assert.deepEqual(calls.at(-1).args, [
    "plugin",
    "marketplace",
    "remove",
    "fixture",
    "--scope",
    "user",
  ]);
});

test("OpenCode combines npm, tuple and TUI entries; removal preserves comments, options and local plugins", async (t) => {
  const { store, home, calls } = setup(t);
  const dir = path.join(home, ".config/opencode");
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugins/local.ts"), "export default ()=>({});");
  const server =
    '{// keep server comment\n "theme":"keep", "plugin":[["@fixture/demo@1.2.3",{"token":"private-option"}],"file:///local.js","other-plugin"]}\n';
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), server);
  fs.writeFileSync(
    path.join(dir, "tui.json"),
    ' {"plugin":["@fixture/demo@1.2.3"],"theme":"keep-tui"}\n',
  );
  const list = await store.list("local-opencode");
  assert.equal(list.capabilities.marketplaces, false);
  assert.equal(list.capabilities.install, true);
  assert.equal(list.installed.find((x) => x.name === "@fixture/demo").version, "1.2.3");
  assert.equal(list.installed.filter((x) => x.removable === false).length, 2);
  assert.equal(JSON.stringify(list).includes("private-option"), false);
  await store.mutate("local-opencode", {
    action: "remove",
    pluginId: "@fixture/demo@1.2.3",
  });
  const after = fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8");
  assert.match(after, /keep server comment/);
  assert.equal(parse(after).theme, "keep");
  assert.deepEqual(parse(after).plugin, ["file:///local.js", "other-plugin"]);
  assert.deepEqual(parse(fs.readFileSync(path.join(dir, "tui.json"), "utf8")).plugin, []);
  await store.mutate("local-opencode", {
    action: "install",
    source: "@fixture/demo@next",
  });
  assert.deepEqual(calls.at(-1).args, ["plugin", "@fixture/demo@next", "--global"]);
  for (const source of [
    "--help",
    "file:///tmp/plugin",
    "https://github.com/x/y",
    "pkg;touch x",
    "../plugin",
  ])
    await assert.rejects(store.mutate("local-opencode", { action: "install", source }), {
      status: 400,
    });
});

test("OpenCode removal refuses invalid, duplicate-key and symlinked configuration without edits", async (t) => {
  const { store, home, root } = setup(t);
  const dir = path.join(home, ".config/opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.jsonc");
  for (const text of ['{"plugin":["demo"],', '{"plugin":["demo"],"plugin":[]}']) {
    fs.writeFileSync(file, text);
    await assert.rejects(
      store.mutate("local-opencode", { action: "remove", pluginId: "demo" }),
      { status: 409 },
    );
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  fs.rmSync(file);
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, '{"plugin":["demo"]}');
  fs.symlinkSync(outside, file);
  await assert.rejects(
    store.mutate("local-opencode", { action: "remove", pluginId: "demo" }),
    { status: 409 },
  );
  assert.equal(fs.readFileSync(outside, "utf8"), '{"plugin":["demo"]}');
});

test("per-profile mutation lock exposes busy and rejects duplicates, releases after failure", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  const { store } = setup(t, {
    run: async (_command, args) => {
      if (args.includes("list"))
        return args.includes("marketplace") ? "[]" : '{"installed":[],"available":[]}';
      mutations++;
      await gate;
      throw new Error("fixture failed");
    },
  });
  const operation = store.mutate("local-claude", {
    action: "marketplace-add",
    source: "example/plugins",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.list("local-claude")).busy, true);
  await assert.rejects(
    store.mutate("local-claude", {
      action: "marketplace-add",
      source: "example/plugins",
    }),
    { status: 409 },
  );
  release();
  await assert.rejects(operation, /fixture failed/);
  assert.equal(mutations, 1);
  assert.equal((await store.list("local-claude")).busy, false);
});

test("missing executable and unsupported OpenCode versions return truthful capability state", async (t) => {
  const { store } = setup(t, { resolveTool: () => null });
  const missing = await store.list("local-codex");
  assert.equal(missing.available, false);
  assert.deepEqual(missing.installed, []);
  assert.equal(missing.capabilities.install, false);
  await assert.rejects(
    store.mutate("local-codex", { action: "marketplace-add", source: "example/plugins" }),
    { status: 409 },
  );
  const old = setup(t, { run: async () => "Usage: opencode [project]" });
  const listed = await old.store.list("local-opencode");
  assert.equal(listed.capabilities.install, false);
});

test("all managed environment roots are checked before profile initialization can follow links", async (t) => {
  const { store, accounts, root } = setup(t);
  const account = accounts.create({ name: "Fixture", tool: "opencode" });
  const outside = path.join(root, "external");
  fs.mkdirSync(outside, { mode: 0o755 });
  const data = path.join(accounts.profile(account.id), "data");
  fs.rmSync(data, { recursive: true });
  fs.symlinkSync(outside, data);
  await assert.rejects(store.list(account.id), { status: 409 });
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
});

test("native subprocess errors redact profile secrets and URL credentials", async (t) => {
  const { root, accounts, store } = setup(t, {
    run: undefined,
    resolveTool: () => path.join(root, "fake-cli"),
  });
  const account = accounts.create({
    name: "Fixture",
    tool: "claude",
    apiKey: "fixture-private-api-key",
  });
  fs.writeFileSync(
    path.join(root, "fake-cli"),
    `#!${process.execPath}\nprocess.stderr.write('failed '+process.env.ANTHROPIC_API_KEY+' https://user:private-pass@example.com/path?token=private-query');process.exit(1);`,
    { mode: 0o700 },
  );
  const result = await store.list(account.id);
  assert.equal(result.available, false);
  assert.equal(JSON.stringify(result).includes("private-"), false);
  assert.match(result.reason, /verborgen/);
});

test("native subprocess output limits and timeouts release the profile lock", async (t) => {
  const { root, store } = setup(t, {
    run: undefined,
    resolveTool: () => path.join(root, "fake-cli"),
    listTimeout: 2000,
  });
  const file = path.join(root, "fake-cli");
  fs.writeFileSync(
    file,
    `#!${process.execPath}\nprocess.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  await assert.rejects(store.list("local-codex"), /zu viele Daten/);
  assert.equal(store.isBusy("local-codex"), false);
  store.listTimeout = 150;
  fs.writeFileSync(file, `#!${process.execPath}\nsetInterval(()=>{},1000);`, {
    mode: 0o700,
  });
  await assert.rejects(store.list("local-codex"), /Zeitlimit/);
  assert.equal(store.isBusy("local-codex"), false);
});

test("close terminates the full native process group including a child that ignores SIGTERM", async (t) => {
  const { root, store } = setup(t, {
    run: undefined,
    resolveTool: () => path.join(root, "fake-cli"),
    listTimeout: 5000,
  });
  const ready = path.join(root, "ready");
  const childPid = path.join(root, "child-pid");
  fs.writeFileSync(
    path.join(root, "fake-cli"),
    `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});require("node:fs").writeFileSync('+JSON.stringify(${JSON.stringify(ready)})+',"ready");setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childPid)},String(child.pid));setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const operation = store.list("local-codex");
  const failed = assert.rejects(operation, /Beenden/);
  for (let index = 0; index < 100 && !fs.existsSync(ready); index++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true);
  const pid = Number(fs.readFileSync(childPid, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  await store.close();
  await failed;
  for (let index = 0; index < 100; index++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      break;
    }
  }
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(store.list("local-codex"), { status: 503 });
});

test("read-only external OpenCode specs never expose embedded credentials", async (t) => {
  const { store, home } = setup(t);
  const directory = path.join(home, ".config/opencode");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      plugin: [
        "git+https://fixture-private-token@github.com/example/plugin.git",
        "https://example.com/plugin?token=private-query",
      ],
    }),
  );
  const list = await store.list("local-opencode");
  assert.equal(list.installed.length, 2);
  assert.equal(JSON.stringify(list).includes("private-"), false);
  assert.ok(
    list.installed.every(
      (item) => item.id.startsWith("external:") && item.removable === false,
    ),
  );
});

test("OpenCode capability detection reads successful help emitted on stderr", async (t) => {
  const { root, store } = setup(t, {
    run: undefined,
    resolveTool: () => path.join(root, "fake-cli"),
  });
  fs.writeFileSync(
    path.join(root, "fake-cli"),
    `#!${process.execPath}\nif(process.argv[2]!=='--help')process.exit(99);process.stderr.write('Commands:\\n  opencode plugin <module>     install plugin and update config [aliases: plug]\\n');`,
    { mode: 0o700 },
  );
  const result = await store.list("local-opencode");
  assert.equal(result.available, true);
  assert.equal(result.capabilities.install, true);
  assert.equal(result.reason, null);
});
