import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { RUNTIME_CAPABILITIES } from "../../server/features/assistants/runtimes/agent-runtime.js";
import { DEFAULT_TRAITS } from "../../server/features/assistants/runtimes/runtime-traits.js";

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
  const unknown = await call("POST", "/assistants", body({ runtime: "mystery" }));
  assert.equal(unknown.status, 400);
  const refusal = await unknown.json();
  assert.equal(refusal.messageKey, "assistants.runtimeUnknown");
  assert.match(refusal.error, /mystery/);
  // Hermes is known, but needs the owner's opt-in and its installation first.
  const hermes = await call("POST", "/assistants", body({ runtime: "hermes" }));
  assert.equal(hermes.status, 409);
  assert.equal((await hermes.json()).messageKey, "assistants.hermesUnavailable");

  // The runtimes a new agent may choose, with how each would behave (ADR 0007): the
  // wizard reads a runtime's traits here before an agent exists.
  const runtimes = await call("GET", "/assistant-runtimes");
  assert.equal(runtimes.status, 200);
  const listedRuntimes = (await runtimes.json()).runtimes;
  assert.deepEqual(
    listedRuntimes.map((r) => [r.id, r.name]),
    [
      ["openclaw", "OpenClaw"],
      ["hermes", "Hermes Agent"],
    ],
  );
  assert.equal(
    listedRuntimes[0].capabilities.approvals.shellLevels.includes("every"),
    false,
  );
  assert.equal(listedRuntimes[0].capabilities.routines.available, true);
  assert.equal(listedRuntimes[1].capabilities.host.install, "optional");
  assert.equal(listedRuntimes[1].capabilities.models.chatgptLogin, "agentpierHeld");
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
    // Everything, with the default traits: no "Every command" among the shell
    // levels, because OpenClaw's "With approval" asks for each.
    for (const [name, capability] of Object.entries(agent.runtimeInfo.capabilities))
      assert.deepEqual(capability, { available: true, ...DEFAULT_TRAITS[name] });
    assert.equal(
      agent.runtimeInfo.capabilities.approvals.shellLevels.includes("every"),
      false,
    );
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
