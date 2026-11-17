import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../../server/features/assistants/agent-creation.js";
import { attachAgentHosts } from "../../server/features/assistants/runtimes/runtime-for.js";

// A new agent's runtime options (ADR 0007, step 7a), as a create and a duplicate send
// them: nothing is stored yet, so every advisor must be available now.
const connections = [
  { id: "c-or", providerId: "openrouter", available: true },
  { id: "c-off", providerId: "openrouter", available: false },
  { id: "c-main", providerId: "openrouter", available: true },
];
const reached = new Error("validated");
function service() {
  const runtime = {};
  attachAgentHosts(runtime, "hermes", { available: () => true });
  return {
    runtime,
    admit: (fn) => fn(),
    models: {
      listCapabilities: () => connections,
      // The step after the options' check: reaching it means they passed.
      resolve: async () => {
        throw reached;
      },
    },
  };
}
const body = (advisors) => ({
  name: "Heron",
  instructions: "",
  runtime: "hermes",
  shell: "off",
  model: { connectionId: "c-main", modelId: "x/y" },
  runtimeOptions: { hermes: { mixture: { advisors } } },
});

for (const [label, connectionId] of [
  ["an unknown", "does-not-exist"],
  ["an unavailable", "c-off"],
])
  test(`a create or duplicate with ${label} advisor connection is refused`, async () => {
    await assert.rejects(
      createAgent(service(), body([{ connectionId, modelId: "a/b" }])),
      (error) => error.key === "mixtureAdvisorUnavailable" && error.status === 409,
    );
  });

test("a create with available advisors passes the check", async () => {
  await assert.rejects(
    createAgent(service(), body([{ connectionId: "c-or", modelId: "a/b" }])),
    (error) => error === reached,
  );
});
