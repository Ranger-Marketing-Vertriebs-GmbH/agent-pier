import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mcpSections,
  mcpServerConfig,
  mcpSignature,
  mcpSnapshot,
  mcpStartSnapshot,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import {
  oauthLoginUsable,
  oauthRedirect,
} from "../../server/features/mcp-servers/oauth-redirect.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { mcpApplyFixture } from "../helpers/mcp-apply-fixture.js";

const loopback = "http://127.0.0.1:4391/api/mcp-servers/oauth/callback";
const remote = "https://pier.example.ts.net/api/mcp-servers/oauth/callback";
const personal = { id: "a1", runtimeAgentId: "ap-a1", capabilities: {} };
const headersServer = {
  id: "s-h",
  name: "docs",
  transport: "http",
  url: "https://mcp.example.test/mcp",
  command: null,
  args: [],
  cwd: null,
  auth: "headers",
  oauthScope: null,
};
const oauthServer = {
  ...headersServer,
  id: "s-o",
  name: "linear",
  url: "https://mcp.linear.example/mcp",
  auth: "oauth",
  oauthScope: "read write",
};
const secrets = {
  "s-h": { headers: { Authorization: "Bearer h" }, env: {} },
  "s-o": { headers: {}, env: {} },
};
const inputs = (redirectUrl, servers = [headersServer, oauthServer]) => ({
  servers,
  bindings: { a1: servers.map((server) => server.id) },
  secrets,
  redirectUrl,
});

test("a header server compiles as before, without auth or oauth", () => {
  assert.deepEqual(mcpServerConfig(headersServer, secrets["s-h"], loopback), {
    url: "https://mcp.example.test/mcp",
    transport: "streamable-http",
    headers: { Authorization: "Bearer h" },
  });
});

test("an OAuth server compiles to OpenClaw's verified shape without headers", () => {
  assert.deepEqual(mcpServerConfig(oauthServer, secrets["s-o"], loopback), {
    url: "https://mcp.linear.example/mcp",
    transport: "streamable-http",
    auth: "oauth",
    oauth: { redirectUrl: loopback, scope: "read write" },
  });
  // Stale header secrets never reach an OAuth server; its secrets are not needed.
  const stale = { headers: { Authorization: "Bearer old" }, env: {} };
  assert.equal(mcpServerConfig(oauthServer, stale, loopback).headers, undefined);
  assert.equal(mcpServerConfig(oauthServer, null, loopback).auth, "oauth");
  assert.deepEqual(
    mcpServerConfig({ ...oauthServer, transport: "sse" }, null, remote).transport,
    "sse",
  );
});

test("an empty scope is omitted", () => {
  for (const oauthScope of [null, undefined, "", "  "])
    assert.deepEqual(
      mcpServerConfig({ ...oauthServer, oauthScope }, null, loopback).oauth,
      { redirectUrl: loopback },
    );
});

test("an OAuth server without a redirect URL or on stdio is skipped", () => {
  assert.equal(mcpServerConfig(oauthServer, null), null);
  assert.equal(mcpServerConfig(oauthServer, null, ""), null);
  assert.equal(
    mcpServerConfig({ ...oauthServer, transport: "stdio", url: null }, null, loopback),
    null,
  );
  const warnings = [];
  const snapshot = mcpStartSnapshot(
    { profiles: [personal], mcp: inputs(null) },
    (message) => warnings.push(message),
  );
  assert.deepEqual(snapshot.servers, ["docs"]);
  assert.deepEqual(warnings, ["Skipped MCP servers that cannot be compiled: linear"]);
});

test("the redirect URL prefers the HTTPS remote origin over the loopback listener", () => {
  assert.equal(oauthRedirect({ remoteUrl: null, port: 4391 }), loopback);
  assert.equal(
    oauthRedirect({ remoteUrl: "https://pier.example.ts.net", port: 4391 }),
    remote,
  );
  // Only the origin counts; a path or trailing slash is dropped.
  assert.equal(
    oauthRedirect({ remoteUrl: "https://pier.example.ts.net:8443/x/", port: 1 }),
    "https://pier.example.ts.net:8443/api/mcp-servers/oauth/callback",
  );
  for (const remoteUrl of ["http://pier.example", "not a url", "", undefined])
    assert.equal(oauthRedirect({ remoteUrl, port: 4391 }), loopback);
});

