import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { createMcpCli } from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import {
  mcpServerConfig,
  mcpServerSignature,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const fakeEntry = fileURLToPath(
  new URL("../fixtures/fake-openclaw-mcp.mjs", import.meta.url),
);
const remoteHost = "agentpier.example";
const owner = "owner@example.test";
const redirect = `https://${remoteHost}/api/mcp-servers/oauth/callback`;
// The provider's redirect back: a top-level navigation from another site.
const navigation = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

/** A raw request, so Host and Tailscale headers reach AgentPier as a proxy sends them. */
function raw(base, endpoint, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + endpoint, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup(t, extra = {}) {
  const f = await applicationFixture(t, {
    ...enabledAssistants,
    remoteUrl: `https://${remoteHost}`,
    ownerLogin: owner,
    ...extra,
  });
  const log = path.join(f.root, "cli.log");
  const env = {
    PATH: process.env.PATH,
    HOME: f.home,
    OPENCLAW_STATE_DIR: path.join(f.root, "openclaw-state"),
    FAKE_OPENCLAW_LOG: log,
    FAKE_OPENCLAW_STATE: "11111111-1111-4111-8111-111111111111",
  };
  const oauth = f.application.assistantMcpOAuth;
  oauth.cli = createMcpCli({
    runtime: { nodePath: process.execPath, entryPath: fakeEntry, cwd: f.root },
    environment: () => env,
  });
  const created = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com/v1",
      auth: "oauth",
    },
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  // The running Gateway compiled the server (the fixture starts no Gateway).
  const compiled = (name) => {
    const definition = f.application.assistantMcpServers
      .definitions()
      .find((d) => d.name === name);
    const config = mcpServerConfig(definition, null, redirect);
    f.application.assistantRuntime.mcp = {
      servers: [name],
      serverSignatures: { [name]: mcpServerSignature(config) },
      redirectUrl: redirect,
    };
  };
  compiled("docs");
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const start = (state, origin = f.url) => {
    env.FAKE_OPENCLAW_STATE = state;
    return f.request(`/api/mcp-servers/${server.id}/oauth/login`, {
      method: "POST",
      origin,
    });
  };
  const local = (query, headers = navigation) =>
    raw(f.url, `/api/mcp-servers/oauth/callback?${new URLSearchParams(query)}`, headers);
  const remote = (query) =>
    local(query, {
      ...navigation,
      host: remoteHost,
      "tailscale-user-login": owner,
    });
  return { f, env, server, calls, start, local, remote, compiled };
}

const invalidState = "/accounts?oauth=error&reason=state-invalid";

const codes = (calls) => calls.filter((args) => args.some((a) => a.startsWith("--code")));

test("an OAuth login completes through the callback by its state alone", async (t) => {
  const { f, server, calls, start, local, remote } = await setup(t);
  const stateA = "aaaaaaaa-1111-4111-8111-111111111111";
  const stateB = "bbbbbbbb-1111-4111-8111-111111111111";

  // Starting needs the owner session.
  const anonymous = await fetch(`${f.url}/api/mcp-servers/${server.id}/oauth/login`, {
    method: "POST",
    headers: { origin: f.url },
  });
  assert.equal(anonymous.status, 401);
  const started = await start(stateA);
  assert.equal(started.status, 200);
  const body = await started.json();
  assert.equal(body.status, "authorize");
  assert.equal(new URL(body.authorizationUrl).searchParams.get("state"), stateA);
  assert.deepEqual(calls(), [["login", "docs"]]);

  // Wrong or missing state: back to Accounts with a stable reason, no session
  // needed, and no --code run.
  for (const query of [{ state: "wrong", code: "c" }, { code: "c" }, {}]) {
    const refused = await local(query);
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.location, invalidState);
  }
  assert.deepEqual(codes(calls()), []);

  // The provider's redirect on the HTTPS remote host, without a session cookie.
  const done = await remote({ code: "code-1", state: stateA });
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, `/accounts?oauth=connected&server=${server.id}`);
  assert.ok(!done.body.includes("code-1"));
  assert.deepEqual(codes(calls()), [["login", "docs", "--code=code-1"]]);
  // Single use.
  assert.equal(
    (await remote({ code: "code-1", state: stateA })).headers.location,
    invalidState,
  );

  // A second start replaces the first; the callback also works on 127.0.0.1.
  await start(stateA);
  await start(stateB);
  assert.equal(
    (await local({ code: "code-2", state: stateA })).headers.location,
    invalidState,
  );
  const second = await local({ code: "code-3", state: stateB });
  assert.equal(second.status, 303);
  assert.match(second.headers.location, /oauth=connected/);
  assert.deepEqual(
    codes(calls()).map((args) => args[2]),
    ["--code=code-1", "--code=code-3"],
  );

  // A provider error comes back as a stable reason only.
  await start(stateA);
  const denied = await local({ error: "access_denied", state: stateA, x: "<b>" });
  assert.equal(
    denied.headers.location,
    `/accounts?oauth=error&server=${server.id}&reason=access_denied`,
  );
  // A cross-site fetch (not a navigation) never reaches the callback.
  await start(stateB);
  const fetched = await local(
    { code: "c", state: stateB },
    {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
  );
  assert.equal(fetched.status, 403);
  assert.equal(codes(calls()).length, 2);
});

