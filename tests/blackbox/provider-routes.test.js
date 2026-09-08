import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("provider catalogs are public metadata and use explicit CLI filters", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/providers");
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.deepEqual(catalog.providers.map((provider) => provider.id).sort(), [
    "openrouter",
    "zai",
    "zai-coding-plan",
  ]);
  const models = await app.request("/api/providers/zai/models?tool=codex");
  assert.equal(models.status, 200);
  const data = await models.json();
  assert.ok(data.models.length);
  assert.ok(data.models.every((model) => model.tools.includes("codex")));
  assert.ok(data.models.every((model) => Number.isSafeInteger(model.contextTokens)));
  assert.equal((await app.request("/api/providers/zai/models?tool=shell")).status, 400);
  assert.equal((await app.request("/api/providers/unknown/models")).status, 400);
});

test("provider profile lifecycle validates model metadata and prevents key exposure", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/accounts", {
    method: "POST",
    body: {
      name: "Gateway fixture",
      tool: "opencode",
      apiKey: "private-provider-fixture-key",
      provider: { id: "zai", modelId: "glm-5.3" },
    },
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  assert.equal(account.provider.modelId, "glm-5.3");
  assert.equal(JSON.stringify(account).includes("private-provider-fixture-key"), false);
  await app.restart();
  const state = await (await app.request("/api/state")).json();
  assert.equal(state.accounts.find((item) => item.id === account.id).provider.id, "zai");
  assert.equal(JSON.stringify(state).includes("private-provider-fixture-key"), false);
  const invalid = await app.request("/api/accounts/" + account.id, {
    method: "PATCH",
    body: {
      name: "Invalid",
      provider: { id: "zai", modelId: "glm-5.3", contextTokens: 999999999 },
    },
  });
  assert.equal(invalid.status, 400);
  const removed = await app.request("/api/accounts/" + account.id, {
    method: "PATCH",
    body: { name: "Gateway fixture", removeApiKey: true },
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).hasSecret, false);
});

test("catalog refresh rejects foreign origins without starting a network request", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/providers/openrouter/refresh", {
    method: "POST",
    origin: "https://foreign.example",
    body: {},
  });
  assert.equal(response.status, 403);
});
