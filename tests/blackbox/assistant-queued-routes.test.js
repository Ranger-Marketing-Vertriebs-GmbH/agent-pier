import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

async function agentChat(t) {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const connection = application.providerConnections.create({
    name: "Queue",
    providerId: "openrouter",
    apiKey: "queue-route-key",
  });
  const created = await fixtureFetch(url + "/api/assistants", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Home",
      instructions: "",
      model: { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" },
    }),
  });
  assert.equal(created.status, 201);
  const assistant = await created.json();
  const conversation = application.assistants.store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: `agent:${assistant.runtimeAgentId}:queue`,
  });
  const call = (method, suffix, body) =>
    fixtureFetch(`${url}/api/assistant-conversations/${conversation.id}${suffix}`, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { call };
}

test("the queued message routes keep, show and hand back one message", async (t) => {
  const { call } = await agentChat(t);
  // Queueing needs no ready service: the message waits for it.
  const first = await call("POST", "/queued", { text: "Add a dessert" });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).state, "waiting");
  const second = await call("POST", "/queued", { text: "Without nuts" });
  assert.equal((await second.json()).text, "Add a dessert\nWithout nuts");

  const history = await (await call("GET", "/messages")).json();
  assert.equal(history.queued.text, "Add a dessert\nWithout nuts");
  assert.equal("clientRequestId" in history.queued, false);

  const invalid = await call("POST", "/queued", { text: "x", clientRequestId: "k" });
  assert.equal(invalid.status, 400);
  const back = await call("DELETE", "/queued");
  assert.equal(back.status, 200);
  assert.deepEqual(await back.json(), {
    text: "Add a dessert\nWithout nuts",
    teamAllowed: false,
    attachments: [],
  });
  assert.equal((await call("DELETE", "/queued")).status, 404);
  assert.equal((await (await call("GET", "/messages")).json()).queued, null);

  // Joined, the queued text keeps to a message's limit of 65,536 characters.
  assert.equal((await call("POST", "/queued", { text: "a".repeat(60000) })).status, 200);
  const long = await call("POST", "/queued", { text: "b".repeat(6000) });
  assert.equal(long.status, 413);
  assert.equal((await long.json()).messageKey, "assistants.queuedTooLong");
  assert.equal(
    (await (await call("GET", "/messages")).json()).queued.text,
    "a".repeat(60000),
  );
});

test("a full-length message in three-byte characters passes the body limit", async (t) => {
  const { call } = await agentChat(t);
  const text = "€".repeat(65536);
  const queued = await call("POST", "/queued", { text });
  assert.equal(queued.status, 200, await queued.clone().text());
  assert.equal((await queued.json()).text.length, 65536);
  const back = await call("DELETE", "/queued");
  assert.equal((await back.json()).text, text);
  // The send reaches validation and the service check instead of the body limit.
  const sent = await call("POST", "/messages", { clientRequestId: "long", text });
  assert.notEqual(sent.status, 413, await sent.clone().text());
});
