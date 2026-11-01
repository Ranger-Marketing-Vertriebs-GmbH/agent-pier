import assert from "node:assert/strict";
import { startFakeModel } from "./hermes-fake-model.js";
import { applicationFixture, enabledAssistants } from "./application.js";
import { eventually } from "./hermes-fake-runtime.js";
import { contractRecord } from "./hermes-native.js";
import { guardProcess } from "./process-guard.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/runtime-for.js";

// AgentPier itself on the pinned Hermes for the native end-to-end contracts
// (tests/integration/hermes-*-contract.test.js): a temporary app whose Hermes fleet
// runs the provisioned installation (AGENTPIER_HERMES_CONTRACT_RUNTIME), the in-repo
// fake model as the owner's model connection, and helpers that drive it through the
// API like the web app does. hermesApp adds one created agent for the contracts that
// drive one agent's features (Telegram, clarify), hermesFleetApp creates them on demand
// (teams).

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

/** The app with its Hermes fleet on the contract installation; `model`: startFakeModel's. */
export async function hermesFleetApp(t, model, overrides = {}) {
  const f = await applicationFixture(t, { ...enabledAssistants, ...overrides });
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
  const app = { f, assistants, fleet, connection };

  /** Creates a Hermes agent through the API and waits for its own set. */
  app.createAgent = async (body = {}) => {
    const agent = await json(
      await f.request("/api/assistants", {
        method: "POST",
        body: {
          name: "Hermes lead",
          instructions: "You help the owner.",
          model: { connectionId: connection.id, modelId: "fake-1" },
          capabilities: { memory: false, reminders: false },
          runtime: "hermes",
          ...body,
        },
      }),
      201,
    );
    await app.ready(agent);
    return agent;
  };

  /** Waits for the agent's set and guards its processes. */
  app.ready = async (agent) => {
    const runtime = fleet.runtimeOf(agent);
    await eventually(() => runtime.host.ready(), 240000, `the Hermes set of ${agent.id}`);
    for (const pid of fleet.sets.get(agent.runtimeAgentId).supervisor.pids())
      guardProcess(t, pid, { group: true, graceMs: 5000 });
    return runtime;
  };

  /** A new chat of `agent`, with `send(id, text)` and `reply(fragment)`. */
  app.chat = async (agent) => {
    const chat = await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
    );
    return app.conversation(chat);
  };

  app.conversation = (chat) => ({
    chat,
    send: async (clientRequestId, text) => {
      const sent = await f.request(`/api/assistant-conversations/${chat.id}/messages`, {
        method: "POST",
        body: { clientRequestId, text },
      });
      assert.ok([200, 201, 202].includes(sent.status), await sent.clone().text());
    },
    messages: async () => {
      await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
      return (await assistants.history(chat.id)).messages;
    },
    reply: async (match, timeoutMs = 240000) => {
      let messages = [];
      const found = (m) =>
        m.role === "assistant" &&
        (typeof match === "string" ? m.text.includes(match) : match.test(m.text));
      try {
        await eventually(
          async () => {
            await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
            messages = (await assistants.history(chat.id)).messages;
            return messages.some(found);
          },
          timeoutMs,
          `the reply ${match}`,
        );
      } catch (error) {
        error.message += ` (history ${JSON.stringify(messages).slice(0, 3000)})`;
        throw error;
      }
      return messages.find(found);
    },
  });
  return app;
}

/**
 * Starts AgentPier and creates a Hermes agent (`fields` override the create body);
 * resolves `{ f, assistants, fleet, agent, runtime, model, … }` once its set is ready.
 */
export async function hermesApp(t, fields = {}) {
  const model = await startFakeModel();
  t.after(() => model.close());
  const app = await hermesFleetApp(t, model);
  const agent = await app.createAgent({ name: "Hermes helper", shell: "off", ...fields });
  return { ...app, agent, runtime: app.fleet.runtimeOf(agent), model };
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
