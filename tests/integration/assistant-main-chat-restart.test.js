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
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

const restart = (f, id, request = f.request) =>
  request(`/api/assistants/${id}/main-chat-restart`, { method: "POST", body: {} });

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
  return { f, gateway, anna, ben, agent, service, store: service.store, annaExtra };
}

// Each person's unarchived main chats with the agent.
function mains(store, agentId) {
  const byPerson = new Map();
  for (const c of store.listConversations())
    if (c.assistantId === agentId && c.main === true && !c.archivedAt) {
      const person = c.userId ?? null;
      byPerson.set(person, [...(byPerson.get(person) || []), c.id]);
    }
  return byPerson;
}

// Anna's own agent (Extended) with memory and reminders, so it takes check-ins.
async function ownAgent(t) {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "extended" }] },
    { capabilities: { memory: true, reminders: true } },
  );
  const service = f.application.assistants;
  return { f, gateway, anna, agent, service, request: as(f, anna.cookie) };
}

test("restart archives each person's main chat and opens a fresh one", async (t) => {
  const { f, gateway, agent, store, annaExtra } = await shared(t);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(typeof body.restartedAt, "string");
  const { chats } = body;
  assert.equal(chats.length, 3);
  for (const { userId, from, to } of chats) {
    const old = store.getConversation(from);
    const next = store.getConversation(to);
    assert.ok(old.archivedAt);
    assert.equal(old.main, false);
    assert.equal(next.main, true);
    assert.equal(next.archivedAt, null);
    assert.equal(next.userId ?? null, old.userId ?? null);
    assert.equal(userId, old.userId ?? null);
    assert.notEqual(next.runtimeSessionKey, old.runtimeSessionKey);
  }
  assert.equal(store.getConversation(annaExtra.id).archivedAt ?? null, null);
  assert.ok(
    gateway.created.every((c, i, all) => all.findIndex((d) => d.label === c.label) === i),
  );
  assert.ok(
    chats.every(({ to }) =>
      gateway.created.some((c) => c.label === `AgentPier ${agent.id} main ${to}`),
    ),
  );
  assert.equal(gateway.calls.filter((c) => c.method === "sessions.delete").length, 0);
  for (const [, ids] of mains(store, agent.id)) assert.equal(ids.length, 1);
});

test("the new main chat carries a main-restarted note and the old one stays readable", async (t) => {
  const { f, agent, anna } = await shared(t);
  const { chats } = await (await restart(f, agent.id)).json();
  const owner = chats.find((c) => c.userId === null);
  const history = await (
    await f.request(`/api/assistant-conversations/${owner.to}/messages`)
  ).json();
  assert.ok(
    history.messages.some(
      (m) => m.event === "memory-note" && m.reason === "main-restarted",
    ),
  );
  const old = await f.request(`/api/assistant-conversations/${owner.from}/messages`);
  assert.equal(old.status, 200);
  const archived = await (
    await f.request(`/api/assistants/${agent.id}/chats?archived=1`)
  ).json();
  assert.ok(archived.some((c) => c.id === owner.from));
  const annas = chats.find((c) => c.userId === anna.user.id);
  const hers = await (
    await as(f, anna.cookie)(`/api/me/agents/${agent.id}/chats?archived=1`)
  ).json();
  assert.ok(hers.some((c) => c.id === annas.from));
});

test("telegram ingress after restart lands in the new main chat", async (t) => {
  const { f, agent, service, request } = await ownAgent(t);
  const paired = await pairedTelegram(f, request, agent.id);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const [{ from, to }] = (await res.json()).chats;
  assert.equal(paired.conversationId, from);
  const channels = f.application.assistantChannels;
  const moved = channels.store.get(paired.id);
  assert.equal(moved.conversationId, to);
  assert.equal(moved.chatId, paired.chatId);
  assert.equal(moved.enabled, paired.enabled);
  await channels.ingress.receive(paired.id, [telegramMessage(2, "After the restart")]);
  await channels.ingress.dispatch(paired.id);
  assert.equal(service.ledger.requests(to).length, 1);
  assert.equal(service.ledger.requests(from).length, 0);
});

