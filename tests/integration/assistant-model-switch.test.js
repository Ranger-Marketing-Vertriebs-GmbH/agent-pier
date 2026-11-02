import test from "node:test";
import assert from "node:assert/strict";
import {
  as,
  chatFixture,
  pairedTelegram,
  sharedAgentOfTwo,
  userAgent,
} from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { switchTeam as team } from "../helpers/model-switch-team.js";
import { deferredSwaps } from "../../server/features/assistants/deferred-swaps.js";

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
  const { f, service, lead, scout, teams } = await team(t);
  service.queued.put(scout.conversationId, { text: "Later", attachments: [] });
  const { freshChats } = await save(f, service, lead.id, { model: otherFamily(lead) });
  assert.deepEqual(freshChats.deferred, [scout.conversationId]);
  assert.ok(freshChats.chats.every((c) => c.assistantId === lead.id));
  const chat = service.store.getConversation(scout.conversationId);
  assert.equal(chat.archivedAt ?? null, null);
  // Held, and swapped once the queued message is gone.
  const swaps = deferredSwaps(service);
  await swaps.tick();
  assert.equal(teams.member(scout.id).conversationId, scout.conversationId);
  service.queued.take(scout.conversationId);
  await swaps.tick();
  const fresh = teams.member(scout.id).conversationId;
  assert.equal(service.store.getConversation(scout.conversationId).successorId, fresh);
  assert.deepEqual(swaps.list(), []);
});

test("an owner's main chat with a message queued is swapped once it is free", async (t) => {
  const { f, service, lead, main } = await team(t);
  service.queued.put(main.id, { text: "Later", attachments: [] });
  const { freshChats } = await save(f, service, lead.id, { model: otherFamily(lead) });
  assert.deepEqual(freshChats.deferred, [main.id]);
  assert.equal(service.store.getConversation(main.id).archivedAt ?? null, null);
  service.queued.take(main.id);
  await deferredSwaps(service).tick();
  const old = service.store.getConversation(main.id);
  assert.ok(old.archivedAt);
  const [next] = mains(service.store, lead.id);
  assert.equal(old.successorId, next.id);
  assert.deepEqual(
    service.memoryNotes.forConversation(next.id).map((n) => n.reason),
    ["model-switched"],
  );
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

// The task member done with its task and on a model of its own, `modelId` at the
// lead's connection.
async function ownModelMember(t, modelId) {
  const s = await team(t);
  const { service, lead, teams } = s;
  const scout = s.teams.write(teams.member(s.scout.id), { phase: "completed" });
  const record = service.store.getAssistant(scout.assistantId);
  service.store.updateAssistant(
    scout.assistantId,
    { model: model(lead, modelId) },
    record.revision,
  );
  assert.equal(service.store.getAssistant(scout.assistantId).ownModel, true);
  return { ...s, scout };
}

test("following the lead again onto another family swaps the member's chat", async (t) => {
  const { f, service, lead, main, teams, scout } = await ownModelMember(
    t,
    "anthropic/claude-sonnet-4.6",
  );
  const { freshChats } = await save(f, service, scout.assistantId, { followLead: true });
  assert.deepEqual(service.store.getAssistant(scout.assistantId).model, lead.model);
  assert.equal(freshChats.chats.length, 1);
  const [{ assistantId, from, to }] = freshChats.chats;
  assert.equal(assistantId, scout.assistantId);
  assert.equal(from, scout.conversationId);
  assert.equal(teams.member(scout.id).conversationId, to);
  assert.equal(service.store.getConversation(main.id).archivedAt ?? null, null);
  const [note] = service.memoryNotes.forConversation(to);
  assert.deepEqual(note.details, {
    from: "anthropic/claude-sonnet-4.6",
    to: "openai/gpt-4.1-mini",
  });
});

test("following the lead again within the family keeps the member's chat", async (t) => {
  const { f, service, lead, scout } = await ownModelMember(t, "openai/gpt-5");
  const body = await save(f, service, scout.assistantId, { followLead: true });
  assert.equal(body.freshChats, undefined);
  assert.deepEqual(service.store.getAssistant(scout.assistantId).model, lead.model);
  const chat = service.store.getConversation(scout.conversationId);
  assert.equal(chat.archivedAt ?? null, null);
});
