import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { providerConnectionRoutes } from "../../server/http/routes/provider-connections.js";
test("central connection HTTP CRUD persists only public metadata and rejects client context overrides", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-connections-http-"));
  const providerConnections = new ProviderConnections({ dataDir });
  const app = express();
  app.use(express.json(), providerConnectionRoutes({ providerConnections }));
  app.use((error, _request, response, _next) =>
    response.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (route, method = "GET", body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const created = await request("/provider-connections", "POST", {
    name: "All CLIs",
    providerId: "openrouter",
    apiKey: "fixture-central-secret",
  });
  assert.equal(created.status, 201);
  const connection = await created.json();
  assert.equal(JSON.stringify(connection).includes("fixture-central-secret"), false);
  assert.equal(
    (await (await request("/provider-connections")).json()).connections.length,
    1,
  );
  assert.equal(
    (
      await request(`/provider-connections/${connection.id}`, "PATCH", {
        contextTokens: 1000000,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await (
        await request(`/provider-connections/${connection.id}`, "PATCH", {
          removeApiKey: true,
        })
      ).json()
    ).hasSecret,
    false,
  );
  assert.equal(
    (await request(`/provider-connections/${connection.id}`, "DELETE")).status,
    204,
  );
  assert.deepEqual(new ProviderConnections({ dataDir }).list(), []);
});
