import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applicationFixture } from "../helpers/application.js";

async function token(fixture, scopes = ["catalog:read", "runs:read"]) {
  const { application: a, url } = fixture;
  const project = await a.memory.register(fixture.home);
  const registration = await fetch(url + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP HTTP test",
      redirect_uris: ["http://127.0.0.1:23456/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const args = new URLSearchParams({
    client_id,
    redirect_uri: "http://127.0.0.1:23456/callback",
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: a.mcpAccess.status().mcpUrl,
    scope: scopes.join(" "),
  });
  const authorize = await fetch(url + "/authorize?" + args, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const pending = new URL(authorize.headers.get("location")).searchParams.get(
    "authorization",
  );
  const denied = await fetch(url + `/api/mcp-access/authorizations/${pending}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scopes: ["catalog:read"],
      projectIds: [project.id],
      accountIds: [],
      connectionIds: [],
    }),
  });
  assert.equal(denied.status, 403, "owner consent still requires Origin");
  const response = await fixture.request(
    `/api/mcp-access/authorizations/${pending}/approve`,
    {
      method: "POST",
      body: {
        scopes,
        projectIds: [project.id],
        accountIds: ["local-codex"],
        connectionIds: [],
      },
    },
  );
  assert.equal(response.status, 200);
  const { redirectUrl } = await response.json();
  const code = new URL(redirectUrl).searchParams.get("code");
  const exchange = await fetch(url + "/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      redirect_uri: "http://127.0.0.1:23456/callback",
      code,
      code_verifier: verifier,
      resource: a.mcpAccess.status().mcpUrl,
    }),
  });
  assert.equal(exchange.status, 200);
  return { token: (await exchange.json()).access_token, project };
}

test("remote MCP uses OAuth discovery and an actual HTTP client with resource grants", async (t) => {
  const fixture = await applicationFixture(t, {
    remoteUrl: "https://agentpier.example",
    ownerLogin: "owner@example.com",
  });
  const challenge = await fetch(fixture.url + "/mcp");
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate"), /oauth-protected-resource/);
  const metadata = await fetch(fixture.url + "/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, "https://agentpier.example/mcp");
  const access = await token(fixture);
  const client = new Client({ name: "integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "projects_list"));
  assert.ok(!tools.tools.some((tool) => tool.name === "run_start"));
  const projects = await client.callTool({ name: "projects_list", arguments: {} });
  assert.equal(projects.isError, undefined);
  assert.deepEqual(
    projects.structuredContent.items.map((item) => item.id),
    [access.project.id],
  );
  const forbidden = await fetch(fixture.url + "/api/state", {
    headers: { Authorization: `Bearer ${access.token}` },
  });
  assert.equal(forbidden.status, 403, "MCP bearer cannot become owner API auth");
  const grant = fixture.application.mcpAccess.listGrants().grants[0];
  await fixture.request(`/api/mcp-access/grants/${grant.id}/revoke`, {
    method: "POST",
    body: {},
  });
  const revoked = await fetch(fixture.url + "/mcp", {
    headers: { Authorization: `Bearer ${access.token}` },
  });
  assert.equal(revoked.status, 401);
});

test("local MCP uses the actual HTTP port while preserving host/origin boundaries", async (t) => {
  const fixture = await applicationFixture(t);
  assert.equal((await fetch(fixture.url + "/mcp")).status, 401);
  const statusResponse = await fixture.request("/api/mcp-access");
  const localStatus = await statusResponse.json();
  assert.equal(localStatus.available, true);
  assert.equal(localStatus.mcpUrl, fixture.url + "/mcp");
  const discovery = await fetch(fixture.url + "/.well-known/oauth-authorization-server");
  assert.equal((await discovery.json()).issuer, fixture.url + "/");
  const rootDiscovery = await fetch(
    fixture.url + "/.well-known/oauth-protected-resource",
  );
  assert.equal((await rootDiscovery.json()).resource, localStatus.mcpUrl);
  const access = await token(fixture);
  const client = new Client({ name: "local-http", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(localStatus.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
    }),
  );
  assert.ok(
    (await client.listTools()).tools.some((tool) => tool.name === "projects_list"),
  );
  const cross = await fetch(fixture.url + "/mcp", {
    headers: { Origin: "https://foreign.example" },
  });
  assert.equal(cross.status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      fixture.url + "/.well-known/oauth-protected-resource/mcp",
      { headers: { Host: "foreign.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(status, 403);
});

async function waitForQueue(barrier, count) {
  const deadline = Date.now() + 3000;
  while (barrier.queue.length < count && Date.now() < deadline) await pause(1);
  assert.ok(barrier.queue.length >= count, "Requests reached the held mutation lease");
}

test("MCP rechecks revoked tokens after waiting for a mutation lease", async (t) => {
  const fixture = await applicationFixture(t, { remoteUrl: "https://agentpier.example" });
  const a = fixture.application;
  const access = await token(fixture, ["catalog:read", "definitions:write"]);
  const client = new Client({ name: "queued-revocation", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(fixture.url + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
    }),
  );
  const grant = a.mcpAccess.listGrants().grants[0];
  const existing = {
    name: "Allowed",
    enabled: true,
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Build", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  };
  let release;
  const snapshot = a.mutationBarrier.snapshot(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await pause(1);
  let revoke, mutation;
  try {
    revoke = fixture.request(`/api/mcp-access/grants/${grant.id}/revoke`, {
      method: "POST",
      body: {},
    });
    await waitForQueue(a.mutationBarrier, 1);
    mutation = client.callTool({
      name: "profile_save",
      arguments: { profile: { ...existing, name: "Must not be saved after revocation" } },
    });
    await waitForQueue(a.mutationBarrier, 2);
  } finally {
    release();
  }
  await snapshot;
  assert.equal((await revoke).status, 200);
  assert.equal((await mutation).isError, true);
  assert.ok(
    !a.pipelineDefinitions
      .listProfiles()
      .some((profile) => profile.name === "Must not be saved after revocation"),
  );
});

test("MCP reads large Unicode artifacts and diffs within the full response envelope limit", async (t) => {
  const fixture = await applicationFixture(t, { remoteUrl: "https://agentpier.example" });
  const a = fixture.application;
  const execute = promisify(execFile);
  const git = (args) =>
    execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: fixture.home,
      env: {
        PATH: process.env.PATH,
        HOME: fixture.home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await git(["init", "--quiet"]);
  await fs.writeFile(path.join(fixture.home, "evidence.txt"), "original evidence\n");
  await git(["add", "evidence.txt"]);
  await git([
    "-c",
    "user.name=MCP Test",
    "-c",
    "user.email=mcp@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ]);
  const access = await token(fixture);
  const profile = a.pipelineDefinitions.saveProfile({
    name: "Evidence",
    enabled: true,
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Inspect", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  });
  const pipeline = a.pipelineDefinitions.savePipeline({
    name: "Evidence",
    graph: {
      entry: "build",
      nodes: [{ id: "build", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  a.pipelines.driver = {
    async start(input) {
      return { sessionId: input.sessionId };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {},
  };
  const run = await a.pipelines.start(
    { pipelineId: pipeline.id, cwd: fixture.home, task: "Evidence" },
    { expectedProjectId: access.project.id },
  );
  assert.equal(run.status, "running");
  assert.equal(run.projectId, access.project.id);
  const evidence = '😀\\"漢字\n'.repeat(100000);
  await fs.writeFile(path.join(run.workingDir, "evidence.txt"), evidence);
  run.executionLog[0].finishedAt = new Date().toISOString();
  run.executionLog[0].verdict = { artifacts: [{ path: "evidence.txt" }] };
  a.pipelines.store.save(run);
  const client = new Client({ name: "large-evidence", version: "1.0.0" });
  t.after(() => client.close());
  const envelopes = [];
  await client.connect(
    new StreamableHTTPClientTransport(new URL(fixture.url + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${access.token}` } },
      fetch: async (...args) => {
        const response = await fetch(...args);
        envelopes.push(await response.clone().text());
        return response;
      },
    }),
  );
  for (const [name, field] of [
    ["run_artifact", "text"],
    ["run_diff", "diff"],
  ]) {
    const result = await client.callTool({
      name,
      arguments: {
        runId: run.id,
        nodeId: "build",
        ...(name === "run_artifact" ? { path: "evidence.txt" } : {}),
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.truncated, true);
    assert.ok(result.structuredContent[field].includes("漢字"));
    assert.equal(result.structuredContent[field].isWellFormed(), true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(Buffer.byteLength(envelopes.at(-1)) < 262144);
  }
});

test("non-owner tailnet clients can discover MCP but cannot administer grants", async (t) => {
  const fixture = await applicationFixture(t, {
    remoteUrl: "https://agentpier.example",
    ownerLogin: "owner@example.com",
  });
  const request = (route, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        fixture.url + route,
        {
          method,
          headers: {
            Host: "agentpier.example",
            "Tailscale-User-Login": "another@example.com",
            Origin: "https://agentpier.example",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  assert.equal(await request("/.well-known/oauth-protected-resource/mcp"), 200);
  assert.equal(await request("/mcp"), 401);
  for (const route of ["/api/mcp-access", "/api/mcp-access/grants", "/settings/mcp"])
    assert.equal(await request(route), 403);
  assert.equal(
    await request("/api/mcp-access/authorizations/pending/approve", "POST"),
    403,
  );
});
