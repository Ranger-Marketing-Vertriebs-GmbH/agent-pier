import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
test("assistant API persists definitions, rejects foreign origins and never exposes provider secrets", async (t) => {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const connection = application.providerConnections.create({
    name: "Assistant test",
    providerId: "openrouter",
    apiKey: "private-assistant-key",
  });
  const options = {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Home",
      instructions: "Plan meals",
      model: { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" },
    }),
  };
  const created = await fixtureFetch(url + "/api/assistants", options);
  assert.equal(created.status, 201, await created.clone().text());
  const assistant = await created.json();
  assert.equal(assistant.name, "Home");
  const listed = await fixtureFetch(url + "/api/assistants");
  const text = await listed.text();
  assert.ok(!text.includes("private-assistant-key"));
  assert.ok(text.includes(assistant.id));
  assert.equal((await fetch(url + "/api/assistants")).status, 401);
  assert.equal(
    (
      await fixtureFetch(url + "/api/assistants", {
        ...options,
        headers: { ...options.headers, origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fixtureFetch(url + `/api/assistants/${assistant.id}/conversations`, {
        ...options,
        body: "{}",
      })
    ).status,
    503,
  );
});
