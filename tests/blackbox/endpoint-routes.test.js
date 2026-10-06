import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { EndpointTester } from "../../server/features/providers/endpoint-tester.js";
import { providerConnectionRoutes } from "../../server/http/routes/provider-connections.js";
import { requestAudit } from "../../server/features/audit/audit-http.js";
import { fakeEndpoint, ollamaRoutes } from "../helpers/endpoint-servers.js";

async function app(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-endpoint-http-"));
  const providerConnections = new ProviderConnections({ dataDir });
  const endpointTester = new EndpointTester({ connections: providerConnections });
  const application = express();
  application.use(
    express.json(),
    providerConnectionRoutes({ providerConnections, endpointTester }),
  );
  application.use((error, _request, response, _next) =>
    response.status(error.status || 500).json({ error: error.message }),
  );
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (route, method = "GET", body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request, base, providerConnections, endpointTester };
}

test("test route returns a proposal and never persists", async (t) => {
  const upstream = await fakeEndpoint(t, ollamaRoutes());
  const { request, providerConnections } = await app(t);
  const endpoint = {
    preset: "ollama",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: upstream.base,
    authHeader: null,
  };
  const response = await request("/provider-connections/test", "POST", { endpoint });
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.equal(proposal.protocols.chatCompletions, "ok");
  assert.equal(providerConnections.list().length, 0);
});

test("stored key is only reused for the same origins and only for endpoint connections", async (t) => {
  const upstream = await fakeEndpoint(t, ollamaRoutes());
  const { request, providerConnections } = await app(t);
  const endpoint = {
    preset: "ollama",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: upstream.base,
    authHeader: null,
  };
  const saved = providerConnections.create({
    name: "GPU",
    providerId: "endpoint",
    apiKey: "stored-key",
    endpoint: {
      ...endpoint,
      protocols: { messages: true, responses: true, chatCompletions: true },
      models: [],
      lastTest: null,
    },
  });
  await request("/provider-connections/test", "POST", {
    connectionId: saved.id,
    endpoint,
  });
  assert.equal(upstream.seen[0].headers.authorization, "Bearer stored-key");
  upstream.seen.length = 0;
  const other = await fakeEndpoint(t, ollamaRoutes());
  const moved = {
    ...endpoint,
    openaiBaseUrl: `${other.base}/v1`,
    anthropicBaseUrl: other.base,
  };
  const result = await (
    await request("/provider-connections/test", "POST", {
      connectionId: saved.id,
      endpoint: moved,
    })
  ).json();
  assert.ok(result.warnings.includes("storedKeyNotUsed"));
  assert.equal(
    other.seen.every((entry) => entry.headers.authorization === undefined),
    true,
  );
  const router = providerConnections.create({
    name: "R",
    providerId: "openrouter",
    apiKey: "router-key",
  });
  assert.equal(
    (
      await request("/provider-connections/test", "POST", {
        connectionId: router.id,
        endpoint,
      })
    ).status,
    400,
  );
});

test("only one test runs at a time", async (t) => {
  const upstream = await fakeEndpoint(t, { "GET /v1/models": () => "hang" });
  const { request, base, endpointTester } = await app(t);
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${upstream.base}/v1`,
    anthropicBaseUrl: null,
    authHeader: null,
  };
  const controller = new AbortController();
  const first = fetch(`${base}/provider-connections/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
    signal: controller.signal,
  }).catch(() => {});
  while (!endpointTester.running) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    (await request("/provider-connections/test", "POST", { endpoint })).status,
    429,
  );
  controller.abort();
  await first;
  // Client disconnect aborts the upstream request and releases the lock.
  for (let i = 0; i < 100 && endpointTester.running; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(endpointTester.running, false);
});

test("audit records the test as provider.tested", () => {
  const audit = requestAudit({
    method: "POST",
    path: "/api/provider-connections/test",
    params: {},
  });
  assert.equal(audit.resourceType, "provider");
  assert.equal(audit.action, "provider.tested");
  assert.equal(audit.resourceId, undefined);
});
