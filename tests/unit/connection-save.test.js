import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  connectionBody,
  connectionSaveStep,
  connectionValues,
} from "../../web/features/provider-connections/connection-save.js";

const router = {
  id: "c1",
  name: "Router",
  providerId: "zai",
  responsesAccess: false,
  hasSecret: true,
};

test("a new connection sends name, provider and key only", () => {
  const values = { ...connectionValues(null), name: " Shared ", apiKey: "k" };
  assert.deepEqual(connectionBody(values, null), {
    name: "Shared",
    providerId: "openrouter",
    apiKey: "k",
  });
});

test("an edit sends only what changed and responses access only for non-OpenRouter", () => {
  const values = connectionValues(router);
  assert.deepEqual(connectionBody(values, router), { name: "Router" });
  assert.deepEqual(connectionBody({ ...values, responsesAccess: true }, router), {
    name: "Router",
    responsesAccess: true,
  });
  assert.deepEqual(connectionBody({ ...values, removeApiKey: true }, router), {
    name: "Router",
    removeApiKey: true,
  });
  const created = connectionValues(null);
  assert.equal("responsesAccess" in connectionBody(created, null), false);
});

test("an endpoint connection sends its endpoint payload", () => {
  const values = { ...connectionValues(null), name: "Box", providerId: "endpoint" };
  const body = connectionBody(values, null);
  assert.equal(body.providerId, "endpoint");
  assert.equal(body.endpoint.openaiBaseUrl, "http://127.0.0.1:11434/v1");
  assert.equal("responsesAccess" in body, false);
});

test("a restart request is confirmed and repeated with the flag", async () => {
  const calls = [];
  const saved = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (calls.length === 1)
      throw Object.assign(new Error("restart"), {
        code: "ASSISTANT_RESTART_REQUIRED",
        affected: { agents: [{ name: "Olli" }] },
      });
    return { id: "c1" };
  };
  const step = connectionSaveStep({
    connection: router,
    label: "Save connection",
    request,
    saved: async (result) => saved.push(result),
  });
  const values = { ...connectionValues(router), name: "Router 2" };
  const asked = [];
  const result = await runSaveChain({
    steps: [step],
    values,
    base: connectionValues(router),
    ask: async (confirmation) => {
      asked.push(confirmation);
      return true;
    },
  });
  assert.equal(result.status, "saved");
  assert.equal(asked[0].kind, "restart");
  assert.deepEqual(asked[0].data.affected.agents, [{ name: "Olli" }]);
  assert.deepEqual(calls[1], {
    path: "/provider-connections/c1",
    method: "PATCH",
    body: { name: "Router 2", confirmRestart: true },
  });
  assert.deepEqual(saved, [{ id: "c1" }]);
});

test("a new connection posts and reports the created record", async () => {
  const calls = [];
  const step = connectionSaveStep({
    connection: null,
    label: "Save connection",
    request: async (path, method, body) => {
      calls.push({ path, method, body });
      return { id: "new-id" };
    },
    saved: async () => {},
  });
  const values = { ...connectionValues(null), name: "Shared" };
  const result = await runSaveChain({
    steps: [step],
    values,
    base: connectionValues(null),
  });
  assert.equal(result.status, "saved");
  assert.equal(calls[0].path, "/provider-connections");
  assert.equal(calls[0].method, "POST");
  assert.equal(result.results.connection.id, "new-id");
});
