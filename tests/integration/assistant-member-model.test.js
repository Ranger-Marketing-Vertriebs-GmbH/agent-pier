import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

const first = { connectionId: "c", modelId: "m" },
  second = { connectionId: "x", modelId: "y" };

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

async function teamWith(t, lifetime) {
  const f = teamFixture(t);
  const { team, parent, attempt } = await f.proposal({ count: 1, allowed: false });
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
  return { f, parent, member, g, config };
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
