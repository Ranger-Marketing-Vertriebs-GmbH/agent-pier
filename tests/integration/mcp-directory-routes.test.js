import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { McpDirectory } from "../../server/features/mcp-directory/client.js";
import { Preferences } from "../../server/features/settings/preferences.js";
import { mcpDirectoryRoutes } from "../../server/http/routes/mcp-directory.js";
import { workspaceRoutes } from "../../server/http/routes/workspace.js";
import { registerResponses } from "../../server/http/responses.js";
import { fakeRegistry } from "../helpers/fake-mcp-registry.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

async function app(t, registry) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-directory-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const preferences = new Preferences({ dataDir, home: dataDir });
  await preferences.update({ mcpDirectory: { baseUrl: registry.baseUrl } });
  const mcpDirectory = new McpDirectory({
    settings: () => preferences.get().mcpDirectory,
    log: () => {},
    deadlineMs: 300,
  });
  const services = { preferences, mcpDirectory };
  const application = express();
  application.use(express.json());
  application.use("/api", mcpDirectoryRoutes(services));
  application.use(
    "/api",
    workspaceRoutes({
      ...services,
      config: { home: dataDir, dataDir },
      tools: () => [],
      accounts: { list: () => [] },
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const request = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
  return { request, preferences, mcpDirectory };
}

const searches = (registry) =>
  registry.requests.filter((entry) => entry.path === "/v0.1/servers").length;

test("search, detail and status go through the configured registry", async (t) => {
  const registry = await fakeRegistry(t, {
    "/v0.1/servers": () => ({
      body: { servers: [fixture("opnsense"), fixture("deleted")], metadata: {} },
    }),
    "/v0.1/servers/io.github.example%2Fopnsense-mcp-server/versions/latest": () => ({
      body: fixture("opnsense"),
    }),
    "/v0.1/health": () => ({ body: { status: "ok" } }),
  });
  const { request } = await app(t, registry);
  const status = await request("GET", "/api/mcp-directory/status");
  assert.deepEqual(status.body, {
    enabled: true,
    host: new URL(registry.baseUrl).host,
    reachable: true,
  });
  assert.equal(status.cache, "no-store");
  const list = await request(
    "GET",
    "/api/mcp-directory/servers?search=%20%20OPNsense%20",
  );
  assert.equal(list.cache, "no-store");
  assert.deepEqual(
    list.body.entries.map((e) => e.name),
    ["io.github.example/opnsense-mcp-server"],
  );
  assert.equal(
    registry.requests.find((r) => r.path === "/v0.1/servers").query.search,
    "opnsense",
  );
  // A name with a slash and dots travels as one encoded path segment both ways.
  const detail = await request(
    "GET",
    `/api/mcp-directory/servers/${encodeURIComponent("io.github.example/opnsense-mcp-server")}`,
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.cache, "no-store");
  assert.equal(detail.body.options[0].kind, "npm");
  for (const entry of registry.requests) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers.cookie, undefined);
    assert.equal(entry.headers.accept, "application/json");
  }
});

test("errors: 404, invalid detail, malformed JSON, oversize, timeout, redirect, 429 cache", async (t) => {
  let calls429 = 0;
  const registry = await fakeRegistry(t, {
    "/v0.1/servers/a.b%2Fmissing/versions/latest": () => ({ status: 404 }),
    "/v0.1/servers/a.b%2Finvalid/versions/latest": () => ({
      body: { server: { name: 3 } },
    }),
    "/v0.1/servers/a.b%2Fmalformed/versions/latest": () => ({ body: "{nope" }),
    "/v0.1/servers/a.b%2Fhuge/versions/latest": () => ({ body: "x".repeat(600 * 1024) }),
    "/v0.1/servers/a.b%2Fslow/versions/latest": () => ({ delay: 1000 }),
    "/v0.1/servers/a.b%2Fmoved/versions/latest": () => ({
      status: 302,
      headers: { location: "https://evil.test/" },
    }),
    "/v0.1/servers": () => {
      calls429 += 1;
      return { status: 429 };
    },
  });
  const { request } = await app(t, registry);
  const detail = (name) =>
    request("GET", `/api/mcp-directory/servers/${encodeURIComponent(`a.b/${name}`)}`);
  const missing = await detail("missing");
  assert.deepEqual(
    [missing.status, missing.body.code, missing.cache],
    [404, "MCP_DIRECTORY_NOT_FOUND", "no-store"],
  );
  const invalid = await detail("invalid");
  assert.deepEqual([invalid.status, invalid.body.code], [502, "MCP_DIRECTORY_INVALID"]);
  for (const name of ["malformed", "huge", "slow", "moved"]) {
    const answer = await detail(name);
    assert.deepEqual(
      [answer.status, answer.body.code],
      [503, "MCP_DIRECTORY_UNAVAILABLE"],
      name,
    );
  }
  assert.equal(
    registry.requests.some((entry) => !entry.path.startsWith("/v0.1/")),
    false,
    "the redirect is never followed",
  );
  const first = await request("GET", "/api/mcp-directory/servers?search=a");
  assert.deepEqual([first.status, first.body.code], [503, "MCP_DIRECTORY_UNAVAILABLE"]);
  await request("GET", "/api/mcp-directory/servers?search=a");
  assert.equal(calls429, 1);
});

