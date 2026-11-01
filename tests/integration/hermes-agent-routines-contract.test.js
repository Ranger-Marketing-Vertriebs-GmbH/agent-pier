import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { contractRecord, hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { guardProcess } from "../helpers/process-guard.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/runtime-for.js";

// AgentPier's routines end to end on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME):
// a routine the owner creates for a Hermes agent through the routine routes becomes a
// job on the cron of that agent's own messaging gateway, carrying AgentPier's marker;
// pausing and removing it reach Hermes, and an event routine's run, forced by its
// event, comes back through AgentPier's completion webhook into the agent's main
// chat. The in-repo fake model answers; nothing leaves the host.
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
  "Hermes contract: an owner's routines run on the agent's Hermes cron and report to its chat",
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
          name: "Hermes planner",
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
    const listed = (await json(await f.request("/api/assistants"))).assistants.find(
      (a) => a.id === agent.id,
    );
    assert.equal(listed.runtimeInfo.capabilities.routines.available, true);
    const base = `/api/assistants/${agent.id}/routines`;

    // A scheduled routine is a Hermes job with AgentPier's marker, paused and resumed.
    const daily = await json(
      await f.request(base, {
        method: "POST",
        body: {
          clientRequestId: "daily-1",
          name: "Morning notes",
          prompt: "ROUTINE: list what is due today",
          trigger: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        },
      }),
      201,
    );
    assert.equal(daily.status, "ready");
    assert.equal(daily.enabled, true);
    const job = async (id) =>
      (await runtime.routines.list({ agentId: agent.runtimeAgentId })).find(
        (r) => r.marker === `agentpier-reminder:${id}`,
      );
    const native = await job(daily.id);
    assert.equal(native.enabled, true);
    assert.deepEqual(native.schedule, {
      kind: "cron",
      expression: "0 7 * * *",
      timezone: "UTC",
    });
    const main = assistants.reminders.mainConversation(agent.id);
    assert.deepEqual(native.target, { kind: "chat", sessionKey: main.runtimeSessionKey });
    assert.equal(native.delivery.kind, "chat");
    const paused = await json(
      await f.request(`${base}/${daily.id}`, {
        method: "PATCH",
        body: { enabled: false, revision: daily.revision },
      }),
    );
    assert.equal(paused.enabled, false);
    assert.equal((await job(daily.id)).enabled, false);

    // An event routine runs when its event comes, and its result reaches the chat.
    const onEvent = await json(
      await f.request(base, {
        method: "POST",
        body: {
          clientRequestId: "event-1",
          name: "On demand",
          prompt: "ROUTINE: tell me the time of day",
          trigger: { kind: "event", eventKind: "manual" },
        },
      }),
      201,
    );
    assert.equal((await job(onEvent.id)).enabled, false);
    const receipt = await json(
      await f.request(`${base}/${onEvent.id}/events`, {
        method: "POST",
        body: { eventId: "first" },
      }),
      202,
    );
    assert.equal(receipt.status, "queued");
    // The result shows in the main chat's event area (routine-results.js).
    let result = null;
    try {
      await eventually(
        () => {
          result = assistants.reminders.results
            .forConversation(main.id)
            .find((r) => r.bindingId === onEvent.id);
          return !!result;
        },
        240000,
        "the routine's result in the main chat",
      );
    } catch (error) {
      // What each side saw, so a failure names its step.
      const home = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
      const runs = path.join(home.hermesHome, "agentpier-routine-runs.json");
      error.message += ` (job ${JSON.stringify(await job(onEvent.id).catch((e) => e.code))}; deliveries ${
        fs.existsSync(runs) ? fs.readFileSync(runs, "utf8") : "none"
      })`;
      throw error;
    }
    assert.equal(result.status, "ok");
    assert.match(result.text, /^ECHO: .*ROUTINE: tell me the time of day$/s);
    // Hermes keeps it out of the chat's own transcript; AgentPier shows it.
    assert.equal(result.committed, false);
    // The event routine stays paused on Hermes; its run is listed with its session.
    assert.equal((await job(onEvent.id)).enabled, false);
    const { entries } = await json(await f.request(`${base}/${onEvent.id}/runs`));
    assert.equal(entries.length, 1);
    const routines = (await json(await f.request(base))).routines;
    const shown = routines.find((r) => r.id === onEvent.id);
    assert.equal(shown.lastRunStatus, "ok");

    // Removing a routine removes its job.
    await json(await f.request(`${base}/${daily.id}`, { method: "DELETE" }));
    assert.equal(await job(daily.id), undefined);
    await json(await f.request(`${base}/${onEvent.id}`, { method: "DELETE" }));
    assert.deepEqual(await runtime.routines.list({ agentId: agent.runtimeAgentId }), []);

    const home = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
  },
);
