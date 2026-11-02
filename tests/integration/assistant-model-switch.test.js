import test from "node:test";
import assert from "node:assert/strict";
import {
  as,
  chatFixture,
  holdBackgroundPasses,
  pairedTelegram,
  sharedAgentOfTwo,
  userAgent,
} from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { fixtureModel } from "../helpers/user-agents.js";

// OpenRouter names the family before the slash: the fixture runs openai/gpt-4.1-mini.
const model = (agent, modelId) => ({ connectionId: agent.model.connectionId, modelId });
const otherFamily = (agent) => model(agent, "anthropic/claude-sonnet-4.6");
const sameFamily = (agent) => model(agent, "openai/gpt-5");

async function save(f, service, id, body) {
  const { revision } = service.store.getAssistant(id);
  const res = await f.request(`/api/assistants/${id}`, {
    method: "PATCH",
    body: { ...body, revision },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

// Each unarchived main chat of the agent, by person.
const mains = (store, agentId) =>
  store
    .listConversations()
    .filter((c) => c.assistantId === agentId && c.main === true && !c.archivedAt);

// A shared agent of Anna and Ben: the owner, Anna and Ben each have a main chat, and
// Anna has one extra chat.
async function shared(t) {
  const { f, gateway } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const service = f.application.assistants;
  await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" });
  await service.openConversation(agent.id, { userId: anna.user.id });
  await service.openConversation(agent.id, { userId: ben.user.id });
  const annaExtra = await service.chats.create(agent.id, { userId: anna.user.id });
  return { f, gateway, agent, service, store: service.store, annaExtra };
}

// The owner's lead with its main chat, a permanent member done with its task and a
// temporary member at work; each member has its chat. The background passes stand
// still, so the stand-in team rows stay as written.
async function team(t, { ownModel = false } = {}) {
  const { f, gateway } = await chatFixture(t);
  holdBackgroundPasses(f);
  const service = f.application.assistants;
  const lead = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Lead", instructions: "", model: fixtureModel(f) },
    })
  ).json();
  const main = await (
    await f.request(`/api/assistants/${lead.id}/conversations`, { method: "POST" })
  ).json();
  const teams = service.teams.store;
  const request = service.ledger.accept(main.id, { clientRequestId: "team", text: "Go" });
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
  service.ledger.transition(attempt.id, "completed");
  const chatOf = (m) =>
    service.store.saveConversation({
      assistantId: m.assistantId,
      runtimeSessionKey: `member-${m.name}`,
    });
  let [scout, keeper] = teams.members(proposed.id);
  scout = teams.write(scout, { conversationId: chatOf(scout).id, phase: "running" });
  keeper = teams.write(keeper, {
    conversationId: chatOf(keeper).id,
    lifetime: "permanent",
    phase: "completed",
  });
  service.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.lifetime','permanent') WHERE id=?",
    )
    .run(keeper.assistantId);
  if (ownModel) {
    const record = service.store.getAssistant(scout.assistantId);
    service.store.updateAssistant(
      scout.assistantId,
      { model: record.model },
      record.revision,
    );
  }
  return { f, gateway, service, lead, main, teams, scout, keeper };
}

test("a family switch gives every person a fresh main chat and moves Telegram and routines", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "extended" }] },
    { capabilities: { memory: true, reminders: true } },
  );
  const service = f.application.assistants;
  const request = as(f, anna.cookie);
  const paired = await pairedTelegram(f, request, agent.id);
  const routine = await request(`/api/me/agents/${agent.id}/routines`, {
    method: "POST",
    body: {
      clientRequestId: "bank-request",
      name: "bank",
      prompt: "Check bank",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
    },
  });
  assert.equal(routine.status, 201, await routine.clone().text());
  const body = await save(f, service, agent.id, { model: otherFamily(agent) });
  assert.deepEqual(service.store.getAssistant(agent.id).model, otherFamily(agent));
  const { chats, deferred } = body.freshChats;
  assert.deepEqual(deferred, []);
  assert.equal(chats.length, 1);
  const [{ assistantId, userId, from, to }] = chats;
  assert.equal(assistantId, agent.id);
  assert.equal(userId, anna.user.id);
  assert.equal(from, paired.conversationId);
  const old = service.store.getConversation(from);
  const next = service.store.getConversation(to);
  assert.ok(old.archivedAt);
  assert.equal(old.successorId, to);
  assert.equal(next.main, true);
  assert.equal(next.userId, anna.user.id);
  const channels = f.application.assistantChannels;
  assert.equal(channels.store.get(paired.id).conversationId, to);
  const runtimeAgentId = service.store.getAssistant(agent.id).runtimeAgentId;
  const jobs = [...gateway.jobs.values()].filter((j) => j.agentId === runtimeAgentId);
  assert.ok(jobs.length >= 1);
  for (const job of jobs) assert.equal(job.sessionKey, next.runtimeSessionKey);
});

