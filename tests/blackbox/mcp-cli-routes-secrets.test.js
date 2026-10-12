import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

// Distinct values planted in the store, the native files and the CLI's own output:
// none may reach a response body, an audit event or a log line.
const secrets = [
  "store-header-secret",
  "store-query-secret",
  "store-env-secret",
  "native-header-secret",
  "native-env-secret",
  "native-query-secret",
  "edited-header-secret",
  "status-header-secret",
];

/** A fake `codex` first on PATH: answers `mcp list --json` and records its HOME. */
function fakeCodex(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-fake-codex-"));
  const marker = path.join(bin, "home");
  const list = JSON.stringify([
    {
      name: "login",
      auth_status: "o_auth",
      transport: { http_headers: { Authorization: "Bearer status-header-secret" } },
    },
    { name: "docs", auth_status: "bearer_token" },
  ]);
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nprintf '%s' "$HOME" > '${marker}'\n[ "$1 $2 $3" = "mcp list --json" ] || exit 2\nprintf '%s' '${list}'\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return marker;
}

/** Every console line the application writes while the test runs. */
function captureLogs(t) {
  const lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
    t.after(() => (console[level] = original));
  }
  return lines;
}

test("no route shows, audits or logs a header, environment or query value", async (t) => {
  const marker = fakeCodex(t);
  const logs = captureLogs(t);
  // Runs the detected Codex: the fake one first on PATH.
  const f = await applicationFixture(t, { realCliOAuthStatus: true });
  t.after(() => f.dispose());
  const bodies = [];
  const call = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const files = {
    claude: path.join(f.home, ".claude.json"),
    codex: path.join(f.home, ".codex/config.toml"),
    opencode: path.join(f.home, ".config/opencode/opencode.json"),
  };
  const create = async (body) =>
    (await call("/api/mcp-servers", { method: "POST", body })).body;
  const docs = await create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp?token=store-query-secret",
    headers: { Authorization: "Bearer store-header-secret" },
  });
  const tool = await create({
    name: "tool",
    transport: "stdio",
    command: process.execPath,
    env: { TOKEN: "store-env-secret" },
    confirmStdio: true,
  });
  const login = await create({
    name: "login",
    transport: "http",
    url: "https://login.example.test/mcp",
    auth: "oauth",
  });
  const all = ["claude", "codex", "opencode"];
  const bind = (id, body) => call(`/api/mcp-servers/${id}/clis`, { method: "PUT", body });
  assert.equal((await bind(docs.id, { clis: all })).status, 200);
  assert.equal((await bind(login.id, { clis: all })).status, 200);
  // A stdio server needs the owner's confirmation; only then is it audited as confirmed.
  const refused = await bind(tool.id, { clis: ["codex"] });
  assert.deepEqual(
    [refused.status, refused.body.code],
    [409, "MCP_STDIO_CONFIRMATION_REQUIRED"],
  );
  assert.equal(
    (await bind(tool.id, { clis: ["codex"], confirmStdio: true })).status,
    200,
  );

  // OAuth: Codex reports its state (run on the owner's profile); the others a command.
  // The list never waits for Codex: unknown first, the state once the read landed.
  let list = (await call("/api/mcp-servers")).body;
  await f.application.cliMcp.oauthStatus.settled();
  list = (await call("/api/mcp-servers")).body;
  const oauth = list.find((server) => server.id === login.id).cliStatus;
  assert.deepEqual(oauth.codex.oauth, {
    state: "connected",
    command: "codex mcp login login",
    accounts: [],
  });
  assert.deepEqual(oauth.claude.oauth, { state: "unknown", command: "/mcp" });
  assert.deepEqual(oauth.opencode.oauth, {
    state: "unknown",
    command: "opencode mcp auth login",
  });
  assert.equal(fs.readFileSync(marker, "utf8"), f.home);
  assert.equal(
    list.find((server) => server.id === docs.id).cliStatus.codex.oauth,
    undefined,
  );

  // A hand edit with a new header value, adopted into the central server.
  const native = JSON.parse(fs.readFileSync(files.claude, "utf8"));
  native.mcpServers.docs.headers.Authorization = "Bearer edited-header-secret";
  native.mcpServers.found = {
    type: "http",
    url: "https://found.example.test/mcp?key=native-query-secret",
    headers: { "X-Key": "native-header-secret" },
  };
  fs.writeFileSync(files.claude, JSON.stringify(native));
  const resolved = await call(`/api/mcp-servers/${docs.id}/clis/claude/resolve`, {
    method: "POST",
    body: { choice: "adopt" },
  });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.cliStatus.claude, { status: "written" });
  assert.equal(
    f.application.mcpServers.secrets(docs.id).headers.Authorization,
    "Bearer edited-header-secret",
  );

  fs.appendFileSync(
    files.codex,
    '\n[mcp_servers.helper]\ncommand = "sh"\n[mcp_servers.helper.env]\nTOKEN = "native-env-secret"\n',
  );
  let finds = (await call("/api/mcp-servers/cli-finds")).body.finds;
  const helper = finds.find((find) => find.name === "helper");
  assert.deepEqual(
    [helper.command, helper.envNames, path.isAbsolute(helper.resolvedCommand)],
    ["sh", ["TOKEN"], true],
  );
  const found = finds.find((find) => find.name === "found");
  assert.deepEqual(
    [found.url, found.headerNames],
    ["https://found.example.test/mcp", ["X-Key"]],
  );

  // Several keys: a stale one fails on its own and never hides the adopted one.
  const adopted = await call("/api/mcp-servers/cli-finds/adopt", {
    method: "POST",
    body: { keys: [found.key, "0".repeat(32)] },
  });
  assert.equal(adopted.status, 200);
  assert.deepEqual(
    adopted.body.adopted.map((server) => server.name),
    ["found"],
  );
  assert.deepEqual(adopted.body.failed, [
    {
      key: "0".repeat(32),
      reason: "changed",
      error: adopted.body.failed[0].error,
      messageKey: "mcpServers.cliFindChanged",
    },
  ]);
  const rest = await call("/api/mcp-servers/cli-finds/adopt", {
    method: "POST",
    body: { all: true },
  });
  assert.deepEqual(
    rest.body.adopted.map((server) => [server.name, server.clis]),
    [["helper", ["codex"]]],
  );
  assert.equal(
    (
      await call("/api/mcp-servers/cli-finds/adopt", {
        method: "POST",
        body: { keys: [] },
      })
    ).status,
    400,
  );

  // A file AgentPier cannot read: a stable reason per CLI, server and refused choice.
  fs.mkdirSync(path.dirname(files.opencode), { recursive: true });
  fs.writeFileSync(files.opencode, "{ not json");
  const problems = (await call("/api/mcp-servers/cli-finds")).body.problems;
  assert.deepEqual(problems, [
    {
      cli: "opencode",
      reason: "unreadable",
      messageKey: "mcpServers.cliReasonUnreadable",
    },
  ]);
  const listed = (await call("/api/mcp-servers")).body;
  assert.deepEqual(listed.find((server) => server.id === docs.id).cliStatus.opencode, {
    status: "error",
    reason: "unreadable",
    messageKey: "mcpServers.cliReasonUnreadable",
  });
  const blocked = await call(`/api/mcp-servers/${docs.id}/clis/opencode/resolve`, {
    method: "POST",
    body: { choice: "overwrite" },
  });
  assert.deepEqual(
    [blocked.status, blocked.body.code, blocked.body.messageKey],
    [409, "MCP_CLI_FILE_UNREADABLE", "mcpServers.cliReasonUnreadable"],
  );

  const { events } = (await call("/api/audit")).body;
  const of = (id, action) =>
    events.filter((event) => event.resourceId === id && event.action === action);
  assert.deepEqual(
    of(tool.id, "mcp.updated").map((event) => event.details.stdioConfirmed),
    [true],
  );
  assert.ok(
    of(docs.id, "mcp.updated").some(
      (event) =>
        event.details.resolution === "adopt" &&
        JSON.stringify(event.details.fields) ===
          JSON.stringify(["clis", "url", "auth", "headers"]),
    ),
  );
  for (const text of [...bodies, ...logs])
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${secret} in ${text}`);
});