test("the list carries the status; logout and lifecycle changes log out first", async (t) => {
  const { f, server, calls, start, compiled } = await setup(t);
  const list = async () => (await f.request("/api/mcp-servers")).json();
  const statusCalls = () => calls().filter(([command]) => command === "status").length;
  const [docs] = await list();
  assert.equal(docs.oauthStatus, "connected");
  assert.equal(docs.oauthExpiresAt, 1791234567890);
  await list();
  assert.equal(statusCalls(), 1, "cached");

  const loggedOut = await f.request(`/api/mcp-servers/${server.id}/oauth/logout`, {
    method: "POST",
  });
  assert.equal(loggedOut.status, 204);
  assert.deepEqual(calls().at(-1), ["logout", "docs"]);
  await list();
  assert.equal(statusCalls(), 2, "invalidated by the logout");

  // Plain-HTTP network origins never start a login (the security layer already
  // refuses a foreign origin; the service refuses a plain network one).
  const before = calls().length;
  const foreign = await start("x", "http://192.168.1.20:4380");
  assert.equal(foreign.status, 403);
  assert.equal(calls().length, before);

  // Rename: logout under the old name before the store changes.
  const renamed = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 1, name: "renamed" },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls().at(-1), ["logout", "docs"]);
  compiled("renamed");
  // Switch to headers: logout under the current name.
  const switched = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 2, auth: "headers", headers: { Authorization: "Bearer t" } },
  });
  assert.equal(switched.status, 200);
  assert.deepEqual(calls().at(-1), ["logout", "renamed"]);
  const logouts = calls().filter(([command]) => command === "logout").length;
  // A header server has no login to remove when deleted.
  // Pending: the fixture runs no Gateway to apply to.
  assert.deepEqual(
    await (await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" })).json(),
    { pending: true },
  );
  assert.equal(calls().filter(([command]) => command === "logout").length, logouts);
});

