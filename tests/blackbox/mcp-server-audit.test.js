import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

const headerSecret = "Bearer header-secret-value";
const envSecret = "env-secret-value";
const argSecret = "arg-secret-value";
const queryToken = "query-token-value";
const cwdSecret = "/tmp/cwd-secret-dir";

test("MCP server changes and stdio confirmations are audited by name, never by value", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  t.after(() => f.dispose());
  const send = (path, method, body) => f.request(path, { method, body });
  const audit = async (action) =>
    (await (await f.request(`/api/audit?action=${action}`)).json()).events;

  const http = await (
    await send("/api/mcp-servers", "POST", {
      name: "docs",
      transport: "http",
      url: `https://mcp.example.com/v1?token=${queryToken}`,
      headers: { Authorization: headerSecret },
    })
  ).json();
  let [created] = await audit("mcp.created");
  assert.equal(created.resourceType, "mcp");
  assert.equal(created.resourceId, http.id);
  assert.deepEqual(created.details, { transport: "http", stdioConfirmed: false });

  const stdioBody = {
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: [argSecret],
    cwd: cwdSecret,
    env: { TOKEN: envSecret },
  };
  assert.equal((await send("/api/mcp-servers", "POST", stdioBody)).status, 409);
  assert.equal((await audit("mcp.created")).length, 1);
  const local = await (
    await send("/api/mcp-servers", "POST", { ...stdioBody, confirmStdio: true })
  ).json();
  created = (await audit("mcp.created")).find((e) => e.resourceId === local.id);
  assert.deepEqual(created.details, { transport: "stdio", stdioConfirmed: true });

  // An update names the fields it sent; a refused one is not audited.
  assert.equal(
    (
      await send(`/api/mcp-servers/${local.id}`, "PUT", {
        revision: 1,
        args: ["other"],
        env: { TOKEN: "next-env-secret" },
      })
    ).status,
    409,
  );
  assert.equal((await audit("mcp.updated")).length, 0);
  await send(`/api/mcp-servers/${local.id}`, "PUT", {
    revision: 1,
    args: ["other"],
    env: { TOKEN: "next-env-secret" },
    confirmStdio: true,
  });
  await send(`/api/mcp-servers/${http.id}`, "PUT", {
    revision: 1,
    headers: { Authorization: "next-header-secret" },
  });
  const updated = await audit("mcp.updated");
  const byId = Object.fromEntries(updated.map((e) => [e.resourceId, e.details]));
  assert.deepEqual(byId[local.id], {
    transport: "stdio",
    fields: ["args", "env"],
    stdioConfirmed: true,
  });
  assert.deepEqual(byId[http.id], {
    transport: "http",
    fields: ["headers"],
    stdioConfirmed: false,
  });

  // Binding a stdio server to an agent is audited on the agent.
  const agent = f.application.assistants.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const bind = (body) => send(`/api/assistants/${agent.id}`, "PATCH", body);
  assert.equal((await bind({ revision: 1, mcpServers: [local.id] })).status, 409);
  assert.equal((await bind({ revision: 1, mcpServers: [http.id] })).status, 200);
  assert.equal(
    (await bind({ revision: 2, mcpServers: [http.id, local.id], confirmStdio: true }))
      .status,
    200,
  );
  const bound = (await audit("assistant.updated")).map((e) => [e.resourceId, e.details]);
  assert.deepEqual(bound, [
    [agent.id, { fields: ["mcpServers"], stdioConfirmed: true, count: 2 }],
    [agent.id, { fields: ["mcpServers"], stdioConfirmed: false, count: 1 }],
  ]);

  await send(`/api/mcp-servers/${http.id}`, "DELETE");
  const removed = await audit("mcp.deleted");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].resourceId, http.id);
  assert.equal((await send(`/api/mcp-servers/${http.id}`, "DELETE")).status, 404);
  assert.equal((await audit("mcp.deleted")).length, 1);

  const everything = JSON.stringify(await (await f.request("/api/audit")).json());
  for (const secret of [
    headerSecret,
    "header-secret",
    envSecret,
    "next-env-secret",
    "next-header-secret",
    argSecret,
    queryToken,
    cwdSecret,
    "mcp.example.com",
  ])
    assert.ok(!everything.includes(secret), secret);
});
