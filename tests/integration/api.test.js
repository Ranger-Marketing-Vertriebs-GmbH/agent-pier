import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";
async function fixture(t) {
  const { root: dir, application, url } = await applicationFixture(t);
  return { url, dir, application };
}
const body = (url, data) => ({
  method: "POST",
  headers: { origin: url, "content-type": "application/json" },
  body: JSON.stringify(data),
});
test("HTTP account lifecycle persists, redacts keys and rejects unsafe requests", async (t) => {
  const { url } = await fixture(t);
  let res = await fetch(url + "/api/state");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accounts.length, 4);
  res = await fetch(
    url + "/api/accounts",
    body(url, { tool: "codex", name: "Test", apiKey: "dont-return-this" }),
  );
  assert.equal(res.status, 201);
  const account = await res.json();
  assert.equal(account.hasSecret, true);
  assert.equal(JSON.stringify(account).includes("dont-return-this"), false);
  res = await fetch(
    url + "/api/accounts",
    body("https://evil.example", { tool: "codex", name: "Bad" }),
  );
  assert.equal(res.status, 403);
  res = await fetch(url + "/api/accounts/" + account.id, {
    method: "PATCH",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed" }),
  });
  assert.equal((await res.json()).name, "Renamed");
  res = await fetch(url + "/api/accounts/" + account.id, {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(res.status, 204);
  res = await fetch(url + "/api/accounts/local-codex", {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(res.status, 400);
});
test("session validation never launches absent tool or invalid directory", async (t) => {
  const { url } = await fixture(t);
  let res = await fetch(
    url + "/api/sessions",
    body(url, {
      accountId: "local-codex",
      name: "Test",
      cwd: "/missing-path-tuiui-test",
    }),
  );
  assert.equal(res.status, 400);
  res = await fetch(
    url + "/api/sessions",
    body(url, { accountId: "unknown", name: "Test", cwd: "/tmp" }),
  );
  assert.equal(res.status, 404);
  res = await fetch(url + "/api/state");
  assert.equal((await res.json()).sessions.length, 0);
});
test("directory browser and API errors are useful and private files are not served", async (t) => {
  const { url, dir } = await fixture(t);
  fs.mkdirSync(path.join(dir, "project"));
  const res = await fetch(url + "/api/directories?path=" + encodeURIComponent(dir));
  const listing = await res.json();
  assert.equal(
    listing.entries.some((e) => e.name === "project"),
    true,
  );
  const missing = await fetch(url + "/api/sessions/no-such-session/screen");
  assert.equal(missing.status, 404);
  const secret = await fetch(url + "/.data/accounts.json");
  assert.notEqual(secret.status, 200);
});

test("real websocket terminal replays output and rejects foreign origins", async (t) => {
  const { WebSocket } = await import("ws");
  const { root: dir, application: app, url, cookie } = await applicationFixture(t);
  await app.sessions.create({
    id: "websocket-test",
    name: "Websocket test",
    tool: "codex",
    accountId: "local-codex",
    cwd: dir,
    command: "/bin/sh",
    args: [
      "-c",
      'printf "TERMINAL_READY\\n"; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done',
    ],
    env: { PATH: "/bin:/usr/bin", HOME: dir },
  });
  const ws = new WebSocket(
    url.replace("http:", "ws:") + "/api/sessions/websocket-test/terminal",
    { origin: url, headers: { cookie } },
  );
  let output = "";
  ws.on("message", (data) => {
    const message = JSON.parse(data);
    if (message.type === "output") output += message.data;
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const until = async (predicate) => {
    const end = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > end) throw Error("Terminal output not received");
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  await until(() => output.includes("TERMINAL_READY"));
  ws.send(JSON.stringify({ type: "input", data: "hello websocket\r" }));
  await until(() => output.includes("REPLY:hello websocket"));
  ws.close();
  await new Promise((r) => ws.once("close", r));
  assert.equal((await app.sessions.get("websocket-test")).status, "running");
  const denied = new WebSocket(
    url.replace("http:", "ws:") + "/api/sessions/websocket-test/terminal",
    { origin: "https://evil.example" },
  );
  const error = await new Promise((resolve) => denied.once("error", resolve));
  assert.match(error.message, /403/);
});

test("GitHub endpoints keep token values private and enforce origins for clone requests", async (t) => {
  const { url, dir } = await fixture(t);
  let response = await fetch(
    url + "/api/git-credentials",
    body(url, {
      name: "Enterprise",
      host: "https://example.ghe.com",
      token: "private-github-token",
    }),
  );
  assert.equal(response.status, 201);
  const credential = await response.json();
  assert.equal(credential.hasSecret, true);
  assert.equal(JSON.stringify(credential).includes("private-github-token"), false);
  response = await fetch(url + "/api/repositories");
  const data = await response.json();
  assert.equal(data.credentials[0].host, "https://example.ghe.com");
  assert.deepEqual(data.projects, []);
  assert.equal(JSON.stringify(data).includes("private-github-token"), false);
  response = await fetch(
    url + "/api/repositories/clone",
    body(url, {
      credentialId: credential.id,
      url: "https://evil.example/repo",
      parentDirectory: dir,
      folderName: "never-created",
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(fs.existsSync(path.join(dir, "never-created")), false);
  response = await fetch(url + "/api/git-credentials/" + credential.id, {
    method: "DELETE",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(response.status, 403);
  response = await fetch(url + "/api/git-credentials/" + credential.id, {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(response.status, 204);
});

test("extension routes edit only the selected profile and allow bounded skill uploads above generic JSON limit", async (t) => {
  const { url, dir } = await fixture(t);
  let response = await fetch(
    url + "/api/accounts",
    body(url, { name: "MCP test", tool: "claude" }),
  );
  const account = await response.json();
  const root = `${url}/api/accounts/${account.id}/extensions`;
  response = await fetch(
    root + "/mcp",
    body(url, {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.test/api?key=private-query",
      headers: { Authorization: "private-mcp-header" },
    }),
  );
  assert.equal(response.status, 201);
  response = await fetch(root);
  const listing = await response.json();
  assert.equal(listing.mcp.servers[0].name, "docs");
  assert.ok(!JSON.stringify(listing).includes("private-"));
  assert.ok(listing.mcp.path.startsWith(dir));
  response = await fetch(root + "/mcp", {
    ...body("https://foreign.example", {
      name: "bad",
      transport: "stdio",
      command: "nope",
    }),
  });
  assert.equal(response.status, 403);
  const markdown =
    "---\nname: api-skill\ndescription: Large upload fixture\n---\n" +
    "Documentation only.\n".repeat(5000);
  response = await fetch(
    root + "/skills",
    body(url, {
      fileName: "SKILL.md",
      contentBase64: Buffer.from(markdown).toString("base64"),
    }),
  );
  assert.equal(response.status, 201);
  const skill = await response.json();
  assert.equal(skill.name, "api-skill");
  response = await fetch(root + "/skills/" + skill.id, {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(response.status, 204);
  response = await fetch(root + "/mcp/docs", {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(response.status, 204);
  assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false);
});

test("CLI installation endpoints expose fixed catalog and reject unknown tools and foreign origins", async (t) => {
  const { url } = await fixture(t);
  let res = await fetch(url + "/api/tool-installations");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(
    data.installations.map((x) => x.tool),
    ["codex", "claude", "opencode", "gh"],
  );
  res = await fetch(url + "/api/tools/arbitrary/install", body(url, {}));
  assert.equal(res.status, 400);
  res = await fetch(url + "/api/tools/codex/install", body("https://evil.example", {}));
  assert.equal(res.status, 403);
});

test("GitHub utility stays outside account creation and credential changes synchronize generated agent configs", async (t) => {
  const { url, application } = await fixture(t);
  const synced = [];
  application.github.sync = async () => synced.push("sync");
  let response = await fetch(url + "/api/state");
  const state = await response.json();
  assert.equal(state.utilities[0].id, "gh");
  assert.equal(
    state.tools.some((tool) => tool.id === "gh"),
    false,
  );
  assert.equal(
    state.accounts.some((account) => account.tool === "gh"),
    false,
  );
  response = await fetch(
    url + "/api/accounts",
    body(url, { name: "Not an account", tool: "gh" }),
  );
  assert.equal(response.status, 400);
  response = await fetch(
    url + "/api/git-credentials",
    body(url, {
      name: "Agent GitHub",
      host: "github.com",
      token: "fixture-only-token",
      agentDefault: true,
    }),
  );
  assert.equal(response.status, 201);
  const credential = await response.json();
  assert.equal(credential.agentDefault, true);
  response = await fetch(url + "/api/git-credentials/" + credential.id, {
    ...body(url, { name: "Updated", token: "rotated-fixture-token" }),
    method: "PATCH",
  });
  assert.equal(response.status, 200);
  response = await fetch(url + "/api/git-credentials/" + credential.id, {
    method: "DELETE",
    headers: { origin: url },
  });
  assert.equal(response.status, 204);
  assert.equal(synced.length, 3);
});

test("coding session launch receives its GitHub config and failed launches discard it", async (t) => {
  const { url, dir, application } = await fixture(t);
  const prepared = [],
    discarded = [];
  application.accounts.command = () => ({
    command: "/bin/sh",
    args: [],
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
    launchMode: "default",
  });
  application.github.prepare = async (input) => {
    prepared.push(input);
    return {
      ...input.launch,
      env: { ...input.launch.env, GH_CONFIG_DIR: path.join(dir, "github", input.id) },
    };
  };
  application.github.discard = async (id) => discarded.push(id);
  application.bindings.prepare = async (input) => input.launch;
  application.sessions.create = async (options) => {
    assert.equal(options.env.GH_CONFIG_DIR, path.join(dir, "github", options.id));
    throw new Error("Isolated launch failure");
  };
  const response = await fetch(
    url + "/api/sessions",
    body(url, {
      accountId: "local-codex",
      name: "GitHub fixture",
      cwd: dir,
      agentbus: false,
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].account.tool, "codex");
  assert.deepEqual(discarded, [prepared[0].id]);
});
test("plugin routes enforce account identity, origins and busy-account protection without native mutations", async (t) => {
  const { application: app, url } = await applicationFixture(t);
  let response = await fetch(url + "/api/accounts/absent/plugins");
  assert.equal(response.status, 404);
  response = await fetch(
    url + "/api/accounts/local-codex/plugins",
    body("https://evil.example", { action: "marketplace-add", source: "example/repo" }),
  );
  assert.equal(response.status, 403);
  response = await fetch(
    url + "/api/accounts/absent/plugins",
    body(url, { action: "install", pluginId: "example@market" }),
  );
  assert.equal(response.status, 404);
  const account = app.accounts.create({ name: "Busy fixture", tool: "claude" });
  app.plugins.isBusy = (id) => id === account.id;
  for (const method of ["PATCH", "DELETE"]) {
    response = await fetch(url + "/api/accounts/" + account.id, {
      ...body(url, { name: "Changed" }),
      method,
    });
    assert.equal(response.status, 409);
  }
  assert.equal(app.accounts.get(account.id).name, "Busy fixture");
});

test("browser deep links serve the app while missing assets and APIs keep their 404", async (t) => {
  const { url } = await fixture(t);
  for (const route of [
    "/accounts",
    "/repositories",
    "/settings",
    "/plugins/local-codex",
    "/extensions/local-claude",
    "/sessions/example/reader",
    "/sessions/example/chat",
    "/sessions/example/terminal",
    "/agentbus",
    "/agentbus/messages",
    "/agentbus/messages/demo",
  ]) {
    const response = await fetch(url + route, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /AgentPier/);
  }
  for (const route of ["/assets/missing.js", "/favicon-missing.ico", "/api/missing"]) {
    const response = await fetch(url + route, { headers: { accept: "text/html" } });
    assert.equal(response.status, 404, route);
  }
  const unknown = await fetch(url + "/unknown-page", {
    headers: { accept: "text/html" },
  });
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get("content-type"), /text\/html/);
});

test("AgentBus HTTP history normalizes page parameters without consuming messages", async (t) => {
  const { url, application } = await fixture(t);
  const pages = [];
  application.agentbus.messages = async (id, { page }) => {
    assert.equal(typeof page, "number");
    pages.push(page);
    return { projectId: id, page, pageSize: 20, total: 0, items: [] };
  };
  for (const [query, page] of [
    ["", 1],
    ["?page=1", 1],
    ["?page=2", 2],
  ]) {
    const response = await fetch(url + "/api/agentbus/projects/fixture/messages" + query);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).page, page);
  }
  for (const query of [
    "?page=bad",
    "?page=1&page=2",
    "?page=2.5",
    "?page=90071992547409999",
  ]) {
    const response = await fetch(url + "/api/agentbus/projects/fixture/messages" + query);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(pages, [1, 1, 2]);
});

test("workspace state exposes observed work activity without exposing terminal output", async (t) => {
  const { url, dir, application } = await fixture(t);
  let reads = 0;
  application.sessions.list = async () => [
    {
      id: "activity-fixture",
      name: "Activity fixture",
      tool: "codex",
      accountId: "local-codex",
      cwd: dir,
      status: "running",
    },
  ];
  application.activity.screen = async () => {
    reads++;
    return "PRIVATE_TERMINAL_CONTENT";
  };
  const response = await fetch(url + "/api/state");
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.sessions[0].activity.state, "unknown");
  assert.equal(state.sessions[0].status, "running");
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(state).includes("PRIVATE_TERMINAL_CONTENT"), false);
  await fetch(url + "/api/state");
  assert.equal(reads, 1, "polls within cache lifetime reuse the observation");
});
