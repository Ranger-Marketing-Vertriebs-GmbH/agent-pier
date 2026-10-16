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
  assert.deepEqual(created.details, {
    transport: "http",
    stdioConfirmed: false,
    origin: "manual",
  });

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
  assert.deepEqual(created.details, {
    transport: "stdio",
    stdioConfirmed: true,
    origin: "manual",
  });

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
  // A confirmation flag alone is not a stdio binding: only a newly added stdio server is.
  const bindings = [
    [{ revision: 1, mcpServers: [http.id], confirmStdio: true }, false, 1],
    [{ revision: 2, mcpServers: [http.id, local.id], confirmStdio: true }, true, 2],
    [{ revision: 3, mcpServers: [local.id, http.id], confirmStdio: true }, false, 2],
  ];
  for (const [body] of bindings) assert.equal((await bind(body)).status, 200);
  const bound = (await audit("assistant.updated")).map((e) => [e.resourceId, e.details]);
  assert.deepEqual(
    bound,
    bindings
      .map(([, stdioConfirmed, count]) => [
        agent.id,
        { fields: ["mcpServers"], stdioConfirmed, count },
      ])
      .reverse(),
  );

  await send(`/api/mcp-servers/${http.id}`, "DELETE");
  const removed = await audit("mcp.deleted");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].resourceId, http.id);
  assert.deepEqual(removed[0].details, { transport: "http" });
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
