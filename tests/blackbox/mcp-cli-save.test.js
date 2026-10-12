import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

// A server and its coding CLIs are saved in one request: a refusal changes neither.
async function setup(t) {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const claude = path.join(f.home, ".claude.json");
  const codex = path.join(f.home, ".codex/config.toml");
  const json = async (url, init) => {
    const response = await f.request(url, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const claudeEntry = () =>
    fs.existsSync(claude)
      ? JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers?.local
      : undefined;
  const codexHas = () =>
    fs.existsSync(codex) && /\[mcp_servers\.local\]/.test(fs.readFileSync(codex, "utf8"));
  const server = async (id) =>
    (await json("/api/mcp-servers")).body.find((item) => item.id === id);
  // A stdio server bound to Claude Code and Codex, written into both.
  const created = await json("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: ["server.js"],
      confirmStdio: true,
      clis: ["claude", "codex"],
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.deepEqual((await server(id)).clis, ["claude", "codex"]);
  assert.ok(claudeEntry());
  assert.ok(codexHas());
  return { f, json, id, server, claudeEntry, codexHas };
}

test("an update rejected for an invalid cwd leaves the CLIs bound and their entries", async (t) => {
  const { json, id, server, claudeEntry, codexHas } = await setup(t);
  const before = claudeEntry();
  const response = await json(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, cwd: "relative/dir", clis: ["codex"], confirmStdio: true },
  });
  assert.equal(response.status, 400);
  const after = await server(id);
  assert.deepEqual(
    [after.revision, after.clis, after.cwd],
    [1, ["claude", "codex"], undefined],
  );
  assert.deepEqual(claudeEntry(), before);
  assert.ok(codexHas());
});

test("an unconfirmed local command for a new CLI changes nothing", async (t) => {
  const { json, id, server } = await setup(t);
  const response = await json(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, args: ["other.js"], clis: ["codex", "opencode"] },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "MCP_STDIO_CONFIRMATION_REQUIRED");
  const after = await server(id);
  assert.deepEqual(
    [after.revision, after.args, after.clis],
    [1, ["server.js"], ["claude", "codex"]],
  );
});

test("one save edits the server and drops a still supported CLI", async (t) => {
  const { f, json, id, server, claudeEntry, codexHas } = await setup(t);
  const response = await json(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, args: ["next.js"], clis: ["claude"], confirmStdio: true },
  });
  assert.equal(response.status, 200);
  const after = await server(id);
  assert.deepEqual(
    [after.revision, after.args, after.clis],
    [2, ["next.js"], ["claude"]],
  );
  assert.deepEqual(claudeEntry().args, ["next.js"]);
  assert.equal(codexHas(), false);
  const { events } = (await json("/api/audit")).body;
  const event = events.find(
    (item) => item.action === "mcp.updated" && item.details.fields?.includes("clis"),
  );
  assert.deepEqual(
    [event.details.fields, event.details.clis, event.details.stdioConfirmed],
    [["args", "clis"], ["claude"], true],
  );
  assert.ok(f);
});

test("a cwd is accepted when the same save unticks Claude Code", async (t) => {
  const { json, id, server, claudeEntry, codexHas } = await setup(t);
  const refused = await json(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, cwd: "/tmp", confirmStdio: true },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "MCP_CLI_CWD_UNSUPPORTED");
  const response = await json(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, cwd: "/tmp", clis: ["codex"], confirmStdio: true },
  });
  assert.equal(response.status, 200);
  const after = await server(id);
  assert.deepEqual([after.cwd, after.clis], ["/tmp", ["codex"]]);
  assert.equal(claudeEntry(), undefined);
  assert.ok(codexHas());
});

test("a create with an unsupported or unknown CLI stores nothing", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  for (const [clis, status] of [
    [["codex"], 400],
    [["nope"], 400],
  ]) {
    const response = await f.request("/api/mcp-servers", {
      method: "POST",
      body: { name: "events", transport: "sse", url: "https://x.example.test/sse", clis },
    });
    assert.equal(response.status, status);
  }
  assert.deepEqual(await (await f.request("/api/mcp-servers")).json(), []);
});