test("the setting: validation, disabled 409, cache cleared on change", async (t) => {
  const registry = await fakeRegistry(t, {
    "/v0.1/servers": () => ({ body: { servers: [fixture("opnsense")], metadata: {} } }),
  });
  const { request, preferences } = await app(t, registry);
  for (const baseUrl of [
    "http://example.test",
    "https://u:p@x.test",
    "https://x.test/?q=1",
    5,
  ])
    assert.equal(
      (await request("PATCH", "/api/preferences", { mcpDirectory: { baseUrl } })).status,
      400,
      String(baseUrl),
    );
  for (const mcpDirectory of [{ extra: 1 }, { enabled: "yes" }, null, [], "on"])
    assert.equal(
      (await request("PATCH", "/api/preferences", { mcpDirectory })).status,
      400,
      JSON.stringify(mcpDirectory),
    );
  assert.equal(preferences.get().mcpDirectory.baseUrl, registry.baseUrl);
  await request("GET", "/api/mcp-directory/servers?search=x");
  await request("GET", "/api/mcp-directory/servers?search=x");
  assert.equal(searches(registry), 1);
  const off = await request("PATCH", "/api/preferences", {
    mcpDirectory: { enabled: false },
  });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.mcpDirectory, { enabled: false, baseUrl: registry.baseUrl });
  const refused = await request("GET", "/api/mcp-directory/servers?search=x");
  assert.deepEqual(
    [refused.status, refused.body.code, refused.cache],
    [409, "MCP_DIRECTORY_DISABLED", "no-store"],
  );
  assert.deepEqual((await request("GET", "/api/mcp-directory/status")).body, {
    enabled: false,
    host: new URL(registry.baseUrl).host,
    reachable: false,
  });
  await request("PATCH", "/api/preferences", { mcpDirectory: { enabled: true } });
  await request("GET", "/api/mcp-directory/servers?search=x");
  assert.equal(searches(registry), 2);
  const reset = await request("PATCH", "/api/preferences", {
    mcpDirectory: { baseUrl: null },
  });
  assert.deepEqual(reset.body.mcpDirectory, {
    enabled: true,
    baseUrl: "https://registry.modelcontextprotocol.io",
  });
});

test("a search in flight while the setting is switched off leaves the cache empty", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const arrived = new Promise((resolve) => {
    started = resolve;
  });
  const registry = await fakeRegistry(t, {
    "/v0.1/servers": async () => {
      if (searches(registry) === 1) {
        started();
        await gate;
      }
      return { body: { servers: [fixture("opnsense")], metadata: {} } };
    },
  });
  const { request, mcpDirectory } = await app(t, registry);
  const inFlight = request("GET", "/api/mcp-directory/servers?search=opn");
  await arrived;
  await request("PATCH", "/api/preferences", { mcpDirectory: { enabled: false } });
  release();
  // The answer that was already on its way may still arrive …
  assert.equal((await inFlight).status, 200);
  // … but the next request is refused, and the late answer was not cached.
  const refused = await request("GET", "/api/mcp-directory/servers?search=opn");
  assert.deepEqual([refused.status, refused.body.code], [409, "MCP_DIRECTORY_DISABLED"]);
  assert.equal(mcpDirectory.cache.size, 0);
  await request("PATCH", "/api/preferences", { mcpDirectory: { enabled: true } });
  assert.equal(
    (await request("GET", "/api/mcp-directory/servers?search=opn")).status,
    200,
  );
  assert.equal(searches(registry), 2);
});
