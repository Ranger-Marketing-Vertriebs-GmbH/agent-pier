import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

test("assistant account API requires authentication, origin and a running owned Gateway", async (t) => {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const endpoint = url + "/api/assistant-model-accounts";
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fixtureFetch(endpoint);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts, []);
  const login = url + "/api/assistant-model-login";
  const options = {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: "{}",
  };
  assert.equal((await fixtureFetch(login, options)).status, 503);
  assert.equal(
    (
      await fixtureFetch(login, {
        ...options,
        headers: { ...options.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await fixtureFetch(login + "/foreign")).status, 404);
  assert.ok(application.assistantModelAccounts);
});

test("a model list refresh needs login and origin, and one owner budget bounds it", async (t) => {
  const { url } = await applicationFixture(t, enabledAssistants);
  const endpoint =
    url + "/api/assistant-model-accounts/openclaw%3Afixture/models/refresh";
  const options = {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: "{}",
  };
  assert.equal((await fetch(endpoint, options)).status, 401);
  assert.equal(
    (
      await fixtureFetch(endpoint, {
        ...options,
        headers: { ...options.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  const statuses = [];
  for (let i = 0; i < 12; i++)
    statuses.push((await fixtureFetch(endpoint, options)).status);
  assert.deepEqual(statuses, Array(12).fill(503), "no running Gateway");
  assert.equal((await fixtureFetch(endpoint, options)).status, 429);
  const limited = await fixtureFetch(endpoint, options);
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, "models-rate-limited");
  assert.equal(body.messageKey, "assistants.modelsRateLimited");
});
