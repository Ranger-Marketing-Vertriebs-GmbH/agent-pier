import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { RUNTIME_CAPABILITIES } from "../../server/features/assistants/runtimes/agent-runtime.js";

// ADR 0006: agents record their runtime; the agent API names it with its capabilities.
test("the agent API takes an optional runtime and answers each agent's runtime", async (t) => {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const connection = application.providerConnections.create({
    name: "Runtime",
    providerId: "openrouter",
    apiKey: "runtime-route-key",
  });
  const call = (method, suffix, body) =>
    fixtureFetch(`${url}/api${suffix}`, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const body = (extra) => ({
    name: "Home",
    instructions: "",
    model: { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" },
    shell: "off",
    ...extra,
  });

  const plain = await call("POST", "/assistants", body());
  assert.equal(plain.status, 201, await plain.clone().text());
  assert.equal((await plain.json()).runtime, "openclaw");
  const chosen = await call("POST", "/assistants", body({ runtime: "openclaw" }));
  assert.equal(chosen.status, 201, await chosen.clone().text());
  const created = await chosen.json();
  assert.equal(created.runtime, "openclaw");

  // A runtime this AgentPier lacks is refused with a translated, stable message.
  const unknown = await call("POST", "/assistants", body({ runtime: "hermes" }));
  assert.equal(unknown.status, 400);
  const refusal = await unknown.json();
  assert.equal(refusal.messageKey, "assistants.runtimeUnknown");
  assert.match(refusal.error, /hermes/);
  assert.equal(application.assistants.store.listAssistants().length, 2);

  const list = await (await call("GET", "/assistants")).json();
  assert.equal(list.assistants.length, 2);
  for (const agent of list.assistants) {
    assert.equal(agent.runtime, "openclaw");
    assert.equal(agent.runtimeInfo.id, "openclaw");
    assert.equal(agent.runtimeInfo.name, "OpenClaw");
    assert.ok("version" in agent.runtimeInfo);
    assert.deepEqual(Object.keys(agent.runtimeInfo.capabilities), [
      ...RUNTIME_CAPABILITIES,
    ]);
    for (const capability of Object.values(agent.runtimeInfo.capabilities))
      assert.deepEqual(capability, { available: true });
  }

  // The runtime stays the one chosen at creation.
  const moved = await call("PATCH", `/assistants/${created.id}`, {
    revision: created.revision,
    runtime: "openclaw",
  });
  assert.equal(moved.status, 400);
  const renamed = await call("PATCH", `/assistants/${created.id}`, {
    revision: created.revision,
    name: "Renamed",
  });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const saved = await renamed.json();
  assert.equal(saved.runtime, "openclaw");
  assert.equal(saved.runtimeInfo.name, "OpenClaw");
});
