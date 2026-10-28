import test from "node:test";
import assert from "node:assert/strict";
import { openLive } from "../helpers/live-socket.js";
import { as, chatFixture, pairedTelegram, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";
import {
  LiveConnection,
  QUEUE_BYTES,
} from "../../server/features/live/live-connection.js";

// The owner's live view of a user's own agent at the moment she withdraws her
// opt-in: nothing read under it reaches him afterwards, neither a late joiner nor a
// frame a slow socket still holds back (live-hub.js resetWhere).

const optIn = (f, userId, enabled) =>
  f.request(`/api/users/${userId}/owner-may-read`, { method: "PUT", body: { enabled } });

// Anna (Extended) with her own agent, her paired bot, one message of hers, and the
// owner's opt-in to read it.
async function annaShared(t) {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  const channel = await pairedTelegram(f, as(f, cookie), agent.id);
  assert.equal((await optIn(f, user.id, true)).status, 200);
  // Written under the opt-in, so the owner reads it (it is not retroactive).
  await f.application.assistantChannels.ingress.receive(channel.id, [
    telegramMessage(2, "Private-telegram"),
  ]);
  return { f, user, agent, channel, topic: `agent.channels:${agent.id}` };
}

const hers = /Private-telegram|"chatId":"\d|"userId":"\d/;

test("a subscriber right after the withdrawal never gets her Telegram", async (t) => {
  const { f, user, topic } = await annaShared(t);
  const first = openLive(f);
  await first.next((frame) => frame.type === "hello");
  first.send({ op: "sub", topic });
  const shown = await first.next((frame) => frame.topic === topic, 5000);
  assert.match(JSON.stringify(shown), /Private-telegram/);
  const late = openLive(f);
  await late.next((frame) => frame.type === "hello");
  assert.equal((await optIn(f, user.id, false)).status, 200);
  // At once: the instance the first socket keeps alive holds her data until it
  // reads again; the joiner must wait for that read.
  late.send({ op: "sub", topic });
  const joined = await late.next((frame) => frame.topic === topic, 5000);
  const { chatId, userId, inputs, notifications } = joined.data.channels[0];
  assert.deepEqual(
    { chatId, userId, inputs, notifications },
    { chatId: null, userId: null, inputs: [], notifications: [] },
  );
  assert.doesNotMatch(JSON.stringify(late.frames), hers);
  // The first socket's frames after the withdrawal hide her too.
  const after = await first.next((frame) => frame.topic === topic, 2000);
  assert.doesNotMatch(JSON.stringify(after), hers);
  first.ws.close();
  late.ws.close();
});

test("a frame a slow socket held back from before the withdrawal is never sent", async (t) => {
  const { f, user, agent, channel, topic } = await annaShared(t);
  const sent = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (text) => sent.push(JSON.parse(text)),
    close() {},
  };
  const connection = new LiveConnection({
    ws,
    hub: f.application.live,
    principal: { role: "owner" },
  });
  t.after(() => connection.close());
  connection.receive(JSON.stringify({ op: "sub", topic }));
  for (let i = 0; i < 100 && !sent.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(JSON.stringify(sent), /Private-telegram/);
  const before = sent.length;
  // The reader falls behind; a new message of hers is pushed and held back.
  ws.bufferedAmount = QUEUE_BYTES + 1;
  await f.application.assistantChannels.ingress.receive(channel.id, [
    telegramMessage(3, "Private-telegram again"),
  ]);
  for (let i = 0; i < 100 && !connection.pending.has(topic); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(JSON.stringify(connection.pending.get(topic)), /again/);
  assert.equal((await optIn(f, user.id, false)).status, 200);
  // Synchronously gone: the held frame is dropped before anything is written.
  assert.doesNotMatch(JSON.stringify(connection.pending.get(topic) ?? null), hers);
  ws.bufferedAmount = 0;
  for (let i = 0; i < 100 && sent.length === before; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const later = sent.slice(before);
  assert.ok(later.length > 0, "the hidden list follows");
  assert.doesNotMatch(JSON.stringify(later), hers);
  assert.equal(later.at(-1).data.channels[0].assistantId, agent.id);
});

test("the agent list never shows a late joiner her chat after the withdrawal", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const opened = await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  assert.equal((await optIn(f, user.id, true)).status, 200);
  const written = await as(f, cookie)(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "after-opt-in", text: "Secret-title-text" },
  });
  assert.ok(written.status < 300, await written.clone().text());
  const listed = await (await f.request("/api/assistants")).json();
  assert.ok(
    listed.conversations.some((c) => c.id === id),
    "listed under the opt-in",
  );
  const first = openLive(f);
  await first.next((frame) => frame.type === "hello");
  first.send({ op: "sub", topic: "agent.list" });
  const shown = await first.next((frame) => frame.topic === "agent.list", 5000);
  assert.match(JSON.stringify(shown), new RegExp(id));
  const late = openLive(f);
  await late.next((frame) => frame.type === "hello");
  const mark = first.frames.length;
  assert.equal((await optIn(f, user.id, false)).status, 200);
  late.send({ op: "sub", topic: "agent.list" });
  const joined = await late.next((frame) => frame.topic === "agent.list", 5000);
  assert.equal(joined.type, "snapshot");
  assert.doesNotMatch(JSON.stringify(late.frames), new RegExp(id));
  // The first socket's next frame is a fresh snapshot without her chat.
  const after = await first.next(
    (frame) => frame.topic === "agent.list" && first.frames.indexOf(frame) >= mark,
    3000,
  );
  assert.equal(after.type, "snapshot");
  assert.doesNotMatch(JSON.stringify(after), new RegExp(id));
  first.ws.close();
  late.ws.close();
});
