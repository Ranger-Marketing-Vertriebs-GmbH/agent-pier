import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

const secrets = ["header-secret", "query-secret", "found-secret"];
async function read(response) {
  const text = await response.text();
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  return text ? JSON.parse(text) : null;
}

test("CLI bindings, conflicts and finds over HTTP carry names only and are audited", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const claude = path.join(f.home, ".claude.json");
  const codex = path.join(f.home, ".codex/config.toml");
  const created = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/mcp?k=query-secret",
        headers: { Authorization: "Bearer header-secret" },
      },
    }),
  );
  let response = await f.request(`/api/mcp-servers/${created.id}/clis`, {
    method: "PUT",
    body: { clis: ["claude"] },
  });
  assert.equal(response.status, 200);
  const bound = await read(response);
  assert.deepEqual(
    [bound.clis, bound.cliStatus],
    [["claude"], { claude: { status: "written" } }],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.docs.headers.Authorization,
    "Bearer header-secret",
  );

  const sse = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: { name: "events", transport: "sse", url: "https://mcp.example.test/sse" },
    }),
  );
  response = await f.request(`/api/mcp-servers/${sse.id}/clis`, {
    method: "PUT",
    body: { clis: ["codex"] },
  });
  assert.equal(response.status, 400);
  const refusal = await read(response);
  assert.equal(refusal.code, "MCP_CLI_TRANSPORT_UNSUPPORTED");
  assert.equal(refusal.messageKey, "mcpServers.cliTransportUnsupported");

  const data = JSON.parse(fs.readFileSync(claude, "utf8"));
  data.mcpServers.docs.url = "https://edited.example.test/mcp";
  fs.writeFileSync(claude, JSON.stringify(data));
  const listed = await read(await f.request("/api/mcp-servers"));
  assert.deepEqual(listed.find((s) => s.id === created.id).cliStatus, {
    claude: { status: "conflict", messageKey: "mcpServers.cliStatusConflict" },
  });
  response = await f.request(`/api/mcp-servers/${created.id}/clis/claude/resolve`, {
    method: "POST",
    body: { choice: "overwrite" },
  });
  assert.deepEqual((await read(response)).cliStatus, { claude: { status: "written" } });

  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(
    codex,
    '[mcp_servers."my.search"]\nurl = "https://search.example.test/mcp"\n[mcp_servers."my.search".http_headers]\nAuthorization = "Bearer found-secret"\n',
  );
  const { finds, problems } = await read(await f.request("/api/mcp-servers/cli-finds"));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    finds.map((find) => [find.name, find.proposedName, find.clis, find.headerNames]),
    [["my.search", "my-search", ["codex"], ["Authorization"]]],
  );
  const adopted = await read(
    await f.request("/api/mcp-servers/cli-finds/adopt", {
      method: "POST",
      body: { keys: [finds[0].key] },
    }),
  );
  assert.deepEqual(
    adopted.adopted.map((s) => [s.name, s.clis]),
    [["my-search", ["codex"]]],
  );
  assert.deepEqual(adopted.failed, []);
  assert.deepEqual((await read(await f.request("/api/mcp-servers/cli-finds"))).finds, []);

  assert.equal(
    (await f.request(`/api/mcp-servers/${created.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.docs, undefined);

  const { events } = await read(await f.request("/api/audit"));
  const has = (action, details) =>
    events.some(
      (event) =>
        event.action === action &&
        Object.entries(details).every(
          ([key, value]) => JSON.stringify(event.details[key]) === JSON.stringify(value),
        ),
    );
  assert.ok(has("mcp.updated", { fields: ["clis"], clis: ["claude"] }));
  assert.ok(has("mcp.updated", { clis: ["claude"], resolution: "overwrite" }));
  assert.ok(has("mcp.created", { clis: ["codex"], adopted: true }));
  // Binding a remote server confirms no command.
  assert.ok(has("mcp.updated", { clis: ["claude"], stdioConfirmed: false }));
});
