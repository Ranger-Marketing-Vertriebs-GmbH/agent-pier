import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect, selection } from "../helpers/session-mcp.js";
import {
  capabilityDirectory,
  checkSessionCapability,
} from "../../server/features/mcp/session-capability.js";

for (const tool of ["codex", "claude", "opencode"]) {
  test(`${tool}: native MCP config and real stdio client use session grants without OAuth`, async (t) => {
    const f = await applicationFixture(t);
    const issued = await issue(f, { tool });
    const client = await connect(t, f, issued);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((entry) => entry.name === "projects_list"));
    assert.ok(!listed.tools.some((entry) => entry.name === "run_start"));
    const projects = await client.callTool({ name: "projects_list", arguments: {} });
    assert.equal(projects.isError, undefined);
    assert.equal(projects.structuredContent.items.length, 1);
    const denied = await client.callTool({ name: "run_start", arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(f.application.mcpAccess.listGrants().grants.length, 0);
    assert.equal(JSON.stringify(issued.session).includes(issued.token), false);
    assert.equal(JSON.stringify(issued.launch).includes(issued.token), false);
    const shortToken = issued.token.split(".").at(-1);
    assert.equal(JSON.stringify(issued.launch).includes(shortToken), false);
    if (tool === "codex")
      assert.ok(
        issued.launch.args.some((a) => a.startsWith("mcp_servers.agentpier_session=")),
      );
    if (tool === "claude") {
      const plugin = issued.launch.args[issued.launch.args.indexOf("--plugin-dir") + 1];
      const config = JSON.parse(
        await fs.readFile(path.join(plugin, ".mcp.json"), "utf8"),
      );
      assert.equal(config.mcpServers.agentpier_session.command, process.execPath);
    }
    if (tool === "opencode")
      assert.equal(
        JSON.parse(issued.launch.env.OPENCODE_CONFIG_CONTENT).mcp.agentpier_session.type,
        "local",
      );
    await f.restart();
    assert.equal(
      (await client.callTool({ name: "projects_list", arguments: {} })).isError,
      undefined,
    );
    assert.equal(
      (await f.request(`/api/sessions/${issued.session.id}/mcp`, { method: "DELETE" }))
        .status,
      200,
    );
    await assert.rejects(client.listTools());
    assert.equal(
      (await f.application.sessions.get(issued.session.id)).agentpierTools.enabled,
      false,
    );
    assert.equal(
      JSON.stringify(await (await f.request("/api/audit")).json()).includes(shortToken),
      false,
    );
  });
}

test("expiry, process exit, session identity mismatch and generation rotation reject old capabilities", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const id = issued.session.id;
  assert.throws(
    () =>
      checkSessionCapability(
        f.dataDir,
        issued.token,
        issued.session.agentpierTools.expiresAt,
      ),
    { status: 403 },
  );
  const session = await f.application.sessions.get(id);
  await f.application.sessions.save({ ...session, accountId: "local-claude" });
  assert.throws(() => f.application.sessionMcp.check(issued.token), { status: 403 });
  await f.application.sessions.save(session);
  const renewed = await f.application.sessionMcp.prepare({
    id,
    account: f.application.accounts.get("local-codex"),
    cwd: f.home,
    launch: { args: [], env: {} },
    selection: selection(),
  });
  assert.throws(() => f.application.sessionMcp.check(issued.token), { status: 403 });
  await f.application.sessions.save({
    ...session,
    agentpierTools: renewed.agentpierTools,
  });
  const file = path.join(
    capabilityDirectory(f.dataDir, id),
    `${renewed.agentpierTools.generation}.json`,
  );
  const fresh = JSON.parse(await fs.readFile(file, "utf8")).token;
  assert.equal(f.application.sessionMcp.check(fresh).extra.grant.id, `session-${id}`);
  await f.application.sessions.tmux([
    "kill-session",
    "-t",
    f.application.sessions.target(id),
  ]);
  await assert.rejects(f.application.sessionMcp.verify(fresh), { status: 403 });
  assert.throws(() => f.application.sessionMcp.check(fresh), { status: 403 });
});

test("launch rejects invalid grants, shell/login/pipeline access and cleans up a failed native start", async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  for (const choices of [
    { ...selection(), scopes: ["owner:all"] },
    { ...selection(), accountIds: ["missing"] },
    true,
  ])
    assert.throws(() => a.sessionMcp.validate(choices), { status: 400 });
  for (const input of [
    { purpose: "login" },
    { pipeline: { headless: true } },
    { account: a.accounts.get("local-shell") },
  ])
    await assert.rejects(
      a.sessionMcp.prepare({
        id: "forbidden",
        account: a.accounts.get("local-codex"),
        cwd: f.home,
        launch: { args: [], env: {} },
        selection: selection(),
        ...input,
      }),
      { status: 400 },
    );
  assert.equal(
    (
      await a.sessionMcp.prepare({
        account: { tool: "codex" },
        pipeline: { headless: true },
        launch: { args: [] },
      })
    ).agentpierTools,
    undefined,
  );
  a.sessions.create = async () => {
    throw Object.assign(Error("Synthetic native start failure"), { status: 400 });
  };
  const original = a.accounts.command.bind(a.accounts);
  a.accounts.command = (id, ...args) =>
    id === "local-codex"
      ? { command: "/missing-cli", args: [], env: {} }
      : original(id, ...args);
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-codex",
      cwd: f.home,
      agentbus: false,
      agentpierTools: selection(),
    },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "session-mcp")), []);
});

test("session lifecycle persists only safe grant metadata and stop revokes access", async (t) => {
  const f = await applicationFixture(t);
  f.application.accounts.command = () => ({
    command: "/bin/sh",
    args: ["-c", "exec sleep 120"],
    env: {},
  });
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-codex",
      cwd: f.home,
      agentbus: false,
      agentpierTools: selection(),
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json();
  assert.equal(session.agentpierTools.enabled, true);
  assert.equal(JSON.stringify(session).includes('"token"'), false);
  const client = await connect(t, f, {
    file: path.join(
      capabilityDirectory(f.dataDir, session.id),
      `${session.agentpierTools.generation}.json`,
    ),
  });
  assert.ok((await client.listTools()).tools.length);
  assert.equal(
    (await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" })).status,
    200,
  );
  await assert.rejects(client.listTools());
});

test("session capabilities never authenticate the public HTTP MCP endpoint", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const response = await fetch(f.url + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issued.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
});
