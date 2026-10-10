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
