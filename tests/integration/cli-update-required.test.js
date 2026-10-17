import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import {
  MINIMUM_CLI_VERSIONS,
  createCliVersionProbe,
  withCliVersions,
} from "../../server/features/tools/cli-version.js";
import { applicationFixture } from "../helpers/application.js";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-cli-minimum-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(root, name, body) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// Where the official installers put each CLI, so AgentPier can update it itself.
const native = { codex: ".local/bin", claude: ".local/bin", opencode: ".opencode/bin" };

test("a launch of a managed CLI below its minimum is refused before anything is prepared", async (t) => {
  const root = directory(t);
  const store = new AccountStore({
    dataDir: path.join(root, "data"),
    home: root,
    versions: createCliVersionProbe(),
  });
  const old = {
    codex: cli(root, `${native.codex}/codex`, 'echo "codex-cli 0.100.0"'),
    claude: cli(root, `${native.claude}/claude`, 'echo "2.0.1 (Claude Code)"'),
    opencode: cli(root, `${native.opencode}/opencode`, "echo 1.0.0"),
  };
  for (const tool of ["codex", "claude", "opencode"]) {
    const account = store.create({ name: `Old ${tool}`, tool });
    for (const id of [`local-${tool}`, account.id])
      await assert.rejects(store.command(id, { [tool]: old[tool] }), (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "CLI_UPDATE_REQUIRED");
        assert.deepEqual(error.updateRequired, {
          tool,
          found: { codex: "0.100.0", claude: "2.0.1", opencode: "1.0.0" }[tool],
          required: MINIMUM_CLI_VERSIONS[tool],
        });
        return true;
      });
    // Logins run the same CLI and are refused the same way.
    await assert.rejects(store.command(account.id, { [tool]: old[tool] }, true), {
      code: "CLI_UPDATE_REQUIRED",
    });
  }
});

test("an external CLI below its minimum only warns, since AgentPier cannot update it", async (t) => {
  const root = directory(t);
  const store = new AccountStore({
    dataDir: path.join(root, "data"),
    home: path.join(root, "home"),
    versions: createCliVersionProbe(),
  });
  // A Homebrew- or npm-style location outside the server home.
  const old = cli(root, "opt/homebrew/bin/claude", 'echo "2.0.1 (Claude Code)"');
  const launch = await store.command("local-claude", { claude: old });
  assert.equal(launch.command, old);
  assert.equal(launch.cliVersion, "2.0.1");
});

test("a Claude custom-model launch retries an unreadable version once with a longer timeout", async (t) => {
  const root = directory(t);
  const calls = [];
  const store = new AccountStore({
    dataDir: path.join(root, "data"),
    home: root,
    versions: {
      read: async (_command, options = {}) => {
        calls.push(options);
        return options.refresh ? "2.1.296" : null;
      },
    },
  });
  const account = store.create({
    name: "Z.ai",
    tool: "claude",
    apiKey: "fixture-key",
    provider: { id: "zai", modelId: "glm-5.3" },
  });
  const launch = await store.command(account.id, { claude: "/opt/claude" });
  assert.equal(launch.cliVersion, "2.1.296");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].refresh, true);
  assert.ok(calls[1].timeout >= 10_000);
  // A native Claude session does not need the version and is not retried.
  calls.length = 0;
  await store.command("local-claude", { claude: "/opt/claude" });
  assert.equal(calls.length, 1);
});

test("an unreadable version starts the session, a current one is recorded on the launch", async (t) => {
  const root = directory(t);
  const store = new AccountStore({
    dataDir: path.join(root, "data"),
    home: root,
    versions: createCliVersionProbe(),
  });
  const silent = cli(root, "codex", "exit 1");
  const unknown = await store.command("local-codex", { codex: silent });
  assert.equal(unknown.command, silent);
  assert.equal(unknown.cliVersion, undefined);
  const current = cli(root, "claude", 'echo "2.1.296 (Claude Code)"');
  const launch = await store.command("local-claude", { claude: current });
  assert.equal(launch.cliVersion, "2.1.296");
  // The shell has no minimum and is never probed.
  const shell = await store.command("local-shell", { shell: "/bin/sh" });
  assert.equal(shell.cliVersion, undefined);
});

