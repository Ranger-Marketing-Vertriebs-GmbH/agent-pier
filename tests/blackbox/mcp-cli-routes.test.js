import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fakeCliOAuthRun } from "../helpers/application.js";

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

test("fixtures never run a real Codex for the OAuth status of a bound server", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const runs = [];
  const status = f.application.cliMcp.oauthStatus;
  const original = status.run;
  assert.equal(original, fakeCliOAuthRun);
  status.run = (...args) => {
    runs.push(args[0]);
    return original(...args);
  };
  // A Codex that is "installed" but must never be executed.
  status.tools = () => [{ id: "codex", installed: true, path: "/nonexistent/codex" }];
  const server = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "login",
        transport: "http",
        url: "https://x.example.test/mcp",
        auth: "oauth",
      },
    }),
  );
  await f.request(`/api/mcp-servers/${server.id}/clis`, {
    method: "PUT",
    body: { clis: ["codex"] },
  });
  await status.settled();
  const listed = await read(await f.request("/api/mcp-servers"));
  assert.equal(listed[0].cliStatus.codex.oauth.state, "unknown");
  assert.deepEqual(runs, ["/nonexistent/codex"]);
});

test("finds with environment references and too-large files carry stable reasons", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const opencode = path.join(f.home, ".config/opencode/opencode.json");
  fs.mkdirSync(path.dirname(opencode), { recursive: true });
  fs.writeFileSync(
    opencode,
    JSON.stringify({
      mcp: {
        search: {
          type: "remote",
          url: "https://search.example.test/mcp",
          headers: { "X-Key": "{env:FOUND_SECRET_found-secret}" },
        },
      },
    }),
  );
  const claude = path.join(f.home, ".claude.json");
  fs.writeFileSync(claude, "{}");
  fs.truncateSync(claude, 64 * 1024 * 1024 + 1);
  const { finds, problems } = await read(await f.request("/api/mcp-servers/cli-finds"));
  assert.deepEqual(problems, [
    { cli: "claude", reason: "too-large", messageKey: "mcpServers.cliReasonTooLarge" },
  ]);
  assert.deepEqual(finds, [
    {
      key: finds[0].key,
      name: "search",
      clis: ["opencode"],
      adoptable: false,
      reason: "env-references",
      referenceNames: ["X-Key"],
      messageKey: "mcpServers.cliFindEnvReferences",
    },
  ]);
  const response = await f.request("/api/mcp-servers/cli-finds/adopt", {
    method: "POST",
    body: { keys: [finds[0].key] },
  });
  const result = await read(response);
  assert.deepEqual(
    [
      result.adopted,
      result.failed.map((item) => [item.name, item.reason, item.messageKey]),
    ],
    [[], [["search", "env-references", "mcpServers.cliFindEnvReferences"]]],
  );
  assert.equal(fs.statSync(claude).size, 64 * 1024 * 1024 + 1);
});

test("adopting a hand edit with a reference names the references, not the generic reason", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const claude = path.join(f.home, ".claude.json");
  const created = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: {
        name: "docs",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer header-secret" },
      },
    }),
  );
  await f.request(`/api/mcp-servers/${created.id}/clis`, {
    method: "PUT",
    body: { clis: ["claude"] },
  });
  const data = JSON.parse(fs.readFileSync(claude, "utf8"));
  data.mcpServers.docs.headers.Authorization = "Bearer ${FOUND_TOKEN}";
  fs.writeFileSync(claude, JSON.stringify(data));
  const response = await f.request(`/api/mcp-servers/${created.id}/clis/claude/resolve`, {
    method: "POST",
    body: { choice: "adopt" },
  });
  assert.equal(response.status, 409);
  const refusal = await read(response);
  assert.equal(refusal.code, "MCP_CLI_CHANGE_ENV_REFERENCES");
  assert.equal(refusal.messageKey, "mcpServers.cliChangeEnvReferences");
});

test("a server value with a reference is refused with its field and never echoed", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const response = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer {env:header-secret}" },
    },
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.doesNotMatch(text, /header-secret/);
  const refusal = JSON.parse(text);
  assert.deepEqual(
    [refusal.code, refusal.field, refusal.names, refusal.messageKey],
    [
      "MCP_SERVER_VALUE_REFERENCE",
      "headers",
      ["Authorization"],
      "mcpServers.valueReference",
    ],
  );
  assert.deepEqual(await read(await f.request("/api/mcp-servers")), []);
});

test("a stored reference does not block an unrelated save; a changed one is refused", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const created = await read(
    await f.request("/api/mcp-servers", {
      method: "POST",
      body: { name: "docs", transport: "http", url: "https://mcp.example.test/mcp" },
    }),
  );
  f.application.mcpServers.db
    .prepare("UPDATE servers SET url=? WHERE id=?")
    .run("https://mcp.example.test/mcp?k=${X}", created.id);
  let response = await f.request(`/api/mcp-servers/${created.id}`, {
    method: "PUT",
    body: {
      revision: created.revision,
      name: "docs2",
      url: "https://mcp.example.test/mcp?k=${X}",
      clis: ["codex"],
    },
  });
  assert.equal(response.status, 200);
  const saved = await read(response);
  response = await f.request(`/api/mcp-servers/${created.id}`, {
    method: "PUT",
    body: { revision: saved.revision, url: "https://mcp.example.test/mcp?k=${Y}" },
  });
  assert.equal(response.status, 400);
  assert.equal((await read(response)).field, "url");
});

test("a reference is refused before a local command is to be confirmed", async (t) => {
  const f = await applicationFixture(t);
  t.after(() => f.dispose());
  const command = path.join(f.home, "server");
  fs.writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
  const local = { name: "local", transport: "stdio", command };
  let response = await f.request("/api/mcp-servers", {
    method: "POST",
    body: { ...local, env: { KEY: "${KEY_VALUE}" }, clis: ["codex"] },
  });
  assert.equal(response.status, 400);
  assert.equal((await read(response)).code, "MCP_SERVER_VALUE_REFERENCE");
  response = await f.request("/api/mcp-servers", {
    method: "POST",
    body: { ...local, confirmStdio: true },
  });
  assert.equal(response.status, 201);
  const created = await read(response);
  response = await f.request(`/api/mcp-servers/${created.id}`, {
    method: "PUT",
    body: { revision: created.revision, args: ["--dir", "${my-dir}"] },
  });
  assert.equal(response.status, 400);
  assert.equal((await read(response)).field, "args");
});
