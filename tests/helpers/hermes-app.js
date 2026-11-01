import assert from "node:assert/strict";
import { startFakeModel } from "./hermes-fake-model.js";
import { applicationFixture, enabledAssistants } from "./application.js";
import { eventually } from "./hermes-fake-runtime.js";
import { contractRecord } from "./hermes-native.js";
import { guardProcess } from "./process-guard.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/runtime-for.js";

// AgentPier with a Hermes agent created through its routes, on the pinned Hermes the
// native contracts provisioned (AGENTPIER_HERMES_CONTRACT_RUNTIME) and the in-repo
// fake model, for the native contracts that drive whole features (Telegram, clarify).

const endpoint = (baseUrl) => ({
  preset: "custom",
  openaiBaseUrl: baseUrl,
  anthropicBaseUrl: null,
  protocols: { messages: false, responses: false, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "fake-1",
      label: "Fake 1",
      contextTokens: 128000,
      outputTokens: 4096,
      source: "manual",
      contextEdited: false,
    },
  ],
});

/** The parsed body of `response` after asserting its status. */
export async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

/**
 * Starts AgentPier and creates a Hermes agent (`fields` override the create body);
 * resolves `{ f, assistants, fleet, agent, runtime, model }` once its set is ready.
 */
export async function hermesApp(t, fields = {}) {
  const model = await startFakeModel();
  t.after(() => model.close());
  const f = await applicationFixture(t, enabledAssistants);
  await eventually(() => !!f.application.assistants, 30000, "the agent services");
  const assistants = f.application.assistants;
  const fleet = hermesFleetOf(assistants.runtime);
  fleet.available = () => true;
  Object.assign(fleet.options, {
    runtime: async () => contractRecord(),
    readyTimeoutMs: 180000,
    callTimeoutMs: 60000,
  });
  t.after(() => fleet.close());
  const connection = f.application.providerConnections.create({
    name: "Fake model",
    providerId: "endpoint",
    endpoint: endpoint(model.baseUrl),
    apiKey: "contract-key",
  });
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: {
        name: "Hermes helper",
        instructions: "You help the owner.",
        model: { connectionId: connection.id, modelId: "fake-1" },
        capabilities: { memory: false, reminders: false },
        runtime: "hermes",
        shell: "off",
        ...fields,
      },
    }),
    201,
  );
  const runtime = fleet.runtimeOf(agent);
  await eventually(() => runtime.host.ready(), 240000, "the agent's Hermes set");
  for (const pid of fleet.sets.get(agent.runtimeAgentId).supervisor.pids())
    guardProcess(t, pid, { group: true, graceMs: 5000 });
  return { f, assistants, fleet, agent, runtime, model };
}

/** Archives and deletes the agent through its routes; its set and folders go. */
export async function deleteAgent({ f, agent }) {
  const current = (await json(await f.request("/api/assistants"))).assistants.find(
    (a) => a.id === agent.id,
  );
  await json(
    await f.request(`/api/assistants/${agent.id}/archive`, {
      method: "POST",
      body: { revision: current.revision },
    }),
  );
  await json(
    await f.request(`/api/assistants/${agent.id}`, {
      method: "DELETE",
      body: { name: agent.name },
    }),
    204,
  );
}
