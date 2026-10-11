import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";

function agentChat(f, key) {
  const agent = f.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: key,
  });
  return { agent, chat };
}

test("an agent works while its request runs and is idle after completion", async (t) => {
  const f = teamFixture(t);
  const { agent, chat } = agentChat(f, "home");
  assert.equal(f.assistants.list().activity[agent.id].state, "idle");

  const { attempt } = await f.assistants.send(chat.id, {
    clientRequestId: "plan",
    text: "Plan the week",
  });

  assert.equal(attempt.state, "accepted");
  assert.deepEqual(f.assistants.list().activity[agent.id], {
    state: "working",
    reason: "attempt",
    label: "status.running",
    pendingApprovals: 0,
    team: null,
  });
  f.runs.set(attempt.id, { key: "home", status: "ok" });
  await f.assistants.reconcile();
  assert.equal(f.assistants.list().activity[agent.id].state, "idle");
});

test("a runtime failure marks running requests uncertain and announces the change", async (t) => {
  const f = teamFixture(t);
  const { agent, chat } = agentChat(f, "home");
  await f.assistants.send(chat.id, { clientRequestId: "plan", text: "Plan" });
  const events = [];
  const unsubscribe = f.assistants.events.subscribe((e) => events.push(e.type));
  t.after(unsubscribe);

  f.assistants.runtime.emit("status", { availability: "failed" });

  assert.ok(events.includes("change"), `events were ${events.join(", ")}`);
  assert.deepEqual(
    [
      f.assistants.list().activity[agent.id].state,
      f.assistants.list().activity[agent.id].label,
    ],
    ["attention", "status.uncertain"],
  );
});

test("a team proposal and pending actions make the parent wait with a count", async (t) => {
  const f = teamFixture(t);
  f.assistants.workflows = { store: new AssistantActionStore(f.store.db), close() {} };
  const { parent, chat } = await f.proposal({ count: 2, allowed: false });
  f.assistants.workflows.store.reserve({
    assistantId: parent.id,
    conversationId: chat.id,
    key: "memory",
    payload: { action: "memory_write", content: "Remember" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
  });

  const entry = f.assistants.list().activity[parent.id];

  assert.deepEqual(entry, {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals: 2,
    team: "awaiting",
  });
});

test("the list omits archived agents from activity", async (t) => {
  const f = teamFixture(t);
  const { agent } = agentChat(f, "home");
  const record = f.store.getAssistant(agent.id);
  const next = { ...record, archivedAt: new Date().toISOString(), revision: 2 };
  f.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(next), 2, agent.id);
  assert.equal(f.assistants.list().activity[agent.id], undefined);
});
