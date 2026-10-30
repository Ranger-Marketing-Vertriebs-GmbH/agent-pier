import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";

// A shared agent of two users plus the owner's chat, one temporary member at work, one
// permanent member idle and one turn running in a user's extra chat.
async function seeded(t) {
  const { f, gateway } = await chatFixture(t);
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
  return { f, gateway, agent, anna, scout, keeper, service, owner };
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

const restart = (f, id) =>
  f.request(`/api/assistants/${id}/main-chat-restart`, { method: "POST", body: {} });

// The owner's own lead: a task member at work, an idle permanent member, a pending
// proposal, a queued lead request, an open work goal, a pending approval and a turn
// in an extra chat.
async function ownerLead(t) {
  const { f, gateway } = await chatFixture(t);
  const service = f.application.assistants;
  const agent = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Lead", instructions: "", model: fixtureModel(f) },
    })
  ).json();
  const main = await (
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" })
  ).json();
  const teams = service.teams.store;
  const request = service.ledger.accept(main.id, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = service.ledger.recordAttempt(request.id);
  const team = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [
      { name: "Scout", role: "Research", assignment: "Look around" },
      { name: "Keeper", role: "Notes", assignment: "Keep notes" },
    ],
  });
  if (team.phase === "awaiting_approval")
    teams.decide(
      team.id,
      { revision: team.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(team.id);
  const [scout, keeper] = teams.members(team.id);
  teams.write(scout, { phase: "ready" });
  teams.write(keeper, { lifetime: "permanent", phase: "idle" });
  service.ledger.transition(attempt.id, "completed");
  teams.insert({
    id: "team-waiting",
    kind: "team",
    parentAssistantId: agent.id,
    phase: "awaiting_approval",
    revision: 1,
  });
  teams.insert({
    id: "request-queued",
    kind: "lead-request",
    parentAssistantId: agent.id,
    phase: "queued",
    revision: 1,
  });
  service.teams.goals.store.insert({
    parentAssistantId: agent.id,
    conversationId: main.id,
    title: "Episode",
    done: "Review cut",
    setRequestId: "r",
    anchorRequestId: "r",
    createdAt: 1,
  });
  const approval = service.workflows.store.reserve({
    assistantId: agent.id,
    key: "wait",
    payload: { action: "coding_start" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
  });
  const extra = service.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "lead-extra",
  });
  const running = service.ledger.accept(extra.id, { clientRequestId: "r1", text: "Hi" });
  service.ledger.recordAttempt(running.id);
  return { f, gateway, service, agent, main, scout, keeper, approval, extra };
}

test("restart cancels turns in extra chats without archiving them", async (t) => {
  const { f, gateway, service, agent, anna } = await seeded(t);
  const extra = service.store
    .listConversations()
    .find((c) => c.runtimeSessionKey === "anna-extra");
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(
    gateway.calls.some(
      (c) => c.method === "sessions.abort" && c.params.key === "anna-extra",
    ),
  );
  assert.equal(service.store.getConversation(extra.id).archivedAt ?? null, null);
  const next = await as(f, anna.cookie)(`/api/me/conversations/${extra.id}/messages`, {
    method: "POST",
    body: { clientRequestId: "r2", text: "Still here?" },
  });
  assert.equal(next.status, 202, await next.clone().text());
});

test("restart ends temporary members and declines a pending team proposal", async (t) => {
  const { f, service, agent, scout, keeper } = await ownerLead(t);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const teams = service.teams.store;
  assert.ok(["cancelled", "stopping"].includes(teams.member(scout.id).phase));
  assert.equal(teams.member(keeper.id).phase, "idle");
  assert.equal(teams.member(keeper.id).stopRequested ?? false, false);
  assert.equal(teams.get("team-waiting").phase, "declined");
});

test("restart declines pending approvals with MAIN_CHAT_RESTARTED", async (t) => {
  const { f, service, agent, approval } = await ownerLead(t);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const after = service.workflows.store.get(approval.id);
  assert.equal(after.state, "declined");
  assert.equal(after.diagnostic, "MAIN_CHAT_RESTARTED");
});

test("restart stops open lead requests and work goals", async (t) => {
  const { f, service, agent, main } = await ownerLead(t);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const request = service.teams.requests.store.get("request-queued");
  assert.equal(request.phase, "cancelled");
  assert.equal(request.cancelledBy, "owner");
  assert.equal(service.teams.goals.store.open(main.id) ?? null, null);
});

test("restart result lists what it stopped", async (t) => {
  const { f, agent } = await ownerLead(t);
  const preview = await (
    await f.request(`/api/assistants/${agent.id}/main-chat-restart`)
  ).json();
  assert.deepEqual(preview.work, {
    turns: 1,
    teams: 1,
    members: 1,
    requests: 1,
    coding: 0,
    goals: 1,
    approvals: 1,
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).work, preview.work);
});

test("restart cancels coding runs and stops coding sessions", async (t) => {
  const { f, service, agent } = await ownerLead(t);
  const w = service.workflows;
  w.store.reserve({
    assistantId: agent.id,
    key: "run",
    payload: { action: "coding_start" },
    origin: { kind: "owner" },
    state: "running",
    runId: "run-1",
  });
  w.sessions.store.insert({ sessionId: "s1", assistantId: agent.id, ended: false });
  const cancelled = [];
  const stopped = [];
  t.mock.method(w.s.pipelines, "cancel", async (id) => cancelled.push(id));
  t.mock.method(w.s.pipelines, "get", (id) => ({ id, status: "cancelled" }));
  let status = "running";
  w.s.reload = { stop: async (id) => stopped.push(id) && (status = "stopped") };
  t.mock.method(w.s.sessions, "get", async (id) => ({ id, status }));
  t.mock.method(w.access, "eligible", (id) => service.store.getAssistant(id));
  t.mock.method(w.access, "sessionsEnabled", () => true);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(cancelled, ["run-1"]);
  assert.deepEqual(stopped, ["s1"]);
  assert.equal((await res.json()).work.coding, 2);
});

test("a failing step stops the rest and refuses the swap", async (t) => {
  const { f, gateway, service, agent, main, approval } = await ownerLead(t);
  t.mock.method(service.teams, "stop", async () => {
    throw Object.assign(new Error("team gone"), { status: 503 });
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 503, await res.clone().text());
  assert.equal(service.workflows.store.get(approval.id).state, "declined");
  assert.equal(service.teams.requests.store.get("request-queued").phase, "cancelled");
  assert.ok(
    gateway.calls.some(
      (c) => c.method === "sessions.abort" && c.params.key === "lead-extra",
    ),
  );
  assert.equal(service.store.getConversation(main.id).archivedAt ?? null, null);
});
