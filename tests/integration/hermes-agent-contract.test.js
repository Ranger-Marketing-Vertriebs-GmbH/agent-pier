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

// AgentPier end to end on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): an
// agent created through the agent routes with runtime "hermes" gets its compiled
// home and its own supervised process set, chats through AgentPier's chat path
// (turn ledger, live chat feed, history), asks before a dangerous command through
// AgentPier's approval store, runs it once approved, and leaves no Hermes process
// behind once deleted. The in-repo fake model answers; nothing leaves the host.
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
  "Hermes contract: an agent created in AgentPier chats, asks once, runs and is deleted",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const f = await applicationFixture(t, enabledAssistants);
    await eventually(() => !!f.application.assistants, 30000, "the agent services");
    const assistants = f.application.assistants;
    // The app's own Hermes fleet, on the installation the contracts provisioned
    // instead of one installed into this data directory.
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
          shell: "approval",
          confirmShell: true,
        },
      }),
      201,
    );
    assert.equal(agent.runtime, "hermes");
    const runtime = fleet.runtimeOf(agent);
    // The create wrote the agent's home and started its own process set.
    await eventually(() => runtime.host.ready(), 240000, "the agent's Hermes set");
    for (const pid of fleet.sets.get(agent.runtimeAgentId).supervisor.pids())
      guardProcess(t, pid, { group: true, graceMs: 5000 });
    const listed = (await json(await f.request("/api/assistants"))).assistants.find(
      (a) => a.id === agent.id,
    );
    assert.equal(listed.runtimeInfo.name, "Hermes Agent");
    assert.equal(listed.runtimeInfo.capabilities.approvals.available, true);
    assert.equal(listed.runtimeInfo.capabilities.routines.available, true);
    assert.equal(listed.runtimeInfo.capabilities.skills.available, true);
    assert.equal(
      listed.runtimeInfo.capabilities.advancedSettings.reason,
      "advancedSettingsUnsupported",
    );
    const home = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    assert.match(
      fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
      /fake-1/,
    );

    // AgentPier's chat stream: the live feed hears the reply as it grows.
    const streamed = [];
    const feed = assistants.feeds.stream.bind(assistants.feeds);
    assistants.feeds.stream = (conversationId, runId, text) => {
      streamed.push(text);
      return feed(conversationId, runId, text);
    };
    const chat = await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
    );
    assert.match(
      chat.runtimeSessionKey,
      new RegExp(`^agent:${agent.runtimeAgentId}:hermes:`),
    );
    const send = (clientRequestId, text) =>
      f.request(`/api/assistant-conversations/${chat.id}/messages`, {
        method: "POST",
        body: { clientRequestId, text },
      });
    const sent = await send("hello", "hello hermes");
    assert.ok([200, 201, 202].includes(sent.status), await sent.clone().text());
    const attempt = (id) =>
      assistants.ledger
        .pending()
        .concat(assistants.ledger.unresolved?.() || [])
        .find((a) => assistants.ledger.getRequest(a.requestId).clientRequestId === id);
    // The turn's attempt leaves the ledger's open ones once the run ended.
    const settled = (id) =>
      eventually(
        async () => {
          await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
          return attempt(id) === undefined;
        },
        60000,
        `the turn ${id} to settle`,
      );
    const reply = async (fragment) => {
      let messages = [];
      try {
        await eventually(
          async () => {
            await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
            messages = (await assistants.history(chat.id)).messages;
            return messages.some(
              (m) => m.role === "assistant" && m.text.includes(fragment),
            );
          },
          240000,
          `the reply ${fragment}`,
        );
      } catch (error) {
        // What AgentPier saw, so a failure names its step.
        const raw = await runtime.sessions
          .history({ sessionKey: chat.runtimeSessionKey })
          .catch((e) => ({ error: e.code }));
        error.message += ` (history ${JSON.stringify(messages)}; runtime ${JSON.stringify(
          raw,
        ).slice(
          0,
          2000,
        )}; model calls ${model.requests.length}; streamed ${streamed.length})`;
        throw error;
      }
      return messages;
    };
    const first = await reply("ECHO: hello hermes");
    // The very first message of the install carries no onboarding note.
    assert.deepEqual(
      first.filter((m) => m.role === "assistant").map((m) => m.text),
      ["ECHO: hello hermes"],
    );
    assert.ok(streamed.length > 1, "the reply streamed in parts");
    assert.equal(streamed.at(-1), "ECHO: hello hermes");
    assert.ok(
      streamed.every((text, i) => i === 0 || text.length >= streamed[i - 1].length),
    );
    // The history names each message once, with its own id and time.
    const ids = first.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    await settled("hello");

    // A dangerous command asks the owner once, through AgentPier's approval store.
    const build = path.join(home.workspace, "build");
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, "x.txt"), "x");
    await send("rm", "RUN: rm -rf build");
    let action;
    await eventually(
      async () => {
        const { actions = [] } = await json(
          await f.request(`/api/assistants/${agent.id}/actions`),
        );
        action = actions.find(
          (a) => a.payload?.action === "exec" && a.state === "awaiting_approval",
        );
        return !!action;
      },
      240000,
      "the approval",
    );
    assert.equal(action.payload.command, "rm -rf build");
    assert.equal(action.payload.cwd, home.workspace);
    assert.equal(fs.existsSync(build), true);
    await json(
      await f.request(`/api/assistant-actions/${action.id}/decision`, {
        method: "POST",
        body: { revision: action.revision, decision: "allow-once" },
      }),
    );
    await reply("TOOL_DONE");
    await settled("rm");
    assert.equal(fs.existsSync(build), false);
    const { actions } = await json(
      await f.request(`/api/assistants/${agent.id}/actions`),
    );
    assert.equal(actions.filter((a) => a.payload?.action === "exec").length, 1);
    assert.deepEqual(await runtime.approvals.list(), []);

    // Archive, then delete: the set stops and its folders go.
    const current = (await json(await f.request("/api/assistants"))).assistants.find(
      (a) => a.id === agent.id,
    );
    await json(
      await f.request(`/api/assistants/${agent.id}/archive`, {
        method: "POST",
        body: { revision: current.revision },
      }),
    );
    await eventually(
      () => runtime.host.status().availability === "disabled",
      60000,
      "the archived agent's set to stop",
    );
    await json(
      await f.request(`/api/assistants/${agent.id}`, {
        method: "DELETE",
        body: { name: agent.name },
      }),
      204,
    );
    assert.equal(
      assistants.store.listAssistants().some((a) => a.id === agent.id),
      false,
    );
    await eventually(() => !fs.existsSync(home.hermesHome), 60000, "the agent's home");
    assert.deepEqual(await strayAfterStop({ root: path.dirname(home.hermesHome) }), []);
    assert.deepEqual(await strayAfterStop({ root: f.dataDir }), []);
  },
);
