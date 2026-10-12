import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-central-"));
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (f) => f.startsWith("/fake/"),
  });
  t.after(() => {
    servers.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const saved = [];
  const changes = new CentralMcpChanges({
    servers,
    onSaved: async () => saved.push(true),
    ...options,
  });
  return { servers, changes, saved };
}
const oauth = {
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  auth: "oauth",
};

test("without agents the store changes directly and every save reaches onSaved", async (t) => {
  const { servers, changes, saved } = setup(t);
  const created = await changes.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  const { server, pending, logoutDeferred, stdioChanged } = await changes.update(
    created.id,
    { revision: 1, name: "docs2" },
  );
  assert.equal(server.name, "docs2");
  assert.deepEqual([pending, logoutDeferred, stdioChanged], [false, false, false]);
  assert.deepEqual(await changes.remove(created.id), {
    pending: false,
    logoutDeferred: false,
    transport: "http",
  });
  assert.deepEqual(servers.list(), []);
  assert.equal(saved.length, 3);
});

test("without agents a stdio server still needs the owner's confirmation", async (t) => {
  const { servers, changes, saved } = setup(t);
  const stdio = { name: "local", transport: "stdio", command: "/fake/bin/server" };
  await assert.rejects(changes.create(stdio), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(servers.list(), []);
  const created = await changes.create(stdio, { confirmStdio: true });
  await assert.rejects(changes.update(created.id, { revision: 1, args: ["x"] }), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  const { stdioChanged } = await changes.update(
    created.id,
    { revision: 1, args: ["x"] },
    { confirmStdio: true },
  );
  assert.equal(stdioChanged, true);
  assert.equal(saved.length, 2);
});

test("without agents a renamed or deleted OAuth server leaves a deferred logout", async (t) => {
  const { servers, changes } = setup(t);
  const created = await changes.create(oauth);
  servers.rememberOAuth(created.id, {
    connected: true,
    loginRedirect: "http://127.0.0.1:4380/api/mcp-oauth/callback",
  });
  const { logoutDeferred } = await changes.update(created.id, {
    revision: 1,
    name: "renamed",
  });
  assert.equal(logoutDeferred, true);
  // node:sqlite rows have a null prototype; compare plain objects.
  assert.deepEqual(
    servers
      .deferredLogouts()
      .map(({ name, url, transport }) => ({ name, url, transport })),
    [{ name: "docs", url: oauth.url, transport: "http" }],
  );
  // The orphaned login is forgotten, as the agent path does: the server reads as
  // never connected and a second rename defers nothing.
  assert.deepEqual(servers.oauthMemory(created.id), {
    everConnected: false,
    loginRedirect: null,
  });
  const second = await changes.update(created.id, { revision: 2, name: "again" });
  assert.equal(second.logoutDeferred, false);
  assert.equal(servers.deferredLogouts().length, 1);
  servers.rememberOAuth(created.id, { connected: true });
  assert.equal((await changes.remove(created.id)).logoutDeferred, true);
  assert.equal(servers.deferredLogouts().length, 2);
});

test("without agents an unconnected OAuth server leaves no deferred logout", async (t) => {
  const { servers, changes } = setup(t);
  const created = await changes.create(oauth);
  assert.equal(
    (await changes.update(created.id, { revision: 1, name: "renamed" })).logoutDeferred,
    false,
  );
  assert.equal((await changes.remove(created.id)).logoutDeferred, false);
  assert.deepEqual(servers.deferredLogouts(), []);
});

test("without agents an unchanged stdio patch reports a boolean", async (t) => {
  const { changes } = setup(t);
  const created = await changes.create(
    { name: "local", transport: "stdio", command: "/fake/bin/server" },
    { confirmStdio: true },
  );
  const { stdioChanged } = await changes.update(created.id, {
    revision: 1,
    name: "local2",
  });
  assert.equal(stdioChanged, false);
});

test("with agents every change goes through McpChanges; maintenance refuses changes", async (t) => {
  const calls = [];
  const agents = {
    create: async (input, options) => (
      calls.push(["create", input.name, options]),
      { id: "a" }
    ),
    update: async (id) => (
      calls.push(["update", id]),
      { server: { id }, pending: true, logoutDeferred: false, stdioChanged: false }
    ),
    remove: async (id) => (
      calls.push(["remove", id]),
      { pending: false, logoutDeferred: false, transport: "http" }
    ),
  };
  let maintenance = false;
  const { changes, saved } = setup(t, {
    agents: () => agents,
    maintenance: () => maintenance,
  });
  await changes.create({ name: "docs" }, { confirmStdio: true });
  await changes.update("a", { revision: 1 });
  await changes.remove("a");
  assert.deepEqual(calls, [
    ["create", "docs", { confirmStdio: true, clis: [] }],
    ["update", "a"],
    ["remove", "a"],
  ]);
  assert.equal(saved.length, 3);
  maintenance = true;
  await assert.rejects(changes.create({ name: "docs" }), { status: 409 });
  assert.equal(calls.length, 3);
});

test("CLIs travel with the change to McpChanges, after the CLI checks passed", async (t) => {
  const calls = [];
  const agents = {
    update: async (id, input, options) => (
      calls.push(["update", id, options]),
      { server: { id }, pending: false, logoutDeferred: false, stdioChanged: false }
    ),
  };
  const { servers, changes, saved } = setup(t, { agents: () => agents });
  const local = servers.create(
    { name: "local", transport: "stdio", command: "/fake/bin/mcp" },
    { bind: [["cli", "claude"]] },
  );
  // A cwd Claude Code cannot use, or a new CLI without confirmation: nothing is sent.
  await assert.rejects(changes.update(local.id, { revision: 1, cwd: "/tmp" }), {
    code: "MCP_CLI_CWD_UNSUPPORTED",
  });
  await assert.rejects(
    changes.update(local.id, { revision: 1 }, { clis: ["claude", "codex"] }),
    { code: "MCP_STDIO_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(changes.update(local.id, { revision: 1 }, { clis: ["nope"] }), {
    status: 400,
  });
  assert.deepEqual([calls, saved.length], [[], 0]);
  const result = await changes.update(
    local.id,
    { revision: 1, cwd: "/tmp" },
    { clis: ["codex"], confirmStdio: true },
  );
  assert.deepEqual(calls, [
    ["update", local.id, { confirmStdio: true, clis: ["codex"] }],
  ]);
  assert.deepEqual(result.cliChange, { clis: ["codex"], added: ["codex"] });
  assert.equal(saved.length, 1);
});