test("routines and check-ins move to the new session key", async (t) => {
  const { f, gateway, agent, service, request } = await ownAgent(t);
  const record = service.store.getAssistant(agent.id);
  service.store.updateAssistant(
    agent.id,
    { heartbeat: { enabled: true, interval: "4h", start: 0, end: 24, timeZone: "UTC" } },
    record.revision,
  );
  await service.admit(() => service.reminders.heartbeats.sync(agent.id));
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
  const runtimeAgentId = service.store.getAssistant(agent.id).runtimeAgentId;
  const jobs = () =>
    [...gateway.jobs.values()].filter((j) => j.agentId === runtimeAgentId);
  assert.equal(jobs().length, 2);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const [{ from, to }] = (await res.json()).chats;
  const { runtimeSessionKey } = service.store.getConversation(to);
  const old = service.store.getConversation(from).runtimeSessionKey;
  assert.equal(jobs().length, 2);
  for (const job of jobs()) {
    assert.notEqual(job.sessionKey, old);
    assert.equal(job.sessionKey, runtimeSessionKey);
  }
});

test("a failed create leaves one main chat per person and a retry swaps again", async (t) => {
  const { f, gateway, agent, store } = await shared(t);
  const channels = f.application.assistantChannels.store;
  const ownerMain = [...mains(store, agent.id).get(null)][0];
  channels.create({
    assistantId: agent.id,
    conversationId: ownerMain,
    botId: 9001,
    username: "bot_9001",
    token: "9001:owner-bot-secret-token",
  });
  const call = gateway.client.call;
  let creates = 0;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.create" && ++creates === 2) throw new Error("gateway gone");
    return call(method, params, options);
  };
  const failed = await restart(f, agent.id);
  assert.ok(
    failed.status >= 500,
    `status ${failed.status} ${await failed.clone().text()}`,
  );
  const check = () => {
    const byPerson = mains(store, agent.id);
    assert.equal(byPerson.size, 3);
    for (const [, ids] of byPerson) assert.equal(ids.length, 1);
    for (const channel of channels.list())
      if (channel.assistantId === agent.id)
        assert.equal(store.getConversation(channel.conversationId).archivedAt, null);
  };
  check();
  const retried = await restart(f, agent.id);
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await retried.json()).chats.length, 3);
  check();
});

test("users cannot restart", async (t) => {
  const { f, agent, anna, store } = await shared(t);
  const before = mains(store, agent.id);
  const res = await restart(f, agent.id, as(f, anna.cookie));
  assert.equal(res.status, 404);
  assert.deepEqual(mains(store, agent.id), before);
});

test("an archived agent is refused", async (t) => {
  const { f, agent, service } = await shared(t);
  const record = service.store.getAssistant(agent.id);
  service.store.setArchived(agent.id, record.revision, new Date().toISOString());
  assert.equal((await restart(f, agent.id)).status, 409);
});

test("restart is recorded in the activity log", async (t) => {
  const { f, agent, service } = await shared(t);
  const res = await restart(f, agent.id);
  assert.equal(res.status, 200, await res.clone().text());
  const { events } = service.audit.list({
    action: "assistant.main_chat_restarted",
    resourceId: agent.id,
  });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.resourceType, "assistant");
  assert.equal(event.outcome, "success");
  assert.equal(event.source, "user");
  assert.equal(event.details.chats, 3);
  assert.deepEqual(event.details.members, { ended: 0, restarted: 0 });
  assert.deepEqual(event.details.work, {
    turns: 0,
    teams: 0,
    members: 0,
    requests: 0,
    coding: 0,
    goals: 0,
    approvals: 0,
  });
});

test("two restarts in a row both succeed", async (t) => {
  const { f, gateway, agent, store, service } = await shared(t);
  // The first restart waits in its resync, outside admission; the second must not
  // start swapping before the first has finished.
  let release, reached;
  const gate = new Promise((resolve) => (release = resolve));
  const waiting = new Promise((resolve) => (reached = resolve));
  const resync = service.reminders.heartbeats.resync.bind(service.reminders.heartbeats);
  let first = true;
  t.mock.method(service.reminders.heartbeats, "resync", async (id) => {
    if (first) {
      first = false;
      reached();
      await gate;
    }
    return resync(id);
  });
  const before = gateway.created.length;
  const both = Promise.all([restart(f, agent.id), restart(f, agent.id)]);
  await waiting;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(gateway.created.length - before, 3);
  release();
  const responses = await both;
  for (const res of responses) assert.equal(res.status, 200, await res.clone().text());
  const [one, two] = await Promise.all(responses.map((res) => res.json()));
  assert.deepEqual(
    two.chats.map((c) => c.from).sort(),
    one.chats.map((c) => c.to).sort(),
  );
  for (const [, ids] of mains(store, agent.id)) assert.equal(ids.length, 1);
});
