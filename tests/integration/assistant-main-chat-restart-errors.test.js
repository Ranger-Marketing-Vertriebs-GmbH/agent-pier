import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";

const restart = (f, id) =>
  f.request(`/api/assistants/${id}/main-chat-restart`, { method: "POST", body: {} });

// The owner's lead with its main chat and one idle permanent member that has a chat
// of its own and a routine bound to it.
async function keptMember(t) {
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
    objective: "Notes",
    members: [{ name: "Keeper", role: "Notes", assignment: "Keep notes" }],
  });
  if (team.phase === "awaiting_approval")
    teams.decide(
      team.id,
      { revision: team.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(team.id);
  const [keeper] = teams.members(team.id);
  service.ledger.transition(attempt.id, "completed");
  const stored = service.store.getAssistant(keeper.assistantId);
  const member = {
    ...stored,
    lifetime: "permanent",
    capabilities: { ...stored.capabilities, memory: true, reminders: true },
    revision: stored.revision + 1,
  };
  service.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(member), member.revision, member.id);
  const chat = service.store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "keeper-chat",
  });
  teams.write(teams.member(keeper.id), {
    lifetime: "permanent",
    phase: "completed",
    conversationId: chat.id,
  });
  const routine = await f.request(`/api/assistants/${member.id}/routines`, {
    method: "POST",
    body: {
      clientRequestId: "inbox-request",
      name: "inbox",
      prompt: "Check inbox",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
    },
  });
  assert.equal(routine.status, 201, await routine.clone().text());
  return { f, gateway, service, agent, main, keeper, member, chat };
}

// Counts the resyncs of routines and check-ins, which a refused restart never runs.
function resyncs(t, service) {
  const seen = [];
  for (const kind of ["routines", "heartbeats"]) {
    const target = service.reminders[kind];
    const original = target.resync.bind(target);
    t.mock.method(target, "resync", (id) => {
      seen.push([kind, id]);
      return original(id);
    });
  }
  return seen;
}

test("a refused restart repoints nothing and leaves the Gateway alone", async (t) => {
  const { f, gateway, service, agent, member, main } = await keptMember(t);
  const seen = resyncs(t, service);
  const calls = gateway.calls.length;
  assert.equal((await restart(f, member.id)).status, 400);
  t.mock.method(service, "requireReady", () => {
    throw Object.assign(new Error("not ready"), { status: 503 });
  });
  assert.equal((await restart(f, agent.id)).status, 503);
  t.mock.restoreAll();
  const record = service.store.getAssistant(agent.id);
  service.store.setArchived(agent.id, record.revision, new Date().toISOString());
  assert.equal((await restart(f, agent.id)).status, 409);
  assert.deepEqual(seen, []);
  assert.equal(gateway.calls.length, calls);
  assert.equal(service.store.getConversation(main.id).archivedAt ?? null, null);
});

test("a create that fails before any swap repoints nothing", async (t) => {
  const { f, gateway, service, agent, main } = await keptMember(t);
  const seen = resyncs(t, service);
  const logged = t.mock.method(console, "error", () => {});
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.create") throw new Error("gateway gone");
    return call(method, params, options);
  };
  const res = await restart(f, agent.id);
  assert.equal(res.status, 503, await res.clone().text());
  assert.deepEqual(seen, []);
  assert.equal(service.store.getConversation(main.id).archivedAt ?? null, null);
  assert.ok(
    logged.mock.calls.some((c) => c.arguments.some((a) => /gateway gone/.test(a))),
  );
});

test("a failed subscribe after the swap still swaps everyone and answers 503", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const service = f.application.assistants;
  await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" });
  await service.openConversation(agent.id, { userId: anna.user.id });
  await service.openConversation(agent.id, { userId: ben.user.id });
  const before = service.store
    .listConversations()
    .filter((c) => c.assistantId === agent.id && c.main === true);
  const call = gateway.client.call;
  let subscribes = 0;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.messages.subscribe" && ++subscribes === 1)
      throw new Error("socket closed");
    return call(method, params, options);
  };
  const res = await restart(f, agent.id);
  assert.equal(res.status, 503, await res.clone().text());
  assert.equal(subscribes, 3);
  for (const old of before) assert.ok(service.store.getConversation(old.id).archivedAt);
  const fresh = service.store
    .listConversations()
    .filter((c) => c.assistantId === agent.id && c.main === true && !c.archivedAt);
  assert.equal(fresh.length, 3);
  for (const chat of fresh)
    assert.ok(
      service.memoryNotes
        .forConversation(chat.id)
        .some((note) => note.reason === "main-restarted"),
    );
});

test("a failed resync after the swap still answers with the result", async (t) => {
  const { f, service, agent, main } = await keptMember(t);
  const channels = f.application.assistantChannels.store;
  const bot = channels.create({
    assistantId: agent.id,
    conversationId: main.id,
    botId: 9003,
    username: "bot_9003",
    token: "9003:lead-bot-secret-token",
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(service.reminders.routines, "resync", async () => {
    throw Object.assign(new Error("cron gone"), { status: 503 });
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const [{ from, to }] = (await res.json()).chats;
  assert.equal(from, main.id);
  assert.equal(channels.get(bot.id).conversationId, to);
});

test("a failed lead repoint still repoints each member", async (t) => {
  const { f, gateway, service, agent, keeper, member } = await keptMember(t);
  t.mock.method(console, "error", () => {});
  const routines = service.reminders.routines;
  const original = routines.resync.bind(routines);
  t.mock.method(routines, "resync", async (id) => {
    if (id === agent.id) throw new Error("lead resync failed");
    return original(id);
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const next = service.teams.store.member(keeper.id).conversationId;
  const { runtimeSessionKey } = service.store.getConversation(next);
  const jobs = [...gateway.jobs.values()].filter(
    (j) => j.agentId === member.runtimeAgentId,
  );
  assert.equal(jobs.length, 1);
  for (const job of jobs) assert.equal(job.sessionKey, runtimeSessionKey);
});

test("a permanent member whose chat is missing is skipped", async (t) => {
  const { f, service, agent, keeper, main } = await keptMember(t);
  const teams = service.teams.store;
  teams.write(teams.member(keeper.id), { conversationId: "missing-chat" });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.members.restarted, []);
  assert.equal(body.chats[0].from, main.id);
  assert.ok(service.store.getConversation(main.id).archivedAt);
});

test("a turn started between the stop and the swap is cancelled", async (t) => {
  const { f, gateway, service, agent, main } = await keptMember(t);
  const ownerKey = service.store.getConversation(main.id).runtimeSessionKey;
  const admit = service.admit.bind(service);
  let late;
  t.mock.method(service, "admit", (operation) => {
    // A routine or Telegram turn that slipped in after stopWork.
    if (!late) {
      const request = service.ledger.accept(main.id, {
        clientRequestId: "late",
        text: "Morning check",
      });
      late = service.ledger.recordAttempt(request.id);
    }
    return admit(operation);
  });
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(service.store.getConversation(main.id).archivedAt);
  assert.ok(
    gateway.calls.some(
      (c) =>
        c.method === "sessions.abort" &&
        c.params.key === ownerKey &&
        c.params.runId === (late.runtimeRunId || late.id),
    ),
  );
});