test("the tool list reports version, minimum and state for each installed coding CLI", async (t) => {
  const root = directory(t);
  const tools = await withCliVersions(
    [
      { id: "codex", installed: true, path: cli(root, "codex", "echo 0.160.1") },
      { id: "claude", installed: true, path: cli(root, "claude", "echo 2.1.100") },
      { id: "opencode", installed: true, path: cli(root, "opencode", "exit 2") },
      { id: "shell", installed: true, path: "/bin/sh" },
      { id: "gh", installed: false, path: null },
    ],
    {
      probe: createCliVersionProbe(),
      wait: true,
      managed: (tool) => tool.id === "claude",
    },
  );
  assert.deepEqual(
    tools.map(({ id, version, minimumVersion, versionStatus, managedInstall }) => ({
      id,
      version,
      minimumVersion,
      versionStatus,
      ...(managedInstall !== undefined ? { managedInstall } : {}),
    })),
    [
      {
        id: "codex",
        version: "0.160.1",
        minimumVersion: MINIMUM_CLI_VERSIONS.codex,
        versionStatus: "ok",
        managedInstall: false,
      },
      {
        id: "claude",
        version: "2.1.100",
        minimumVersion: MINIMUM_CLI_VERSIONS.claude,
        versionStatus: "update-required",
        managedInstall: true,
      },
      {
        id: "opencode",
        version: null,
        minimumVersion: MINIMUM_CLI_VERSIONS.opencode,
        versionStatus: "unknown",
        managedInstall: false,
      },
      {
        id: "shell",
        version: undefined,
        minimumVersion: undefined,
        versionStatus: undefined,
      },
      {
        id: "gh",
        version: undefined,
        minimumVersion: undefined,
        versionStatus: undefined,
      },
    ],
  );
});

test("POST /api/sessions answers an outdated CLI with a typed update_required problem", async (t) => {
  const f = await applicationFixture(t);
  const old = cli(f.home, ".local/bin/claude", 'echo "2.1.100 (Claude Code)"');
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { claude: old }, login, mode, options);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-claude", cwd: f.home },
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "CLI_UPDATE_REQUIRED");
  assert.deepEqual(body.updateRequired, {
    tool: "claude",
    found: "2.1.100",
    required: MINIMUM_CLI_VERSIONS.claude,
  });
  assert.equal(body.messageKey, "tools.cliUpdateRequired");
  assert.deepEqual(body.messageArgs, [
    "Claude Code",
    "2.1.100",
    MINIMUM_CLI_VERSIONS.claude,
  ]);
  assert.deepEqual(await f.application.sessions.list(), []);
});

test("a started session records the CLI version it launched with", async (t) => {
  const f = await applicationFixture(t);
  const current = cli(
    f.root,
    "current-codex",
    '[ "$1" = "--version" ] && { echo "codex-cli 0.160.1"; exit 0; }\nexec sleep 30',
  );
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { codex: current }, login, mode, options);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-codex", cwd: f.home, agentbus: false },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json();
  assert.equal((await f.application.sessions.get(session.id)).cliVersion, "0.160.1");
});

test("a login with an outdated managed CLI is refused with update_required", async (t) => {
  const f = await applicationFixture(t);
  const old = cli(f.home, ".local/bin/codex", 'echo "codex-cli 0.100.0"');
  const account = f.application.accounts.create({ name: "Old login", tool: "codex" });
  const original = f.application.accounts.command.bind(f.application.accounts);
  f.application.accounts.command = (id, _binaries, login, mode, options) =>
    original(id, { codex: old }, login, mode, options);
  const response = await f.request(`/api/accounts/${account.id}/login`, {
    method: "POST",
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "CLI_UPDATE_REQUIRED");
  assert.deepEqual(body.updateRequired, {
    tool: "codex",
    found: "0.100.0",
    required: MINIMUM_CLI_VERSIONS.codex,
  });
  assert.deepEqual(await f.application.sessions.list(), []);
});
