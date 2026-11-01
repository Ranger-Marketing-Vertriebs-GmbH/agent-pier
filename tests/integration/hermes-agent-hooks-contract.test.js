import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { contractRecord, hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { guardProcess } from "../helpers/process-guard.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/runtime-for.js";

// A hook run end to end on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): the
// owner creates a hook for a Hermes agent through the hook routes and sends its test
// event; AgentPier (agent-hook-runs.js) creates a disabled job on the cron of the
// agent's own messaging gateway and forces its run; the run's completion comes back
// through the hook completion webhook; the event settles with the run's reply, the
// result shows in the agent's main chat and goes into its history, and the job is
// removed. The in-repo fake model answers; nothing leaves the host.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

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

async function json(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}

test(
  "Hermes contract: a hook event runs on the agent's Hermes cron and settles in its chat",
  options,
  async (t) => {
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
          name: "Hermes hooks",
          instructions: "You help the owner.",
          model: { connectionId: connection.id, modelId: "fake-1" },
          capabilities: { memory: false, reminders: true },
          runtime: "hermes",
          shell: "approval",
          confirmShell: true,
        },
      }),
      201,
    );
    const runtime = fleet.runtimeOf(agent);
    await eventually(() => runtime.host.ready(), 240000, "the agent's Hermes set");
    for (const pid of fleet.sets.get(agent.runtimeAgentId).supervisor.pids())
      guardProcess(t, pid, { group: true, graceMs: 5000 });

    const base = `/api/assistants/${agent.id}/hooks`;
    const { hook, secret } = await json(
      await f.request(base, {
        method: "POST",
        body: {
          name: "Deploys",
          sender: "CI",
          instruction: "Tell me which build finished.",
          rights: { notify: false },
        },
      }),
      201,
    );
    assert.equal(typeof secret, "string");
    const accepted = await json(
      await f.request(`${base}/${hook.id}/test`, { method: "POST" }),
      202,
    );
    assert.ok(accepted);
    const hooks = f.application.assistantRoutines.hooks;
    let event = null;
    await eventually(
      () => {
        event = hooks.events.last(hook.id);
        return event && !["pending", "running"].includes(event.status);
      },
      300000,
      "the hook event settled",
    ).catch((error) => {
      error.message += ` (event ${JSON.stringify(event)})`;
      throw error;
    });
    assert.equal(event.status, "done");
    assert.match(event.reply, /^ECHO: /);
    // The result shows in the main chat and is part of its history.
    const main = assistants.reminders.mainConversation(agent.id);
    const result = assistants.reminders.results
      .forConversation(main.id)
      .find((r) => r.kind === "hook");
    assert.equal(result.text, event.reply);
    const history = await runtime.sessions.history({
      sessionKey: main.runtimeSessionKey,
    });
    assert.ok(
      history.messages.some(
        (m) => m.display_kind === "internal_notification" && m.text.endsWith(event.reply),
      ),
    );
    // The event's job is gone from Hermes.
    await eventually(
      async () =>
        (await runtime.routines.list({ agentId: agent.runtimeAgentId })).length === 0,
      60000,
      "the hook job removed",
    );

    const home = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
  },
);
