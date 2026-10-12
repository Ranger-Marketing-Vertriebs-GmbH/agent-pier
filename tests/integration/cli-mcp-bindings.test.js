import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { CliMcpBindings } from "../../server/features/mcp-servers/cli-bindings.js";
import {
  documents,
  profileLocation,
} from "../../server/features/cli-profiles/configuration.js";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

const service = (f, options = {}) =>
  new CliMcpBindings({
    servers: f.servers,
    extensions: f.extensions,
    warn: (line) => f.warnings.push(line),
    ...options,
  });
const launch = () => ({ command: "/usr/bin/cli", args: [], env: { PATH: "/fake/bin" } });

test("a session start writes its own CLI's entries and grants its bound stdio servers", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  f.servers.create(stdio({ cwd: "/tmp/work" }), { bind: [["cli", "codex"]] });
  f.servers.create(stdio({ name: "other", command: "/fake/bin/other" }), {
    bind: [["cli", "claude"]],
  });
  const account = f.accounts.get("local-codex");
  const prepared = await cli.prepare({ account, launch: launch() });
  assert.ok(f.entries("codex").local);
  assert.deepEqual(f.entries("claude"), {});
  const grants = prepared.sandboxGrants.map((grant) => `${grant.access}:${grant.path}`);
  assert.ok(grants.includes("read:/fake/bin/server"));
  assert.ok(grants.includes("allow:/tmp/work"));
  assert.ok(!grants.some((grant) => grant.includes("/fake/bin/other")));
  assert.deepEqual(
    await cli.prepare({ account, launch: launch(), purpose: "login" }),
    launch(),
  );
  assert.deepEqual(
    await cli.prepare({ account: f.accounts.get("local-shell"), launch: launch() }),
    launch(),
  );
});

// Review Focus 4
test("a session starts even when its CLI's configuration cannot be read", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  f.raw("claude", "{ broken");
  const account = f.accounts.get("local-claude");
  const prepared = await cli.prepare({ account, launch: launch() });
  assert.ok(prepared.sandboxGrants.some((grant) => grant.path === "/fake/bin/server"));
  assert.equal(f.text("claude"), "{ broken");
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /broken|secret|\//);
  f.servers.close();
  assert.deepEqual(await cli.prepare({ account, launch: launch() }), launch());
});

test("binding refuses what a CLI cannot run and asks before a CLI gets a local command", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  const sse = f.servers.create(http({ name: "events", transport: "sse" }));
  await assert.rejects(cli.setClis(sse.id, ["codex"]), {
    status: 400,
    code: "MCP_CLI_TRANSPORT_UNSUPPORTED",
  });
  const local = f.servers.create(stdio({ cwd: "/tmp" }));
  await assert.rejects(cli.setClis(local.id, ["claude"], { confirmStdio: true }), {
    status: 400,
    code: "MCP_CLI_CWD_UNSUPPORTED",
  });
  await assert.rejects(cli.setClis(local.id, ["codex"]), {
    code: "MCP_STDIO_CONFIRMATION_REQUIRED",
  });
  assert.deepEqual(f.servers.targetsOf(local.id).clis, []);
  assert.deepEqual(await cli.setClis(local.id, ["codex"], { confirmStdio: true }), {
    clis: ["codex"],
    added: ["codex"],
    removed: [],
  });
  assert.ok(f.entries("codex").local);
  await assert.rejects(cli.setClis(local.id, ["gemini"]), { status: 400 });
  assert.deepEqual(await cli.setClis(local.id, []), {
    clis: [],
    added: [],
    removed: ["codex"],
  });
  assert.deepEqual(f.entries("codex"), {});
});

