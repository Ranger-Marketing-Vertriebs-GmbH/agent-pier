import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

const headerSecret = "Bearer header-secret-value";
const envSecret = "env-secret-value";
const queryToken = "query-token-value";
const secrets = [headerSecret, "header-secret", envSecret, queryToken];
const assertClean = (text) => {
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
};
// Every response body, checked for secrets and query strings before it is parsed.
async function read(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assertClean(text);
  return text ? JSON.parse(text) : null;
}

test("MCP server routes are owner-only, origin-checked and never return secrets", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  t.after(() => f.dispose());
  // Without a session or with a foreign origin nothing is answered.
  assert.equal((await fetch(f.url + "/api/mcp-servers")).status, 401);
  const http = {
    name: "docs",
    transport: "http",
    url: `https://mcp.example.com/v1?token=${queryToken}`,
    headers: { Authorization: headerSecret },
  };
  const foreign = await f.request("/api/mcp-servers", {
    method: "POST",
    origin: "https://foreign.invalid",
    body: http,
  });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await read(await f.request("/api/mcp-servers")), []);

  const created = await f.request("/api/mcp-servers", { method: "POST", body: http });
  assert.equal(created.status, 201);
  const server = await read(created);
  assert.deepEqual(server, {
    id: server.id,
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com/v1",
    headerNames: ["Authorization"],
    envNames: [],
    revision: 1,
  });

  // Names are unique regardless of case.
  const duplicate = await f.request("/api/mcp-servers", {
    method: "POST",
    body: { ...http, name: "DOCS" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await read(duplicate)).messageKey, "mcpServers.nameTaken");

  // stdio needs the owner's confirmation; nothing is stored without it.
  const stdio = {
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: ["server.js"],
    env: { TOKEN: envSecret },
  };
  const unconfirmed = await f.request("/api/mcp-servers", {
    method: "POST",
    body: stdio,
  });
  assert.equal(unconfirmed.status, 409);
  const refusal = await read(unconfirmed);
  assert.equal(refusal.code, "MCP_STDIO_CONFIRMATION_REQUIRED");
  assert.equal(refusal.messageKey, "mcpServers.stdioConfirmationRequired");
  assert.deepEqual(
    (await read(await f.request("/api/mcp-servers"))).map((s) => s.name),
    ["docs"],
  );
  const confirmed = await f.request("/api/mcp-servers", {
    method: "POST",
    body: { ...stdio, confirmStdio: true },
  });
  assert.equal(confirmed.status, 201);
  const local = await read(confirmed);
  assert.equal(local.command, process.execPath);
  assert.deepEqual(local.envNames, ["TOKEN"]);

  // Updates need the current revision.
  const update = (revision) =>
    f.request(`/api/mcp-servers/${server.id}`, {
      method: "PUT",
      body: { revision, headers: { Authorization: `${headerSecret}-2` } },
    });
  const updated = await update(1);
  assert.equal(updated.status, 200);
  assert.equal((await read(updated)).revision, 2);
  const stale = await update(1);
  assert.equal(stale.status, 409);
  assert.equal((await read(stale)).messageKey, "mcpServers.conflict");

  // The owner binds servers to an agent through the agent's settings.
  const agent = f.application.assistants.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const bind = (body) =>
    f.request(`/api/assistants/${agent.id}`, { method: "PATCH", body });
  const refused = await bind({ revision: 1, mcpServers: [server.id, local.id] });
  assert.equal(refused.status, 409);
  assert.equal((await read(refused)).code, "MCP_STDIO_CONFIRMATION_REQUIRED");
  const bound = await bind({
    revision: 1,
    mcpServers: [server.id, local.id],
    confirmStdio: true,
  });
  assert.equal(bound.status, 200);
  const saved = await read(bound);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.mcpServers, [server.id, local.id]);
  const listed = await read(await f.request("/api/assistants"));
  assert.deepEqual(listed.assistants.find((a) => a.id === agent.id).mcpServers, [
    server.id,
    local.id,
  ]);

  // Removing a server removes its bindings.
  const removed = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 204);
  const after = await read(await f.request("/api/assistants"));
  assert.deepEqual(after.assistants.find((a) => a.id === agent.id).mcpServers, [
    local.id,
  ]);
  const missing = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "DELETE",
  });
  assert.equal(missing.status, 404);
  await read(missing);
});