test("every person of a shared agent gets one fresh main chat; other chats stay", async (t) => {
  const { f, agent, service, store, annaExtra } = await shared(t);
  const before = mains(store, agent.id).map((c) => c.id);
  const { freshChats } = await save(f, service, agent.id, { model: otherFamily(agent) });
  assert.equal(freshChats.chats.length, 3);
  assert.deepEqual(freshChats.chats.map((c) => c.from).sort(), before.sort());
  const after = mains(store, agent.id);
  assert.equal(after.length, 3);
  assert.equal(new Set(after.map((c) => c.userId ?? null)).size, 3);
  assert.equal(store.getConversation(annaExtra.id).archivedAt ?? null, null);
});

test("it cancels no work and leaves members and other agents alone", async (t) => {
  const { f, gateway, service, lead, main, teams, scout, keeper } = await team(t, {
    ownModel: true,
  });
  const other = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Other", instructions: "", model: fixtureModel(f) },
    })
  ).json();
  const otherMain = await (
    await f.request(`/api/assistants/${other.id}/conversations`, { method: "POST" })
  ).json();
  // A turn running in the other agent's chat and in the working member's chat.
  const running = (conversationId) =>
    service.ledger.recordAttempt(
      service.ledger.accept(conversationId, { clientRequestId: "r", text: "Hi" }).id,
    );
  const otherTurn = running(otherMain.id);
  const scoutTurn = running(scout.conversationId);
  const { freshChats } = await save(f, service, lead.id, { model: otherFamily(lead) });
  assert.deepEqual(
    freshChats.chats.map((c) => [c.assistantId, c.from]),
    [[lead.id, main.id]],
  );
  const { store } = service;
  for (const id of [scout.conversationId, keeper.conversationId, otherMain.id])
    assert.equal(store.getConversation(id).archivedAt ?? null, null);
  assert.equal(teams.member(scout.id).phase, "running");
  assert.equal(teams.member(keeper.id).conversationId, keeper.conversationId);
  assert.equal(teams.member(scout.id).archivedAt, null);
  const pending = service.ledger.pending().map((a) => a.id);
  assert.ok(pending.includes(otherTurn.id) && pending.includes(scoutTurn.id));
  assert.equal(gateway.calls.filter((c) => c.method === "sessions.abort").length, 0);
  assert.deepEqual(store.getAssistant(other.id).model, other.model);
});

test("freshChats false keeps the chats", async (t) => {
  const { f, agent, service, store } = await shared(t);
  const before = mains(store, agent.id).map((c) => c.id);
  const body = await save(f, service, agent.id, {
    model: otherFamily(agent),
    freshChats: false,
  });
  assert.equal(body.freshChats, undefined);
  assert.deepEqual(service.store.getAssistant(agent.id).model, otherFamily(agent));
  assert.deepEqual(
    mains(store, agent.id).map((c) => c.id),
    before,
  );
});

test("a same-family switch keeps the chats unless asked", async (t) => {
  const { f, agent, service, store } = await shared(t);
  const before = mains(store, agent.id).map((c) => c.id);
  const kept = await save(f, service, agent.id, { model: sameFamily(agent) });
  assert.equal(kept.freshChats, undefined);
  assert.deepEqual(
    mains(store, agent.id).map((c) => c.id),
    before,
  );
  const asked = await save(f, service, agent.id, {
    model: model(agent, "openai/gpt-5-mini"),
    freshChats: true,
  });
  assert.equal(asked.freshChats.chats.length, 3);
  // Saving the same model again is no switch, whatever freshChats says.
  const again = await save(f, service, agent.id, {
    model: model(agent, "openai/gpt-5-mini"),
    freshChats: true,
  });
  assert.equal(again.freshChats, undefined);
});