test("the list shows bound CLIs, support, status and users by name, never a value", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f, { agentNames: () => new Map([["home", "Home"]]) });
  const server = f.servers.create(http(), {
    bind: [
      ["agent", "home"],
      ["agent", "gone"],
    ],
  });
  f.write("codex", { docs: { url: "https://owner.example.test/mcp" } });
  await cli.setClis(server.id, ["claude", "codex"]);
  const [listed] = await cli.decorate(f.servers.list());
  assert.deepEqual(listed.clis, ["claude", "codex"]);
  assert.deepEqual(listed.cliSupport, {
    claude: { supported: true },
    codex: { supported: true },
    opencode: { supported: true },
  });
  assert.deepEqual(listed.cliStatus, {
    claude: { status: "written" },
    codex: { status: "name-taken" },
  });
  assert.deepEqual(listed.users, { agents: ["Home"], clis: ["claude", "codex"] });
  assert.doesNotMatch(JSON.stringify(listed), /secret/);
});

test("the owner resolves a conflict by writing AgentPier's version or adopting the edit", async (t) => {
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const cli = service(f, { changes: () => changes });
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  cli.reconcileAll();
  const edited = {
    type: "http",
    url: "https://edited.example.test/mcp",
    headers: { Authorization: "Bearer header-secret" },
  };
  f.write("claude", { docs: edited });
  await cli.resolve(server.id, "claude", "overwrite");
  assert.equal(
    f.entries("claude").docs.url,
    "https://mcp.example.test/mcp?key=query-secret",
  );
  f.write("claude", { docs: edited });
  await cli.resolve(server.id, "claude", "adopt");
  assert.equal(f.servers.definitions()[0].url, "https://edited.example.test/mcp");
  assert.deepEqual(f.entries("claude").docs, edited);
  await assert.rejects(cli.resolve(server.id, "claude", "adopt"), { status: 409 });
  await assert.rejects(cli.resolve(server.id, "claude", "ignore"), { status: 400 });
});

test("managed accounts receive the entries and AgentPier's writes are never drift", async (t) => {
  const f = cliMcpFixture(t);
  const cli = service(f);
  const a = f.accounts.create({ name: "A", tool: "claude" });
  const b = f.accounts.create({ name: "B", tool: "claude" });
  const entries = (account) => {
    const file = documents(profileLocation(f.accounts, account.id))[0].file;
    return JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {};
  };
  const start = async (account) => {
    const prepared = await cli.prepare({
      account,
      launch: { command: "claude", args: [], env: {} },
    });
    f.sharedProfiles.prepare(account, prepared);
  };
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  await start(a);
  await start(b);
  assert.ok(entries(a).docs && entries(b).docs);
  f.servers.update(server.id, { revision: 1, url: "https://moved.example.test/mcp" });
  cli.reconcileAll();
  await start(b);
  await start(a);
  assert.equal(entries(a).docs.url, "https://moved.example.test/mcp");
  await cli.setClis(server.id, []);
  await start(a);
  await start(b);
  assert.equal(entries(a).docs, undefined);
  assert.equal(entries(b).docs, undefined);
  assert.deepEqual(f.sharedProfiles.summary(a.id).conflicts, []);
});

test("a saved change a bound CLI cannot run is refused before anything is stored", async (t) => {
  const f = cliMcpFixture(t);
  const changes = new CentralMcpChanges({ servers: f.servers });
  const cli = service(f, { changes: () => changes });
  const local = f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  cli.reconcileAll();
  await assert.rejects(
    changes.update(local.id, { revision: 1, cwd: "/tmp" }, { confirmStdio: true }),
    { status: 400, code: "MCP_CLI_CWD_UNSUPPORTED" },
  );
  assert.equal(f.servers.get(local.id).cwd, undefined);
  assert.equal(f.servers.get(local.id).revision, 1);
  assert.ok(f.entries("claude").local);
  // Codex and OpenCode run a stdio command in a working directory.
  await cli.setClis(local.id, ["codex"], { confirmStdio: true });
  await changes.update(local.id, { revision: 1, cwd: "/tmp" }, { confirmStdio: true });
  assert.equal(f.servers.get(local.id).cwd, "/tmp");
  const events = f.servers.create(http({ name: "events" }), { bind: [["cli", "codex"]] });
  await assert.rejects(changes.update(events.id, { revision: 1, transport: "sse" }), {
    status: 400,
  });
  assert.equal(f.servers.get(events.id).transport, "http");
});