test("MCP logouts keep backup keys; a rollback queues them again", async (t) => {
  const { f, server, calls } = await setup(t);
  // Host backups hold no MCP login, so their sealed credentials stay restorable.
  const keys = path.join(f.dataDir, "assistants", "backup-keys");
  fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
  const key = path.join(keys, "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01.key");
  fs.writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 });
  const since = Date.now();
  f.application.assistantMcpServers.rememberOAuth(server.id, { connected: true });
  const loggedOut = await f.request(`/api/mcp-servers/${server.id}/oauth/logout`, {
    method: "POST",
  });
  assert.equal(loggedOut.status, 204);
  const renamed = await f.request(`/api/mcp-servers/${server.id}`, {
    method: "PUT",
    body: { revision: 1, name: "renamed" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(calls().filter(([command]) => command === "logout").length, 2);
  assert.equal(fs.existsSync(key), true);
  // The update rollback hook reaches the login service before the Gateway starts.
  await f.application.assistantUpdates.onRolledBack({ createdAt: since });
  const oauth = f.application.assistantMcpOAuth;
  clearTimeout(oauth.drainTimer);
  oauth.drainTimer = null;
  assert.deepEqual(
    f.application.assistantMcpServers.deferredLogouts().map((d) => d.name),
    ["docs"],
  );
});

test("deleting an OAuth server logs it out, or defers that with a warning", async (t) => {
  const { f, env, server, calls } = await setup(t);
  const removed = await f.request(`/api/mcp-servers/${server.id}`, { method: "DELETE" });
  assert.deepEqual(await removed.json(), { pending: true });
  assert.deepEqual(calls(), [["logout", "docs"]]);

  // A failing CLI never blocks the owner: the change is saved with a warning.
  env.FAKE_OPENCLAW_MODE = "fail-generic";
  const again = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "docs",
      transport: "http",
      url: "https://mcp.example.com/v1",
      auth: "oauth",
    },
  });
  const { id } = await again.json();
  const renamed = await f.request(`/api/mcp-servers/${id}`, {
    method: "PUT",
    body: { revision: 1, name: "renamed" },
  });
  assert.equal(renamed.status, 200);
  const body = await renamed.json();
  assert.equal(body.name, "renamed");
  assert.equal(body.oauthWarning.code, "oauth-logout-deferred");
  assert.equal(body.oauthWarning.messageKey, "mcpServers.oauthLogoutDeferred");
  const deleted = await f.request(`/api/mcp-servers/${id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).oauthWarning.code, "oauth-logout-deferred");
  assert.equal(f.application.assistantMcpServers.deferredLogouts().length, 2);
});

test("the callback is audited, refuses HEAD and waits out an exclusive barrier", async (t) => {
  const { f, server, calls, start, local } = await setup(t);
  const state = "cccccccc-1111-4111-8111-111111111111";
  await start(state);
  // HEAD never consumes a state.
  const head = await new Promise((resolve, reject) => {
    const req = http.request(
      `${f.url}/api/mcp-servers/oauth/callback?state=${state}&code=h`,
      { method: "HEAD" },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(head, 405);
  // While a snapshot holds the barrier the callback answers "unavailable".
  f.application.mutationBarrier.exclusive = true;
  const blocked = await local({ state, code: "b" });
  f.application.mutationBarrier.exclusive = false;
  assert.equal(blocked.headers.location, "/accounts?oauth=error&reason=unavailable");
  assert.deepEqual(codes(calls()), []);
  const done = await local({ state, code: "secret-code" });
  assert.match(done.headers.location, /oauth=connected/);
  const events = JSON.stringify(f.application.audit.list({}));
  assert.match(events, /"action":"mcp\.completed"/);
  assert.ok(events.includes(server.id));
  assert.ok(!events.includes("secret-code") && !events.includes(state));
  // A failure is audited with its stable reason.
  await start(state);
  await local({ state, error: "access_denied" });
  assert.match(
    JSON.stringify(f.application.audit.list({})),
    /"failReason":"access-denied"/,
  );
});

test("a callback whose --code failed after saving the tokens reports the login", async (t) => {
  const { f, env, server, start, local } = await setup(t);
  const audited = () => JSON.stringify(f.application.audit.list({}));
  // The CLI fails, but OpenClaw's status reads authorized: the login counts.
  await start("dddddddd-1111-4111-8111-111111111111");
  env.FAKE_OPENCLAW_MODE = "code-fails";
  const saved = await local({ state: "dddddddd-1111-4111-8111-111111111111", code: "c" });
  assert.equal(saved.headers.location, `/accounts?oauth=connected&server=${server.id}`);
  assert.match(audited(), /"action":"mcp\.completed"/);
  assert.equal(
    f.application.assistantMcpServers.oauthMemory(server.id).everConnected,
    true,
  );
  // Without saved tokens the failure stands.
  env.FAKE_OPENCLAW_MODE = "ok";
  await start("eeeeeeee-1111-4111-8111-111111111111");
  env.FAKE_OPENCLAW_MODE = "code-fails-unsaved";
  const failed = await local({
    state: "eeeeeeee-1111-4111-8111-111111111111",
    code: "c",
  });
  assert.equal(
    failed.headers.location,
    `/accounts?oauth=error&server=${server.id}&reason=cli-failed`,
  );
  assert.match(audited(), /"failReason":"cli-failed"/);
});

test("the callback refuses the plain network host", async (t) => {
  const { f } = await setup(t, {
    network: { enabled: true, bind: "127.0.0.1", hosts: ["agentpier.home.arpa"] },
  });
  const port = new URL(f.url).port;
  const refused = await raw(f.url, "/api/mcp-servers/oauth/callback?state=s&code=c", {
    ...navigation,
    host: `agentpier.home.arpa:${port}`,
  });
  assert.equal(refused.status, 303);
  assert.equal(
    refused.headers.location,
    "/accounts?oauth=error&reason=plain-http-remote",
  );
});

test("a callback after an AgentPier restart reports an invalid state", async (t) => {
  const { f, calls, start } = await setup(t);
  const state = "dddddddd-1111-4111-8111-111111111111";
  assert.equal((await start(state)).status, 200);
  // Pending logins live in memory only.
  await f.restart();
  const after = await raw(
    f.url,
    `/api/mcp-servers/oauth/callback?${new URLSearchParams({ state, code: "c" })}`,
    navigation,
  );
  assert.equal(after.status, 303);
  assert.equal(after.headers.location, invalidState);
  assert.deepEqual(codes(calls()), []);
});

test("OAuth logins and logouts share one owner rate limit", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const statuses = [];
  for (let i = 0; i < 30; i += 1) {
    const endpoint = `/api/mcp-servers/missing/oauth/${i % 2 ? "logout" : "login"}`;
    statuses.push((await f.request(endpoint, { method: "POST" })).status);
  }
  assert.equal(statuses.includes(429), false);
  const limited = await f.request("/api/mcp-servers/missing/oauth/login", {
    method: "POST",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  const body = await limited.json();
  assert.equal(body.code, "oauth-rate-limited");
  assert.equal(body.messageKey, "mcpServers.oauthRateLimited");
});
