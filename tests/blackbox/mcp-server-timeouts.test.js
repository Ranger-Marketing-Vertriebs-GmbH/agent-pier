import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("the API stores MCP timeouts, refuses them out of bounds and audits the field", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const send = (path, method, body) => f.request(path, { method, body });
  const docs = {
    name: "docs",
    transport: "http",
    url: "https://mcp.example.com/mcp",
  };

  const refused = await send("/api/mcp-servers", "POST", {
    ...docs,
    toolTimeoutSec: 3601,
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).messageKey, "mcpServers.invalidToolTimeout");
  const startup = await send("/api/mcp-servers", "POST", {
    ...docs,
    startupTimeoutSec: 0,
  });
  assert.equal((await startup.json()).messageKey, "mcpServers.invalidStartupTimeout");
  assert.deepEqual(await (await f.request("/api/mcp-servers")).json(), []);

  const created = await send("/api/mcp-servers", "POST", {
    ...docs,
    startupTimeoutSec: 30,
    toolTimeoutSec: 450,
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  assert.deepEqual([server.startupTimeoutSec, server.toolTimeoutSec], [30, 450]);

  const updated = await send(`/api/mcp-servers/${server.id}`, "PUT", {
    revision: 1,
    toolTimeoutSec: null,
  });
  assert.equal(updated.status, 200);
  const after = await updated.json();
  assert.equal(after.startupTimeoutSec, 30);
  assert.equal(Object.hasOwn(after, "toolTimeoutSec"), false);
  const [event] = (await (await f.request("/api/audit?action=mcp.updated")).json())
    .events;
  assert.deepEqual(event.details.fields, ["toolTimeoutSec"]);
});
