import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} accounts share extension management while credentials remain scoped`, async (t) => {
    const f = await applicationFixture(t);
    const a = f.application.accounts.create({ name: "A", tool });
    const b = f.application.accounts.create({ name: "B", tool });
    const endpoint = (id) => `/api/accounts/${id}/extensions`;
    assert.equal(
      (
        await f.request(endpoint(a.id) + "/mcp", {
          method: "POST",
          body: {
            name: "fixture",
            transport: "stdio",
            command: "fixture-mcp",
            args: [],
            env: { FIXTURE_TOKEN: "shared-mcp-only" },
          },
        })
      ).status,
      201,
    );
    const inventory = await (await f.request(endpoint(b.id))).json();
    assert.equal(inventory.mcp.servers[0].name, "fixture");
    assert.ok(!JSON.stringify(inventory).includes("shared-mcp-only"));
    assert.equal(
      (await (await f.request(endpoint(`local-${tool}`))).json()).mcp.servers.length,
      1,
    );
    for (const other of ["codex", "claude", "opencode"].filter((id) => id !== tool))
      assert.equal(
        (await (await f.request(endpoint(`local-${other}`))).json()).mcp.servers.length,
        0,
      );
    const envA = f.application.accounts.environment(a.id),
      envB = f.application.accounts.environment(b.id);
    const key =
      tool === "codex"
        ? "CODEX_HOME"
        : tool === "claude"
          ? "CLAUDE_CONFIG_DIR"
          : "XDG_DATA_HOME";
    assert.notEqual(envA[key], envB[key]);
    const skill = await f.request(endpoint(a.id) + "/skills", {
      method: "POST",
      body: {
        fileName: "SKILL.md",
        contentBase64: Buffer.from(
          "---\nname: shared-fixture\ndescription: Fixture skill\n---\nUse a temporary project.\n",
        ).toString("base64"),
      },
    });
    assert.equal(skill.status, 201);
    assert.ok(
      (await (await f.request(endpoint(b.id))).json()).skills.items.some(
        (entry) => entry.name === "shared-fixture",
      ),
    );
    const cwd = path.join(f.home, "project");
    fs.mkdirSync(cwd);
    const launches = [];
    f.application.sessions.create = async (body) => {
      launches.push(body);
      return { ...body, status: "running" };
    };
    f.application.accounts.command = (id) => ({
      command: process.execPath,
      args: [],
      env: f.application.accounts.environment(id),
    });
    await f.request("/api/sessions", {
      method: "POST",
      body: { accountId: b.id, cwd, agentbus: false },
    });
    assert.equal(launches.length, 1);
    const root =
      tool === "codex"
        ? envB.CODEX_HOME
        : tool === "claude"
          ? envB.CLAUDE_CONFIG_DIR
          : path.join(envB.XDG_CONFIG_HOME, "opencode");
    assert.ok(fs.existsSync(path.join(root, "skills/shared-fixture/SKILL.md")));
    f.application.accounts.remove(a.id);
    assert.ok(
      (await (await f.request(endpoint(b.id))).json()).skills.items.some(
        (entry) => entry.name === "shared-fixture",
      ),
    );
  });

test("Claude migration merges distinct extensions, preserves conflicting originals and never shares OAuth metadata", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const account = accounts.create({ name: "Legacy", tool: "claude" });
  const root = accounts.environment(account.id).CLAUDE_CONFIG_DIR;
  fs.writeFileSync(
    path.join(f.home, ".claude.json"),
    JSON.stringify({
      mcpServers: { same: { command: "shared-command", env: { SHARED: "one" } } },
      oauthAccount: { fixture: "host-auth" },
    }),
  );
  fs.writeFileSync(
    path.join(root, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        same: { command: "legacy-command", env: { PRIVATE: "two" } },
        legacy: { command: "other-command" },
      },
      oauthAccount: { fixture: "account-auth" },
    }),
  );
  fs.writeFileSync(path.join(root, ".credentials.json"), "fixture-account-secret");
  fs.writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      model: "account-model",
      permissions: { deny: ["Bash(rm:*)"] },
      enabledPlugins: { "fixture@local": true },
    }),
  );
  fs.mkdirSync(path.join(root, "plugins/cache/fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins/cache/fixture/marker"), "keep");
  fs.writeFileSync(
    path.join(root, "plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "fixture@local": [{ installPath: path.join(root, "plugins/cache/fixture") }],
      },
    }),
  );
  const result = f.application.sharedProfiles.migrate(account.id);
  assert.ok(result.conflicts.length);
  const shared = JSON.parse(fs.readFileSync(path.join(f.home, ".claude.json")));
  assert.equal(shared.oauthAccount.fixture, "host-auth");
  assert.equal(shared.mcpServers.legacy.command, "other-command");
  assert.deepEqual(shared.mcpServers.same, {
    command: "shared-command",
    env: { SHARED: "one" },
  });
  const launch = { env: accounts.environment(account.id), args: [] };
  f.application.sharedProfiles.prepare(account, launch);
  assert.equal(
    fs.readFileSync(path.join(root, ".credentials.json"), "utf8"),
    "fixture-account-secret",
  );
  const current = JSON.parse(fs.readFileSync(path.join(root, ".claude.json")));
  assert.equal(current.oauthAccount.fixture, "account-auth");
  const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json")));
  assert.equal(settings.model, "account-model");
  assert.deepEqual(settings.permissions, { deny: ["Bash(rm:*)"] });
  const saved = JSON.parse(
    fs.readFileSync(path.join(root, ".claude.json.before-sharing")),
  );
  assert.equal(saved.mcpServers.same.command, "legacy-command");
  const pluginRecord = JSON.parse(
    fs.readFileSync(path.join(f.home, ".claude/plugins/installed_plugins.json")),
  ).plugins["fixture@local"][0];
  assert.ok(pluginRecord.installPath.startsWith(path.join(f.home, ".claude/plugins")));
  accounts.remove(account.id);
  assert.equal(
    fs.readFileSync(path.join(pluginRecord.installPath, "marker"), "utf8"),
    "keep",
  );
});

test("shared plugin operations serialize different account aliases and block conflicting imports", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const a = accounts.create({ name: "A", tool: "claude" }),
    b = accounts.create({ name: "B", tool: "claude" });
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  f.application.plugins.resolveTool = () => "/fixture/claude";
  f.application.plugins.runner = async (_command, args, options) => {
    assert.equal(options.env.CLAUDE_CONFIG_DIR, undefined);
    if (args[1] === "list") return JSON.stringify({ installed: [], available: [] });
    if (args.includes("list")) return "[]";
    started();
    await gate;
    return "done";
  };
  const pending = f.application.plugins.mutate(a.id, {
    action: "marketplace-add",
    source: "owner/fixture",
  });
  await entered;
  try {
    await assert.rejects(
      f.application.plugins.mutate(b.id, {
        action: "marketplace-add",
        source: "owner/other",
      }),
      { status: 409 },
    );
    assert.throws(() => f.application.sharedProfiles.migrate(b.id), { status: 409 });
  } finally {
    release();
    await pending;
  }
});

test("native extension edits synchronize across account launches without resurrecting deletions or sharing model/auth fields", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const a = accounts.create({ name: "A", tool: "claude" }),
    b = accounts.create({ name: "B", tool: "claude" });
  const config = (account) =>
    path.join(accounts.environment(account.id).CLAUDE_CONFIG_DIR, ".claude.json");
  f.application.sharedProfiles.prepare(a, {});
  f.application.sharedProfiles.prepare(b, {});
  fs.writeFileSync(
    config(a),
    JSON.stringify({
      mcpServers: { added: { command: "fixture", env: { TOKEN: "private-mcp-token" } } },
      oauthAccount: { token: "private-login-token" },
    }),
  );
  f.application.sharedProfiles.prepare(b, {});
  assert.equal(
    JSON.parse(fs.readFileSync(config(b))).mcpServers.added.command,
    "fixture",
  );
  assert.equal(JSON.parse(fs.readFileSync(config(b))).oauthAccount, undefined);
  const hostFile = path.join(f.home, ".claude.json");
  fs.writeFileSync(config(a), JSON.stringify({ mcpServers: {} }));
  f.application.sharedProfiles.prepare(b, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(hostFile)).mcpServers, {});
  f.application.sharedProfiles.prepare(a, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(config(a))).mcpServers, {});
  const state = fs.readFileSync(path.join(f.dataDir, "shared-cli-profiles.json"), "utf8");
  assert.ok(
    !state.includes("private-mcp-token") && !state.includes("private-login-token"),
  );
  await f.restart();
  f.application.sharedProfiles.prepare(b, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(config(b))).mcpServers, {});
});

test("migration retains whole conflicting skill packages and never claims ownership of a native skill", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const account = accounts.create({ name: "Legacy", tool: "claude" });
  const source = path.join(
    accounts.environment(account.id).CLAUDE_CONFIG_DIR,
    "skills",
    "fixture",
  );
  const target = path.join(f.home, ".claude", "skills", "fixture");
  for (const directory of [source, target]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: fixture\ndescription: Legacy\n---\nLegacy",
  );
  fs.writeFileSync(
    path.join(source, "legacy-only.txt"),
    "must not contaminate native skill",
  );
  const native = "---\nname: fixture\ndescription: Native\n---\nNative";
  fs.writeFileSync(path.join(target, "SKILL.md"), native);
  const info = fs.lstatSync(source);
  fs.writeFileSync(
    path.join(f.dataDir, "extension-skills.json"),
    JSON.stringify([
      {
        id: "legacy-owned",
        accountId: account.id,
        path: source,
        dev: info.dev,
        ino: info.ino,
      },
    ]),
  );
  const result = f.application.sharedProfiles.migrate(account.id);
  assert.ok(result.conflicts.some((item) => item.file === source));
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), native);
  assert.equal(fs.existsSync(path.join(target, "legacy-only.txt")), false);
  assert.throws(() => f.application.extensions.removeSkill(account.id, "legacy-owned"), {
    status: 404,
  });
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), native);
});

test("migration rejects linked destinations before copying or projecting config", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const account = accounts.create({ name: "Legacy", tool: "claude" });
  const root = accounts.environment(account.id).CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(root, "skills/fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills/fixture/SKILL.md"), "fixture");
  fs.mkdirSync(path.join(f.home, ".claude"), { recursive: true });
  const external = path.join(f.root, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(f.home, ".claude/skills"));
  assert.throws(() => f.application.sharedProfiles.prepare(account, {}), { status: 409 });
  assert.deepEqual(fs.readdirSync(external), []);
  assert.ok(!fs.lstatSync(path.join(root, "skills")).isSymbolicLink());
});

test("provider connection profiles inherit shared extensions and remain compatible with encrypted backups", async (t) => {
  const f = await applicationFixture(t),
    accounts = f.application.accounts;
  const account = accounts.create({ name: "Generated", tool: "claude" });
  accounts.accounts.find((item) => item.id === account.id).internal = { kind: "fixture" };
  accounts.save();
  f.application.sharedProfiles.prepare(accounts.get(account.id), {});
  const { Backup } = await import("../../server/features/operations/backup.js");
  const backup = new Backup({ dataDir: f.dataDir, home: f.home });
  const created = await backup.create({
    withCredentials: true,
    includeHistory: false,
    passphrase: "fixture backup passphrase",
  });
  assert.ok(fs.existsSync(created.file));
  assert.ok(
    created.manifest.omissions.some((item) => item.includes("Shared native extensions")),
  );
  const root = accounts.environment(account.id).CLAUDE_CONFIG_DIR;
  fs.unlinkSync(path.join(root, "skills"));
  fs.symlinkSync(f.root, path.join(root, "skills"));
  await assert.rejects(
    backup.create({
      withCredentials: true,
      includeHistory: false,
      passphrase: "fixture backup passphrase",
    }),
    { status: 409 },
  );
});

for (const tool of ["codex", "claude", "opencode"])
  test(`${tool} provider directories share assets without breaking encrypted backup`, async (t) => {
    const f = await applicationFixture(t),
      accounts = f.application.accounts;
    const account = accounts.create({ name: "Provider fixture", tool });
    const saved = accounts.accounts.find((item) => item.id === account.id);
    saved.provider = { id: "openrouter" };
    saved.internal = { kind: "fixture" };
    accounts.save();
    f.application.sharedProfiles.prepare(accounts.get(account.id), {});
    const { Backup } = await import("../../server/features/operations/backup.js");
    const backup = new Backup({ dataDir: f.dataDir, home: f.home });
    assert.ok(
      (
        await backup.create({
          withCredentials: true,
          includeHistory: false,
          passphrase: "provider fixture passphrase",
        })
      ).backup.withCredentials,
    );
  });
