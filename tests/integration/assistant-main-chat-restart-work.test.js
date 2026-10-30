import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";

// A shared agent of two users plus the owner's chat, one temporary member at work, one
// permanent member idle and one turn running in a user's extra chat.
async function seeded(t) {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const service = f.application.assistants;
  const owner = await (
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" })
  ).json();
  await service.openConversation(agent.id, { userId: anna.user.id });
  await service.openConversation(agent.id, { userId: ben.user.id });
  const teams = service.teams.store;
  const request = service.ledger.accept(owner.id, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = service.ledger.recordAttempt(request.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [
      { name: "Scout", role: "Research", assignment: "Look around" },
      { name: "Keeper", role: "Notes", assignment: "Keep notes" },
    ],
  });
  if (proposed.phase === "awaiting_approval")
    teams.decide(
      proposed.id,
      { revision: proposed.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(proposed.id);
  const [scout, keeper] = teams.members(proposed.id);
  teams.write(scout, { phase: "running" });
  teams.write(keeper, { lifetime: "permanent", phase: "idle" });
  // Settled in the first turn, so only the user's chat below still runs.
  service.ledger.transition(attempt.id, "completed");
  const extra = service.store.saveConversation({
    assistantId: agent.id,
    userId: anna.user.id,
    runtimeSessionKey: "anna-extra",
  });
  const running = service.ledger.accept(extra.id, { clientRequestId: "r1", text: "Hi" });
  service.ledger.recordAttempt(running.id);
  return { f, agent, anna, scout, keeper, service, owner };
}

test("preview counts people, members and running work", async (t) => {
  const { f, agent } = await seeded(t);
  const res = await f.request(`/api/assistants/${agent.id}/main-chat-restart`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.people, 3);
  assert.deepEqual(body.members, { temporary: 1, permanent: 1 });
  assert.equal(body.work.turns, 1);
  assert.equal(body.work.members, 1);
  assert.deepEqual(Object.keys(body.work).sort(), [
    "approvals",
    "coding",
    "goals",
    "members",
    "requests",
    "teams",
    "turns",
  ]);
});

test("preview refuses users and member agents", async (t) => {
  const { f, agent, anna, scout } = await seeded(t);
  assert.equal(
    (await as(f, anna.cookie)(`/api/assistants/${agent.id}/main-chat-restart`)).status,
    404,
  );
  assert.equal(
    (await f.request(`/api/assistants/${scout.assistantId}/main-chat-restart`)).status,
    400,
  );
});

test("preview counts every kind of running work and no other agent's", async (t) => {
  const { f, agent, anna, service, owner } = await seeded(t);
  const other = (
    await userAgent(f, {
      mode: "shared",
      members: [{ userId: anna.user.id, level: "chat" }],
    })
  ).id;
  const teams = service.teams.store;
  const actions = service.workflows.store;
  const row = (id, kind, parentAssistantId, phase) =>
    teams.insert({ id, kind, parentAssistantId, phase, revision: 1 });
  row("team-waiting", "team", agent.id, "awaiting_approval");
  row("team-other", "team", other, "awaiting_approval");
  row("request-mine", "lead-request", agent.id, "pending");
  row("request-other", "lead-request", other, "pending");
  service.teams.goals.store.insert({ conversationId: owner.id });
  service.teams.goals.store.insert({ conversationId: "other-chat" });
  const action = (key, assistantId, state, payload) =>
    actions.reserve({ assistantId, key, payload, origin: { kind: "owner" }, state });
  action("run", agent.id, "running", { action: "coding_start" });
  action("run-other", other, "running", { action: "coding_start" });
  action("wait", agent.id, "awaiting_approval", { action: "coding_start" });
  action("wait-other", other, "awaiting_approval", { action: "coding_start" });
  service.workflows.sessions.store.insert({
    sessionId: "s1",
    assistantId: agent.id,
    ended: false,
  });
  service.workflows.sessions.store.insert({
    sessionId: "s2",
    assistantId: agent.id,
    ended: true,
  });
  service.workflows.sessions.store.insert({
    sessionId: "s3",
    assistantId: other,
    ended: false,
  });
  const body = await (
    await f.request(`/api/assistants/${agent.id}/main-chat-restart`)
  ).json();
  assert.deepEqual(body.work, {
    turns: 1,
    teams: 1,
    members: 1,
    requests: 1,
    coding: 2,
    goals: 1,
    approvals: 1,
  });
});

test("preview refuses an archived agent", async (t) => {
  const { f, agent, service } = await seeded(t);
  service.store.setArchived(
    agent.id,
    service.store.getAssistant(agent.id).revision,
    new Date().toISOString(),
  );
  assert.equal(
    (await f.request(`/api/assistants/${agent.id}/main-chat-restart`)).status,
    409,
  );
});
