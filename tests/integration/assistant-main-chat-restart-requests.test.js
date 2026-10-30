import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";

const restart = (f, id) =>
  f.request(`/api/assistants/${id}/main-chat-restart`, { method: "POST", body: {} });

// The owner's lead with a temporary member (Scout) and a permanent member (Keeper)
// that has its own chat with a turn running in it.
async function team(t) {
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
  teams.write(scout, { phase: "ready" });
  service.ledger.transition(attempt.id, "completed");
  // Written as TeamStore.lifecycle writes a kept member's record.
  const stored = service.store.getAssistant(keeper.assistantId);
  const member = { ...stored, lifetime: "permanent", revision: stored.revision + 1 };
  service.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(member), member.revision, member.id);
  const chat = service.store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "keeper-chat",
  });
  teams.write(teams.member(keeper.id), {
    lifetime: "permanent",
    conversationId: chat.id,
    phase: "running",
  });
  const turn = service.ledger.accept(chat.id, { clientRequestId: "k1", text: "Check" });
  const running = service.ledger.recordAttempt(turn.id);
  return { f, gateway, service, agent, main, scout, keeper, member, chat, running };
}

// A lead-request record of `agent`'s team as peer-request-rules.js and
// member-reports.js write them.
function record(s, fields) {
  return s.service.teams.store.insert({
    kind: "lead-request",
    revision: 1,
    parentAssistantId: s.agent.id,
    parentConversationId: s.main.id,
    parentRequestId: null,
    parentAttemptId: null,
    leadName: "Lead",
    ownerProof: null,
    writeAllowed: false,
    delivery: null,
    createdAt: new Date().toISOString(),
    ...fields,
  });
}

const peer = (s, from, to, fields) =>
  record(s, {
    type: "question",
    memberId: to.id,
    memberAssistantId: to.assistantId,
    memberName: "Target",
    fromMemberId: from.id,
    fromAssistantId: from.assistantId,
    fromName: "Asker",
    fromConversationId: fields.fromConversationId,
    resultTo: "sender",
    text: "Use the invented rule in the brief",
    origin: { kind: "peer", fromMemberId: from.id },
    runTimeoutMinutes: 30,
    ...fields,
  });

// Ends every open turn, then lets the scheduler dispatch, observe and deliver.
async function settleAndAdvance(service) {
  for (let i = 0; i < 3; i++) {
    for (const a of service.ledger.pending())
      service.ledger.transition(a.id, "cancelled");
    await service.teams.requests.advance();
  }
}

test("no peer request reaches the new main chat after a restart", async (t) => {
  const s = await team(t);
  const { f, service, agent, scout, keeper, chat, running } = s;
  const scoutChat = service.store.saveConversation({
    assistantId: scout.assistantId,
    runtimeSessionKey: "scout-chat",
  });
  const finishedAt = new Date().toISOString();
  peer(s, keeper, scout, {
    id: "peer-done",
    fromConversationId: chat.id,
    phase: "completed",
    finishedAt,
  });
  peer(s, keeper, scout, {
    id: "peer-queued",
    fromConversationId: chat.id,
    phase: "queued",
  });
  // Scout asks Keeper; Keeper's running turn answers it.
  peer(s, scout, keeper, {
    id: "peer-running",
    fromConversationId: scoutChat.id,
    phase: "running",
    attemptId: running.id,
    startedAt: finishedAt,
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const fresh = mainConversation(service.store, agent.id);
  assert.notEqual(fresh.id, s.main.id);
  await settleAndAdvance(service);
  assert.deepEqual(service.ledger.requests(fresh.id), []);
  for (const id of ["peer-done", "peer-queued", "peer-running"]) {
    const r = service.teams.requests.store.get(id);
    assert.equal(r.delivery, "skipped", id);
    assert.equal(r.settled, true, id);
    assert.equal(r.resultDiagnostic, "MAIN_CHAT_RESTARTED", id);
  }
  // The running member turn was aborted, not abandoned.
  const stopped = service.teams.requests.store.get("peer-running");
  assert.equal(stopped.cancelRequested, true);
  assert.equal(stopped.phase, "cancelled");
  assert.equal(service.teams.requests.store.get("peer-queued").phase, "cancelled");
});

test("a member report waiting for delivery never reaches the new main chat", async (t) => {
  const s = await team(t);
  const { f, service, agent, keeper } = s;
  const finishedAt = new Date().toISOString();
  record(s, {
    id: "report-waiting",
    type: "report",
    memberId: keeper.id,
    memberAssistantId: keeper.assistantId,
    memberName: "Keeper",
    text: "Old brief: always apply the invented rule",
    files: [],
    origin: { kind: "member-report", reportKind: "result" },
    phase: "completed",
    finishedAt,
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const fresh = mainConversation(service.store, agent.id);
  await settleAndAdvance(service);
  assert.deepEqual(service.ledger.requests(fresh.id), []);
  const r = service.teams.requests.store.get("report-waiting");
  assert.equal(r.delivery, "skipped");
  assert.equal(r.settled, true);
  assert.equal(r.resultDiagnostic, "MAIN_CHAT_RESTARTED");
});

test("a coding session whose grant was revoked is stopped and never blocks the restart", async (t) => {
  const { f, service, agent } = await team(t);
  const w = service.workflows;
  w.sessions.store.insert({ sessionId: "s1", assistantId: agent.id, ended: false });
  const stopped = [];
  let status = "running";
  w.s.reload = { stop: async (id) => stopped.push(id) && (status = "stopped") };
  t.mock.method(w.s.sessions, "get", async (id) => ({ id, status }));
  t.mock.method(w.access, "eligible", (id) => service.store.getAssistant(id));
  // The agent's grant for the project is gone.
  t.mock.method(w.access, "sessionsEnabled", () => false);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(stopped, ["s1"]);
  const after = w.sessions.store.get("s1");
  assert.equal(after.ended, true);
  assert.equal(after.seen.state, "ended");
  // Nothing is left to stop: a second restart goes through as well.
  assert.equal((await restart(f, agent.id)).status, 200);
});

test("a stray team proposal of a user agent is declined without blocking", async (t) => {
  const { f } = await chatFixture(t);
  const { agent } = await sharedAgentOfTwo(f);
  const service = f.application.assistants;
  await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" });
  service.teams.store.insert({
    id: "team-stray",
    kind: "team",
    parentAssistantId: agent.id,
    phase: "awaiting_approval",
    revision: 1,
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(service.teams.store.get("team-stray").phase, "declined");
});
