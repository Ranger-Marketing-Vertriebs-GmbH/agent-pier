import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { AgentPierMcpOAuth } from "../../server/features/mcp-servers/mcp-oauth-agentpier.js";
import { McpOAuthHolders } from "../../server/features/mcp-servers/mcp-oauth-holders.js";
import { mcpRoute } from "../../server/features/mcp-servers/mcp-proxy.js";
import { proxiedServers } from "../../server/features/mcp-servers/mcp-inputs.js";
import { RuntimeProxy } from "../../server/features/model-logins/runtime-proxy.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

const redirectUrl = "http://127.0.0.1:4380/api/mcp-servers/oauth/callback";

/** AgentPier's MCP OAuth and proxy around one fake OAuth MCP server. */
async function agentPierMcp(t, { legacy = {}, everConnected = false, sse = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-agentpier-"));
  const oauth = await oauthMcpServer();
  const server = {
    id: "srv-1",
    name: "docs",
    url: sse ? oauth.sseUrl : oauth.url,
    transport: sse ? "sse" : "http",
    auth: "oauth",
    oauthScope: null,
  };
  const calls = [];
  const servers = {
    get: (id) => (id === server.id ? server : null),
    definitions: () => [server],
    oauthMemory: () => ({ everConnected }),
  };
  const agentpier = new AgentPierMcpOAuth({ dataDir });
  const holders = new McpOAuthHolders({
    legacy: {
      definition: (id) => servers.get(id),
      decorate: async (list) => list.map((s) => ({ ...s, oauthStatus: "connected" })),
      forget: async (id) => calls.push(["forget", id]),
      invalidate: () => {},
      resetBackoff: async () => calls.push(["resetBackoff"]),
      complete: async () => calls.push(["legacy-complete"]),
      beforeRemove: async (id) => calls.push(["legacy-beforeRemove", id]),
      ...legacy,
    },
    agentpier,
    servers,
    redirectUrl: () => redirectUrl,
    reapply: async () => calls.push(["reapply"]),
    warn: () => {},
  });
  const proxy = new RuntimeProxy({ dataDir, warn: () => {} });
  proxy.route(
    "mcp",
    mcpRoute({
      servers: { definition: servers.get },
      oauth: agentpier,
      // Stands in for proxy-access.js: only agent-a is bound to srv-1.
      authorize: (serverId, consumer) => serverId === "srv-1" && consumer === "agent-a",
    }),
  );
  const url = await proxy.start();
  t.after(async () => {
    await proxy.close();
    await oauth.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const login = async () => {
    const started = await holders.start(server.id, {
      requestOrigin: "http://127.0.0.1:4380",
    });
    const callback = await approve(started.authorizationUrl);
    return holders.complete(Object.fromEntries(callback.searchParams));
  };
  // What a runtime compiles: the proxy URL and credential, never the tokens.
  const compiled = () =>
    proxiedServers(
      { servers: [server], secrets: { [server.id]: { headers: {}, env: {} } } },
      {
        url,
        credentialFor: (id) => proxy.credential(["mcp", id, "agent-a"]),
        held: (id) => agentpier.held(id),
      },
    );
  const connect = async () => {
    const {
      servers: [entry],
      secrets,
    } = compiled();
    const client = new Client({ name: "runtime", version: "1" });
    const headers = secrets[server.id].headers;
    await client.connect(
      sse
        ? new SSEClientTransport(new URL(entry.url), {
            requestInit: { headers },
            eventSourceInit: {
              fetch: (url, init) =>
                fetch(url, { ...init, headers: { ...init?.headers, ...headers } }),
            },
          })
        : new StreamableHTTPClientTransport(new URL(entry.url), {
            requestInit: { headers },
          }),
    );
    t.after(() => client.close().catch(() => {}));
    return client;
  };
  return {
    dataDir,
    oauth,
    server,
    agentpier,
    holders,
    proxy,
    url,
    login,
    compiled,
    connect,
    calls,
  };
}

test("AgentPier runs the MCP OAuth login itself and holds the tokens owner-only", async (t) => {
  const { oauth, holders, agentpier, server, dataDir, login, calls } = await agentPierMcp(
    t,
    {
      everConnected: true,
    },
  );
  await assert.rejects(
    holders.start(server.id, { requestOrigin: "http://192.168.1.4:4380" }),
    { code: "plain-http-remote" },
  );
  const done = await login();
  assert.deepEqual(done, { serverId: "srv-1", result: "connected" });
  assert.equal(agentpier.held(server.id), true);
  // Registered as AgentPier's own public client for the existing callback.
  const [client] = [...oauth.clients.values()];
  assert.equal(client.client_name, "AgentPier");
  assert.deepEqual(client.redirect_uris, [redirectUrl]);
  const file = path.join(dataDir, "model-logins", "mcp-oauth.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // OpenClaw's earlier login of this server goes; both runtimes recompile.
  assert.deepEqual(calls, [["forget", "srv-1"], ["reapply"], ["resetBackoff"]]);
  const [decorated] = await holders.decorate([server]);
  assert.equal(decorated.oauthStatus, "connected");
  assert.equal(decorated.oauthHolder, "agentpier");
  // A used state completes nothing a second time (it goes to OpenClaw's own logins).
  await holders.complete({ state: "unknown", code: "x" });
  assert.deepEqual(calls.at(-1), ["legacy-complete"]);
});

test("runtimes reach the server through the proxy with its credential only", async (t) => {
  const { oauth, login, compiled, connect, proxy } = await agentPierMcp(t);
  await login();
  const {
    servers: [entry],
    secrets,
  } = compiled();
  assert.equal(entry.auth, "headers");
  assert.match(entry.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/srv-1$/);
  assert.match(secrets["srv-1"].headers.Authorization, /^Bearer apx1\./);
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "echo"));
  const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
  assert.match(JSON.stringify(result.content), /hi/);
  // Another agent's credential for the same server is refused.
  const other = await fetch(entry.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.credential(["mcp", "srv-1", "agent-b"])}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(other.status, 403);
  // The MCP server saw AgentPier's OAuth token, never the proxy credential.
  const call = oauth.calls.at(-1);
  assert.match(call.bearer, /^at-/);
  assert.ok(!JSON.stringify(oauth.log).includes(proxy.key));
});

test("an expired token is renewed once and replayed; a revoked login asks for a new one", async (t) => {
  const { oauth, login, connect, holders, server, url, proxy } = await agentPierMcp(t);
  await login();
  const client = await connect();
  oauth.expireAccessTokens();
  const result = await client.callTool({ name: "echo", arguments: { text: "renewed" } });
  assert.match(JSON.stringify(result.content), /renewed/);
  const refreshes = oauth.log.filter(
    (e) => e.path === "/token" && e.grant === "refresh_token",
  );
  assert.equal(refreshes.length, 1);
  // Revoked: the runtime gets a plain 401 without WWW-Authenticate, so it never
  // starts an OAuth flow of its own.
  oauth.revokeRefreshTokens();
  oauth.expireAccessTokens();
  const refused = await fetch(`${url}/mcp/srv-1`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.credential(["mcp", "srv-1", "agent-a"])}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("www-authenticate"), null);
  const [decorated] = await holders.decorate([server]);
  assert.equal(decorated.oauthStatus, "login-required");
  // A logout keeps the server AgentPier's: the next login is AgentPier's again.
  await holders.logout(server.id);
  assert.equal((await holders.decorate([server]))[0].oauthHolder, "agentpier");
});

test("a server OpenClaw still holds stays OpenClaw's and is marked for a new login", async (t) => {
  const { holders, server, compiled, calls } = await agentPierMcp(t);
  const [decorated] = await holders.decorate([server]);
  assert.equal(decorated.oauthHolder, "openclaw");
  // Not held: compiled as before, as an OAuth server OpenClaw logs in to.
  assert.equal(compiled().servers[0].auth, "oauth");
  await holders.beforeRemove(server.id);
  assert.deepEqual(calls.at(-1), ["legacy-beforeRemove", "srv-1"]);
});

test("an SSE server's stream and messages pass the proxy; its endpoint stays behind it", async (t) => {
  const { oauth, login, compiled, connect, holders, server } = await agentPierMcp(t, {
    sse: true,
  });
  assert.equal(holders.ours(server), true, "AgentPier logs in to SSE servers too");
  assert.deepEqual(await login(), { serverId: "srv-1", result: "connected" });
  const {
    servers: [entry],
  } = compiled();
  assert.equal(entry.transport, "sse");
  assert.match(entry.url, /\/mcp\/srv-1$/);
  const client = await connect();
  const result = await client.callTool({ name: "echo", arguments: { text: "over-sse" } });
  assert.match(JSON.stringify(result.content), /over-sse/);
  // The message went through the proxy with AgentPier's token.
  assert.match(oauth.calls.at(-1).bearer, /^at-/);
  // An expired token on the stream's messages: renewed once and replayed.
  oauth.expireAccessTokens();
  const again = await client.callTool({ name: "echo", arguments: { text: "renewed" } });
  assert.match(JSON.stringify(again.content), /renewed/);
  assert.deepEqual(
    oauth.log.filter((e) => e.path === "/token").map((e) => e.grant),
    ["authorization_code", "refresh_token"],
  );
});
