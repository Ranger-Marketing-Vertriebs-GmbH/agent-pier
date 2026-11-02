import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { makeHermesRuntime } from "../helpers/hermes-fake-gateway.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import {
  deleteNativeSession,
  deletePendingSessions,
} from "../../server/features/assistants/chat-removal.js";
import { AgentProjects } from "../../server/features/assistants/agent-projects.js";
import { LeadShares } from "../../server/features/assistants/lead-shares.js";
import { dreamingCovered } from "../../server/features/assistants/dreaming-service.js";
import {
  memoryRequirement,
  newCapabilities,
} from "../../server/features/assistants/memory-rules.js";

// Background work of AgentPier for a Hermes agent while OpenClaw's Gateway is down:
// each step asks the agent's own runtime (its process set), never OpenClaw.

// A Hermes agent of the channel fixture, its fake set started, OpenClaw down.
async function hermesAgent(t) {
  const f = channelFixture(t);
  const agent = f.store.getAssistant(f.channel.assistantId);
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...agent, runtime: "hermes" }), agent.id);
  const hermes = await makeHermesRuntime(agent.runtimeAgentId)();
  attachHermesFleet(f.assistants.runtime, {
    runtimeOf: () => hermes,
    list: () => [{ runtime: hermes }],
  });
  f.setReady(false);
  return { ...f, agent: f.store.getAssistant(agent.id), hermes };
}

// A chat of the agent whose delete waits, on session `key`.
function deletedChat(f, key) {
  const chat = f.store.saveConversation({
    assistantId: f.agent.id,
    runtimeSessionKey: key,
  });
  f.store.forgetConversation(chat.id, {
    deletedAt: new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    nativeDeletePending: true,
  });
  return f.store.storedConversation(chat.id);
}

test("a Hermes chat's session is deleted in its own set while OpenClaw is down", async (t) => {
  const f = await hermesAgent(t);
  const { key } = await f.hermes.sessions.create({
    agentId: f.agent.runtimeAgentId,
    label: "Plans",
  });
  const chat = deletedChat(f, key);
  assert.equal(await deleteNativeSession(f.assistants, chat), true);
  assert.equal((await f.hermes.sessions.describe({ key })).session, null);
  assert.equal(f.store.storedConversation(chat.id).nativeDeletePending, false);
});

test("a delete that waited for a stopped set runs once the set is ready", async (t) => {
  const f = await hermesAgent(t);
  const { key } = await f.hermes.sessions.create({
    agentId: f.agent.runtimeAgentId,
    label: "Later",
  });
  const chat = deletedChat(f, key);
  // Another agent's pending delete is left alone.
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const foreign = f.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: "agent:other:main",
  });
  f.store.forgetConversation(foreign.id, { nativeDeletePending: true });
  await deletePendingSessions(f.assistants, f.agent);
  assert.equal(f.store.storedConversation(chat.id).nativeDeletePending, false);
  assert.equal((await f.hermes.sessions.describe({ key })).session, null);
  assert.equal(f.store.storedConversation(foreign.id).nativeDeletePending, true);
});

test("a deleted Hermes agent's chat has nothing left to delete", async (t) => {
  const f = channelFixture(t);
  f.setReady(false);
  const chat = {
    id: f.store.saveConversation({
      assistantId: f.channel.assistantId,
      runtimeSessionKey: "agent:ap-gone:hermes:20261102_101010_abcd",
    }).id,
    assistantId: "gone",
    runtimeSessionKey: "agent:ap-gone:hermes:20261102_101010_abcd",
  };
  f.store.updateConversation(chat.id, { nativeDeletePending: true });
  assert.equal(await deleteNativeSession(f.assistants, chat), true);
  assert.equal(f.store.storedConversation(chat.id).nativeDeletePending, false);
});

test("dreaming never holds a Hermes agent's memory on", () => {
  const openclaw = { id: "a1", runtimeAgentId: "ap-a1", capabilities: { memory: true } };
  const hermes = { ...openclaw, id: "a2", runtime: "hermes" };
  assert.equal(dreamingCovered(openclaw), true);
  assert.equal(dreamingCovered(hermes), false);
  const off = { capabilities: { memory: false } };
  assert.equal(
    memoryRequirement(openclaw, off, { dreaming: true }),
    "dreamingMemoryRequired",
  );
  assert.equal(memoryRequirement(hermes, off, { dreaming: true }), null);
  assert.throws(() => newCapabilities(off, true), { key: "dreamingMemoryRequired" });
  assert.equal(newCapabilities({ ...off, runtime: "hermes" }, true).memory, false);
});

test("a Hermes agent's new project or share reaches its set while OpenClaw is down", async () => {
  const supervisor = { client: { ready: false } };
  attachHermesFleet(supervisor, { available: () => true, list: () => [] });
  const applied = [];
  const a = {
    runtime: supervisor,
    admit: (operation) => Promise.resolve().then(operation),
    config: { apply: async (id) => applied.push(id) },
    changed() {},
    store: {
      getAssistant: (id) => ({ id, runtime: id === "h1" ? "hermes" : undefined }),
    },
  };
  const projects = Object.create(AgentProjects.prototype);
  projects.w = { a };
  projects.refresh({ id: "h1", runtime: "hermes" });
  // An OpenClaw agent waits for its Gateway, as before.
  projects.refresh({ id: "o1" });
  const shares = Object.create(LeadShares.prototype);
  shares.w = { a };
  shares.changed("h1", [{ kind: "project" }]);
  shares.changed("o1", [{ kind: "project" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["h1", "h1"]);
});
