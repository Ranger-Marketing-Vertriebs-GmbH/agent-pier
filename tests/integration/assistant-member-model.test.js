import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

const first = { connectionId: "c", modelId: "m" },
  second = { connectionId: "x", modelId: "y" },
  third = { connectionId: "z", modelId: "w" };

/** A Gateway that keeps each agent's model and answers the config reads with it. */
function gateway() {
  const entries = {},
    files = {},
    updates = [];
  return {
    entries,
    updates,
    call: async (method, input) => {
      if (method === "agents.list")
        return { agents: Object.keys(entries).map((id) => ({ id })) };
      if (method === "agents.create") {
        entries[input.name] = { id: input.name, model: input.model };
        return { agentId: input.name };
      }
      if (method === "agents.update") {
        updates.push({ agentId: input.agentId, model: input.model });
        entries[input.agentId] = { ...entries[input.agentId], model: input.model };
        return {};
      }
      if (method === "config.get") return { hash: "h", config: { agents: { entries } } };
      if (method === "agents.files.get") {
        const content = files[`${input.agentId}/${input.name}`];
        return { file: content === undefined ? { missing: true } : { content } };
      }
      if (method === "agents.files.set") {
        files[`${input.agentId}/${input.name}`] = input.content;
        return {};
      }
      assert.fail(method);
    },
  };
}

function workspaces(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "member-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function teamWith(t, lifetime, count = 1) {
  const f = teamFixture(t);
  const { team, parent, attempt } = await f.proposal({ count, allowed: false });
  // The lead's turn that proposed the team is over.
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.decide(
    team.id,
    { revision: team.revision, decision: "approve", lifetime },
    { kind: "owner" },
  );
  const [member] = f.service.store.members(team.id);
  const g = gateway();
  const config = new AssistantConfig({
    store: f.store,
    client: g,
    workspaces: workspaces(t),
    models: {
      resolve: async ({ connectionId, modelId }) => ({
        modelRef: `${connectionId}/${modelId}`,
        display: { connection: connectionId, model: modelId },
        release() {},
      }),
    },
  });
  return { f, parent, team, member, g, config };
}

test("a lead's model change reaches its task member's Gateway config at its next apply", async (t) => {
  const { f, parent, member, g, config } = await teamWith(t, "task");
  const agent = f.store.getAssistant(member.assistantId);
  await config.apply(agent.id);
  assert.equal(g.entries[agent.runtimeAgentId].model, "c/m");
  // The owner changes the lead's model, as the Profile tab does.
  await f.assistants.update(parent.id, { model: second }, parent.revision);
  // Every turn applies the config first (conversation-turns.js).
  await config.apply(agent.id);
  assert.equal(g.entries[agent.runtimeAgentId].model, "x/y");
  assert.deepEqual(g.updates.at(-1), { agentId: agent.runtimeAgentId, model: "x/y" });
});

test("a permanent member's Gateway config keeps its own model", async (t) => {
  const { f, parent, member, g, config } = await teamWith(t, "permanent");
  const agent = f.store.getAssistant(member.assistantId);
  await config.apply(agent.id);
  await f.assistants.update(parent.id, { model: second }, parent.revision);
  await config.apply(agent.id);
  assert.equal(g.entries[agent.runtimeAgentId].model, "c/m");
});

test("the agents list shows a task member's effective model and refuses editing it", async (t) => {
  const { f, parent, member } = await teamWith(t, "task");
  await f.assistants.update(parent.id, { model: second }, parent.revision);
  const listed = f.assistants.list().assistants.find((a) => a.id === member.assistantId);
  assert.deepEqual(listed.model, second);
  assert.equal(f.assistants.list().members[0].overrides.model, undefined);
  // Restating the effective model is no change; another model is refused.
  f.service.store.setPhase(member.id, "queued", { phase: "completed" });
  const kept = await f.assistants.update(
    member.assistantId,
    { name: "Renamed", model: second },
    listed.revision,
  );
  assert.equal(kept.name, "Renamed");
  await assert.rejects(
    f.assistants.update(member.assistantId, { model: first }, kept.revision),
    { status: 409, key: "memberModelFollowsLead" },
  );
});

test("an unavailable lead model fails the task member's apply like the lead's", async (t) => {
  const { f, parent, member } = await teamWith(t, "task");
  await f.assistants.update(parent.id, { model: second }, parent.revision);
  const config = new AssistantConfig({
    store: f.store,
    client: gateway(),
    workspaces: workspaces(t),
    models: {
      resolve: async (model) => {
        if (model.connectionId === "x")
          throw Object.assign(Error("gone"), { status: 409 });
        return { modelRef: "c/m", release() {} };
      },
    },
  });
  await assert.rejects(config.apply(member.assistantId), { message: "gone" });
});

const setLeadModel = (f, id, model) =>
  f.assistants.update(id, { model }, f.store.getAssistant(id).revision);
const finished = (f, team) => {
  for (const m of f.service.store.members(team.id))
    f.service.store.setPhase(m.id, "queued", { phase: "completed" });
  return f.service.store.members(team.id);
};

test("members kept one by one each freeze the lead's model of their own moment", async (t) => {
  const { f, parent, team } = await teamWith(t, "task", 3);
  const [a, b, c] = finished(f, team);
  await setLeadModel(f, parent.id, second);
  await f.service.lifecycle("promote", a.id, a.revision);
  await setLeadModel(f, parent.id, third);
  await f.service.lifecycle("promote", b.id, b.revision);
  await setLeadModel(f, parent.id, first);
  const model = (m) => f.store.getAssistant(m.assistantId).model;
  assert.deepEqual(model(a), second);
  assert.deepEqual(model(b), third);
  assert.deepEqual(model(c), first, "the remaining task member follows the lead");
  const listed = f.service.list().members;
  for (const m of [a, b])
    assert.equal(listed.find((x) => x.id === m.id).overrides.model, false);
});

test("a lifetime change of a whole team freezes each of its members", async (t) => {
  const { f, parent, team } = await teamWith(t, "task", 3);
  const members = finished(f, team);
  const store = f.service.store;
  const done = store.write(store.get(team.id), { phase: "completed" });
  await setLeadModel(f, parent.id, second);
  store.lifecycle(team.id, done.revision, { lifetime: "permanent" });
  await setLeadModel(f, parent.id, third);
  for (const m of members) {
    assert.deepEqual(f.store.getAssistant(m.assistantId).model, second);
    assert.deepEqual(store.member(m.id).snapshot.model, second);
  }
});

test("a task member counts toward its lead's current connection", async (t) => {
  const { f, parent } = await teamWith(t, "task", 2);
  const sync = new AssistantProviderSynchronization({ assistants: f.assistants });
  assert.deepEqual(sync.usage("c"), {
    agents: [{ id: parent.id, name: parent.name }],
    teamMembers: 2,
  });
  await setLeadModel(f, parent.id, second);
  assert.equal(sync.affects("c"), false);
  assert.equal(sync.affects("x"), true);
  assert.deepEqual(sync.usage("c"), { agents: [], teamMembers: 0 });
  assert.deepEqual(sync.usage("x"), {
    agents: [{ id: parent.id, name: parent.name }],
    teamMembers: 2,
  });
});