test("freshChats must be a boolean", async (t) => {
  const { f, agent, service } = await shared(t);
  const { revision } = service.store.getAssistant(agent.id);
  const res = await f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { model: otherFamily(agent), freshChats: "yes", revision },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(service.store.getAssistant(agent.id).model, agent.model);
});

test("following temporary members get fresh chats with the lead", async (t) => {
  const { f, service, lead, main, teams, scout, keeper } = await team(t);
  const { freshChats } = await save(f, service, lead.id, { model: otherFamily(lead) });
  const byAgent = new Map(freshChats.chats.map((c) => [c.assistantId, c]));
  assert.deepEqual([...byAgent.keys()].sort(), [lead.id, scout.assistantId].sort());
  assert.equal(byAgent.get(lead.id).from, main.id);
  const swapped = byAgent.get(scout.assistantId);
  assert.equal(swapped.from, scout.conversationId);
  assert.equal(swapped.userId, null);
  const { store } = service;
  assert.ok(store.getConversation(scout.conversationId).archivedAt);
  assert.equal(teams.member(scout.id).conversationId, swapped.to);
  assert.equal(teams.member(scout.id).phase, "running");
  assert.equal(store.getConversation(keeper.conversationId).archivedAt ?? null, null);
  assert.deepEqual(store.getAssistant(scout.assistantId).model, otherFamily(lead));
});

test("a follower's chat that is not free is deferred, not swapped", async (t) => {
  const { f, service, lead, scout } = await team(t);
  service.queued.put(scout.conversationId, { text: "Later", attachments: [] });
  const { freshChats } = await save(f, service, lead.id, { model: otherFamily(lead) });
  assert.deepEqual(freshChats.deferred, [scout.conversationId]);
  assert.ok(freshChats.chats.every((c) => c.assistantId === lead.id));
  const chat = service.store.getConversation(scout.conversationId);
  assert.equal(chat.archivedAt ?? null, null);
});

test("the owner switching a member swaps the member's chat only", async (t) => {
  const { f, service, lead, main, teams, keeper } = await team(t);
  const agent = service.store.getAssistant(keeper.assistantId);
  const { freshChats } = await save(f, service, keeper.assistantId, {
    model: otherFamily(agent),
  });
  assert.equal(freshChats.chats.length, 1);
  const [{ assistantId, from, to }] = freshChats.chats;
  assert.equal(assistantId, keeper.assistantId);
  assert.equal(from, keeper.conversationId);
  assert.equal(teams.member(keeper.id).conversationId, to);
  const { store } = service;
  assert.equal(store.getConversation(main.id).archivedAt ?? null, null);
  assert.deepEqual(store.getAssistant(lead.id).model, lead.model);
});

test("the fresh chat carries the model-switched note", async (t) => {
  const { f, agent, service } = await shared(t);
  const { freshChats } = await save(f, service, agent.id, { model: otherFamily(agent) });
  const owner = freshChats.chats.find((c) => c.userId === null);
  const notes = service.memoryNotes.forConversation(owner.to);
  assert.deepEqual(
    notes.map((n) => [n.reason, n.details]),
    [
      [
        "model-switched",
        { from: "openai/gpt-4.1-mini", to: "anthropic/claude-sonnet-4.6" },
      ],
    ],
  );
  const history = await (
    await f.request(`/api/assistant-conversations/${owner.to}/messages`)
  ).json();
  assert.ok(
    history.messages.some(
      (m) => m.event === "memory-note" && m.reason === "model-switched",
    ),
  );
});

test("a save through a Gateway restart starts the fresh chats too", async (t) => {
  const { service, lead, main } = await team(t);
  const restarts = [];
  service.webTools = {
    differs: () => true,
    profilesWith: () => service.store.listAssistants(),
    confirm: () => {},
    restart: async (operation) => {
      restarts.push(operation);
      return operation();
    },
  };
  const { revision } = service.store.getAssistant(lead.id);
  const saved = await service.update(
    lead.id,
    { model: otherFamily(lead), browserVisible: true },
    revision,
    { confirmed: true },
  );
  assert.equal(restarts.length, 1);
  assert.ok(saved.freshChats.chats.some((c) => c.from === main.id));
  assert.ok(service.store.getConversation(main.id).archivedAt);
});