test("a login is usable only where the browser can reach the redirect", () => {
  const https = "https://pier.example.ts.net";
  const ok = { usable: true, reason: null };
  const plain = { usable: false, reason: "plain-http-remote" };
  assert.deepEqual(oauthLoginUsable({ requestOrigin: "http://127.0.0.1:4391" }), ok);
  assert.deepEqual(oauthLoginUsable({ requestOrigin: "http://localhost:4391" }), ok);
  assert.deepEqual(oauthLoginUsable({ requestOrigin: "http://[::1]:4391" }), ok);
  assert.deepEqual(
    oauthLoginUsable({ requestOrigin: "http://127.0.0.1:4391", remoteUrl: https }),
    ok,
  );
  assert.deepEqual(oauthLoginUsable({ requestOrigin: https, remoteUrl: https }), ok);
  assert.deepEqual(
    oauthLoginUsable({ requestOrigin: "http://192.168.1.20:4391", remoteUrl: https }),
    plain,
  );
  assert.deepEqual(oauthLoginUsable({ requestOrigin: "http://pier.lan:4391" }), plain);
  assert.deepEqual(oauthLoginUsable({ requestOrigin: "garbage" }), plain);
  assert.deepEqual(oauthLoginUsable({ requestOrigin: https }), {
    usable: false,
    reason: "loopback-redirect",
  });
});

test("a changed redirect URL changes the signature and the snapshot", () => {
  const before = mcpSections({ profiles: [personal], ...inputs(loopback) });
  const after = mcpSections({ profiles: [personal], ...inputs(remote) });
  assert.notEqual(mcpSignature(after), mcpSignature(before));
  assert.equal(mcpSnapshot(before).redirectUrl, loopback);
  assert.equal(mcpSnapshot(after).redirectUrl, remote);
  // Without a compiled OAuth server the redirect URL is irrelevant.
  const plainBefore = mcpSections({
    profiles: [personal],
    ...inputs(loopback, [headersServer]),
  });
  const plainAfter = mcpSections({
    profiles: [personal],
    ...inputs(remote, [headersServer]),
  });
  assert.equal(mcpSignature(plainAfter), mcpSignature(plainBefore));
  assert.equal(mcpSnapshot(plainBefore).redirectUrl, null);
});

test("readMcpInputs carries the redirect URL with the stored OAuth fields", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-config-"));
  const store = new McpServerStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const created = store.create({
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.example/mcp",
    auth: "oauth",
    oauthScope: "read",
  });
  store.bind(created.id, "agent", "a1");
  const mcp = readMcpInputs(store, { redirectUrl: remote });
  assert.equal(mcp.redirectUrl, remote);
  const sections = mcpSections({ profiles: [personal], ...mcp });
  assert.deepEqual(sections.servers.linear, {
    url: "https://mcp.linear.example/mcp",
    transport: "streamable-http",
    auth: "oauth",
    oauth: { redirectUrl: remote, scope: "read" },
  });
  assert.equal(readMcpInputs(null, { redirectUrl: remote }).redirectUrl, remote);
});

test("a changed AgentPier origin hot-applies through the MCP change path", async (t) => {
  let redirectUrl = loopback;
  const f = mcpApplyFixture(t, { redirectUrl: () => redirectUrl });
  const home = f.agent("Home");
  const docs = f.http({ headers: undefined, auth: "oauth" });
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  await f.service.update(home.id, { mcpServers: [docs.id] }, 1);
  assert.deepEqual(f.gateway.config.mcp.servers.docs, {
    url: "https://mcp.example.com/v1?token=query-secret",
    transport: "streamable-http",
    auth: "oauth",
    oauth: { redirectUrl: loopback },
  });
  const patches = f.gateway.patches.length;
  // Unchanged inputs patch nothing.
  assert.equal(await f.changes.apply(), false);
  redirectUrl = remote;
  assert.equal(await f.changes.apply(), true);
  assert.equal(f.gateway.patches.length, patches + 1);
  assert.deepEqual(f.gateway.config.mcp.servers.docs.oauth, { redirectUrl: remote });
  assert.equal(f.runtime.mcp.redirectUrl, remote);
});
