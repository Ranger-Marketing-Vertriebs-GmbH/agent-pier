import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("the central MCP list works without agents; agent OAuth logins stay gated", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  assert.equal((await (await f.request("/api/assistant-feature")).json()).enabled, false);
  const created = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer header-secret" },
    },
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  const listed = await (await f.request("/api/mcp-servers")).json();
  assert.deepEqual(
    listed.map((s) => s.name),
    ["docs"],
  );
  const updated = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 1, name: "docs2" },
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "docs2");
  const login = await f.request(`/api/mcp-servers/${server.id}/oauth/login`, {
    method: "POST",
    body: {},
  });
  assert.equal(login.status, 404);
  assert.equal((await login.json()).code, "ASSISTANTS_DISABLED");
  assert.equal(
    (await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" })).status,
    204,
  );
  const audit = JSON.stringify(await (await f.request("/api/audit")).json());
  assert.match(audit, /mcp\.created/);
  assert.doesNotMatch(audit, /header-secret/);
});
