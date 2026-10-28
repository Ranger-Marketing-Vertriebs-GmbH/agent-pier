import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { openLive } from "../helpers/live-socket.js";

// What a restricted user's app hears of her changes: her `me.*` live topics
// (live-me-topics.js), which replaced her event stream.

/** A live socket of `cookie`, open and greeted. */
async function live(t, f, cookie) {
  const socket = openLive(f, cookie);
  t.after(() => socket.ws.close());
  await socket.next((frame) => frame.type === "hello");
  return socket;
}

/** Subscribes `topic` and resolves with its first frame. */
function first(socket, topic) {
  socket.send({ op: "sub", topic });
  return socket.next((frame) => frame.topic === topic, 5000);
}

/** The next pushed value of `topic`. */
const pushed = (socket, topic) =>
  socket.next((frame) => frame.topic === topic && frame.type === "state", 5000);

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test("A's list follows her conversation and nothing of B's turn on the shared agent", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const open = async (cookie) =>
    (
      await (
        await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, { method: "POST" })
      ).json()
    ).id;
  const annaChat = await open(anna.cookie);
  const benChat = await open(ben.cookie);
  const socket = await live(t, f, anna.cookie);
  const shown = await first(socket, "me.agents");
  assert.equal(shown.data[0].conversationId, annaChat);
  await as(f, ben.cookie)(`/api/me/conversations/${benChat}/messages`, {
    method: "POST",
    body: { clientRequestId: "ben", text: "Mine" },
  });
  f.application.assistants.changed({ conversationId: benChat });
  await settle();
  // Ben's turn changes nothing she sees: no frame.
  assert.equal(socket.frames.filter((frame) => frame.topic === "me.agents").length, 1);
  await as(f, anna.cookie)(`/api/me/conversations/${annaChat}/messages`, {
    method: "POST",
    body: { clientRequestId: "anna", text: "Hers" },
  });
  f.application.assistants.changed({ conversationId: annaChat });
  const next = await pushed(socket, "me.agents");
  assert.equal(next.data[0].conversationId, annaChat);
  assert.doesNotMatch(JSON.stringify(socket.frames), new RegExp(benChat));
});

test("her live socket closes when A is disabled", async (t) => {
  const { f } = await chatFixture(t);
  const { anna } = await sharedAgentOfTwo(f);
  const socket = await live(t, f, anna.cookie);
  await first(socket, "me.agents");
  const disabled = await f.request(`/api/users/${anna.user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200);
  assert.equal((await socket.closed).code, 1008);
});

test("an approval of a chat she left no longer counts for her", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const request = as(f, anna.cookie);
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversationId = (await opened.json()).id;
  const socket = await live(t, f, anna.cookie);
  assert.deepEqual((await first(socket, "me.approvals")).data, { actions: [] });
  const assistants = f.application.assistants;
  assistants.workflows.store.reserve({
    key: `approval-${conversationId}`,
    assistantId: agent.id,
    conversationId,
    origin: { kind: "user", userId: anna.user.id },
    payload: { action: "memory_write", projectId: "p", title: "Note", content: "x" },
    state: "awaiting_approval",
  });
  assistants.changed();
  const waiting = await pushed(socket, "me.approvals");
  assert.equal(waiting.data.actions.length, 1);
  assert.deepEqual(waiting.data, await (await request("/api/me/approvals")).json());
  const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members: [{ userId: ben.user.id, level: "chat" }] },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(moved.status, 200, await moved.clone().text());
  // Her badge matches what she can open: nothing.
  assert.deepEqual((await pushed(socket, "me.approvals")).data, { actions: [] });
  assert.deepEqual(await (await request("/api/me/approvals")).json(), { actions: [] });
});

test("her list subscribed while agents are off follows them once they start", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const feature = (enabled) =>
    f.request("/api/assistant-feature", { method: "PUT", body: { enabled } });
  assert.equal((await feature(false)).status, 200);
  const socket = await live(t, f, anna.cookie);
  assert.deepEqual((await first(socket, "me.agents")).data, []);
  // Her agent topics are refused while no agent serves her.
  assert.equal((await first(socket, `me.chats:${agent.id}`)).code, "unknown-topic");
  assert.equal((await feature(true)).status, 200);
  const started = await pushed(socket, "me.agents");
  assert.deepEqual(
    started.data.map((a) => a.id),
    [agent.id],
  );
  // The started agents' changes reach her too (the fixture's Gateway stays stopped,
  // so her chat is stored directly).
  const { assistants } = f.application;
  const { id } = assistants.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent:${agent.runtimeAgentId}:anna-after-start`,
    userId: anna.user.id,
  });
  assistants.changed({ conversationId: id });
  assert.equal((await pushed(socket, "me.agents")).data[0].conversationId, id);
});

test("she learns at once when the owner turns reading her chats on or off", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben } = await sharedAgentOfTwo(f);
  const socket = await live(t, f, anna.cookie);
  const shown = await first(socket, "me.account");
  assert.deepEqual(shown.data, {
    user: { id: anna.user.id, username: "Anna", displayName: "Anna" },
    ownerMayRead: { enabled: false, since: null },
  });
  const optIn = (user, enabled) =>
    f.request(`/api/users/${user.id}/owner-may-read`, {
      method: "PUT",
      body: { enabled },
    });
  // Ben's opt-in is not hers.
  assert.equal((await optIn(ben.user, true)).status, 200);
  await settle();
  assert.equal(socket.frames.filter((frame) => frame.topic === "me.account").length, 1);
  assert.equal((await optIn(anna.user, true)).status, 200);
  assert.equal((await pushed(socket, "me.account")).data.ownerMayRead.enabled, true);
  assert.equal((await optIn(anna.user, false)).status, 200);
  assert.deepEqual((await pushed(socket, "me.account")).data.ownerMayRead, {
    enabled: false,
    since: null,
  });
  assert.doesNotMatch(JSON.stringify(socket.frames), /Ben/);
});

test("her Telegram pairing finishing in Telegram reaches her app", async (t) => {
  const { f } = await chatFixture(t);
  f.application.assistantChannels.clientFactory = () => ({
    identity: async () => ({ id: 777, username: "anna_helper_bot" }),
  });
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  const request = as(f, cookie);
  const address = `/api/me/agents/${agent.id}/telegram`;
  const { channel } = await (
    await request(address, { method: "PUT", body: { token: "123456:anna-bot-token" } })
  ).json();
  const { code } = await (
    await request(`${address}/pair`, { method: "POST", body: {} })
  ).json();
  const socket = await live(t, f, cookie);
  const topic = `me.telegram:${agent.id}`;
  assert.equal((await first(socket, topic)).data.channel.paired, false);
  await f.application.assistantChannels.ingress.receive(channel.id, [
    telegramMessage(1, `/start ${code}`),
  ]);
  assert.equal((await pushed(socket, topic)).data.channel.paired, true);
  assert.equal((await (await request(address)).json()).channel.paired, true);
  assert.doesNotMatch(JSON.stringify(socket.frames), /anna-bot-token/);
});

test("her reminders follow her own writes", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "personalize" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const socket = await live(t, f, cookie);
  const topic = `me.reminders:${agent.id}`;
  assert.deepEqual((await first(socket, topic)).data.reminders, []);
  const created = await as(f, cookie)(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: {
      clientRequestId: "dentist-request",
      name: "dentist",
      message: "Remember the dentist",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const next = await pushed(socket, topic);
  assert.deepEqual(
    next.data.reminders.map((reminder) => reminder.name),
    ["dentist"],
  );
});
