import test from "node:test";
import assert from "node:assert/strict";
import { openLive } from "../helpers/live-socket.js";
import {
  as,
  chatFixture,
  pairedTelegram,
  sharedAgentOfTwo,
  userAgent,
} from "../helpers/user-chats.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { userRoutes, userTopics } from "../../server/http/route-access.js";
import { ME_TOPICS } from "../../server/features/users/live-me-topics.js";
import {
  LiveConnection,
  MAX_TOPICS,
  QUEUE_BYTES,
} from "../../server/features/live/live-connection.js";
import { MAX_SOCKETS_PER_PRINCIPAL } from "../../server/http/live-websocket.js";

// A restricted user's `me.*` topics (live-me-topics.js): each carries exactly what
// its /api/me route answers her, scoped to her alone; anyone else, the owner too,
// gets unknown-topic, and an agent taken away from her is revoked at once.

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** A live socket of `cookie`, open and greeted. */
async function live(t, f, cookie) {
  const socket = openLive(f, cookie);
  t.after(() => socket.ws.close());
  await socket.next((frame) => frame.type === "hello");
  return socket;
}

/** Subscribes `topic` and resolves with its first frame. */
function first(socket, topic, have) {
  socket.send({ op: "sub", topic, ...(have && { have }) });
  return socket.next((frame) => frame.topic === topic, 5000);
}

const reminderBody = (name) => ({
  clientRequestId: `${name}-request`,
  name,
  message: `Remember ${name}`,
  schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
});

const access = (f, agentId, members) =>
  f.request(`/api/user-agents/${agentId}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members },
      revision: f.application.assistants.store.getAssistant(agentId).revision,
    },
  });

// The routes behind the topics, with one topic id and path each for Anna's agent.
const routeOf = (name, agentId) =>
  ({
    "me.account": ["me.account", "/api/me"],
    "me.agents": ["me.agents", "/api/me/agents"],
    "me.approvals": ["me.approvals", "/api/me/approvals"],
    "me.chats": [`me.chats:${agentId}`, `/api/me/agents/${agentId}/chats`],
    "me.telegram": [`me.telegram:${agentId}`, `/api/me/agents/${agentId}/telegram`],
    "me.reminders": [`me.reminders:${agentId}`, `/api/me/agents/${agentId}/reminders`],
  })[name];

test("every userTopics entry carries only data its /api/me route returns", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "extended" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const request = as(f, cookie);
  await pairedTelegram(f, request, agent.id);
  const created = await request(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: reminderBody("dentist"),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversationId = (await opened.json()).id;
  f.application.assistants.workflows.store.reserve({
    key: `approval-${conversationId}`,
    assistantId: agent.id,
    conversationId,
    origin: { kind: "user", userId: user.id },
    payload: { action: "memory_write", projectId: "p", title: "Note", content: "x" },
    state: "awaiting_approval",
  });
  // Exactly the six topics, each on its GET route.
  const routed = userRoutes.filter((route) => route.topic);
  assert.equal(userTopics.length, ME_TOPICS.length);
  assert.deepEqual(routed.map((route) => route.method).sort(), Array(6).fill("GET"));
  const socket = await live(t, f, cookie);
  const covered = new Set();
  for (const name of ME_TOPICS) {
    const [topic, path] = routeOf(name, agent.id);
    const route = routed.find((r) => r.topic.test(topic));
    assert.ok(route, `${topic} has a route`);
    assert.match(path, route.pattern, `${topic} carries ${path}`);
    covered.add(route);
    const frame = await first(socket, topic);
    assert.equal(frame.type, "snapshot", `${topic}: ${JSON.stringify(frame)}`);
    const answer = await request(path);
    assert.equal(answer.status, 200, path);
    assert.deepEqual(frame.data, await answer.json(), topic);
  }
  assert.equal(covered.size, routed.length);
  // Not empty answers: each one shows her own data.
  const shown = JSON.stringify(socket.frames);
  for (const part of [conversationId, "dentist", "anna_helper_bot", "Anna"])
    assert.match(shown, new RegExp(part));
});

test("two users never receive each other's frames", async (t) => {
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
  const topics = ["me.agents", "me.approvals", `me.chats:${agent.id}`];
  const annaLive = await live(t, f, anna.cookie);
  const benLive = await live(t, f, ben.cookie);
  for (const topic of topics) {
    assert.equal((await first(annaLive, topic)).type, "snapshot");
    assert.equal((await first(benLive, topic)).type, "snapshot");
  }
  // One instance per user and topic, also for the same agent's topic id.
  const keys = [...f.application.live.instances.keys()].map((key) => JSON.parse(key));
  const chatKeys = keys.filter(([id]) => id === `me.chats:${agent.id}`);
  assert.deepEqual(
    chatKeys.map(([, scope]) => scope).sort(),
    [`user:${anna.user.id}`, `user:${ben.user.id}`].sort(),
  );
  // Ben starts a chat and writes in it: Anna's frames never name it.
  const benThird = await (
    await as(f, ben.cookie)(`/api/me/agents/${agent.id}/chats`, { method: "POST" })
  ).json();
  await as(f, ben.cookie)(`/api/me/conversations/${benThird.id}/messages`, {
    method: "POST",
    body: { clientRequestId: "ben", text: "Ben-private-text" },
  });
  f.application.assistants.workflows.store.reserve({
    key: `approval-${benChat}`,
    assistantId: agent.id,
    conversationId: benChat,
    origin: { kind: "user", userId: ben.user.id },
    payload: { action: "memory_write", projectId: "p", title: "Ben's", content: "x" },
    state: "awaiting_approval",
  });
  f.application.assistants.changed({ conversationId: benChat });
  const benSaw = await benLive.next(
    (frame) => frame.topic === `me.chats:${agent.id}` && frame.type === "state",
    5000,
  );
  assert.match(JSON.stringify(benSaw), new RegExp(benThird.id));
  await benLive.next(
    (frame) => frame.topic === "me.approvals" && frame.type === "state",
    5000,
  );
  // Anna's chat is announced to her alone.
  const annaThird = await (
    await as(f, anna.cookie)(`/api/me/agents/${agent.id}/chats`, { method: "POST" })
  ).json();
  const annaSaw = await annaLive.next(
    (frame) => frame.topic === `me.chats:${agent.id}` && frame.type === "state",
    5000,
  );
  assert.match(JSON.stringify(annaSaw), new RegExp(annaThird.id));
  await settle();
  const annaFrames = JSON.stringify(annaLive.frames);
  const benFrames = JSON.stringify(benLive.frames);
  for (const id of [benChat, benThird.id, "Ben-private-text", "Ben's"])
    assert.doesNotMatch(annaFrames, new RegExp(id));
  for (const id of [annaChat, annaThird.id])
    assert.doesNotMatch(benFrames, new RegExp(id));
});

test("an owner subscribing to me.agents gets unknown-topic", async (t) => {
  const { f } = await chatFixture(t);
  const { agent } = await sharedAgentOfTwo(f);
  const owner = await live(t, f, f.cookie);
  for (const name of ME_TOPICS) {
    const [topic] = routeOf(name, agent.id);
    assert.deepEqual(await first(owner, topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  }
});

test("a user's me.chats for an agent she does not have gets unknown-topic", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben } = await sharedAgentOfTwo(f);
  const bens = await userAgent(f, {
    mode: "own",
    members: [{ userId: ben.user.id, level: "extended" }],
  });
  const socket = await live(t, f, anna.cookie);
  for (const topic of [
    `me.chats:${bens.id}`,
    `me.telegram:${bens.id}`,
    `me.reminders:${bens.id}`,
    "me.chats:unknown-agent",
    "me.chats",
    "me.agents:x",
    "state",
    "agent.list",
    `agent.reminders:${bens.id}`,
  ])
    assert.deepEqual(await first(socket, topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  // Unknown and refused look alike: nothing in the answer names Ben's agent.
  assert.doesNotMatch(JSON.stringify(socket.frames), /Ben|Family/);
});

test("removing her agent sends revoked", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const topic = `me.chats:${agent.id}`;
  const annaLive = await live(t, f, anna.cookie);
  const benLive = await live(t, f, ben.cookie);
  await first(annaLive, topic);
  await first(annaLive, "me.agents");
  await first(benLive, topic);
  const removed = await access(f, agent.id, [{ userId: ben.user.id, level: "chat" }]);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual(await annaLive.next((frame) => frame.type === "revoked"), {
    type: "revoked",
    topic,
  });
  // Her list follows without the agent; Ben keeps his topic.
  const list = await annaLive.next(
    (frame) => frame.topic === "me.agents" && frame.type === "state",
    5000,
  );
  assert.deepEqual(list.data, []);
  await settle();
  assert.equal(
    benLive.frames.some((frame) => frame.type === "revoked"),
    false,
  );
  // Subscribing again is refused like an unknown topic.
  assert.equal((await first(annaLive, topic)).code, "unknown-topic");
});

test("a revoked frame replaces what her slow socket held, synchronously", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const topic = `me.chats:${agent.id}`;
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
    principal: { role: "user", userId: anna.user.id },
  });
  t.after(() => connection.close());
  connection.receive(JSON.stringify({ op: "sub", topic }));
  for (let i = 0; i < 100 && !sent.length; i++) await settle(20);
  assert.equal(sent[0].type, "snapshot");
  // Her reader falls behind; her new chat is pushed and held back.
  ws.bufferedAmount = QUEUE_BYTES + 1;
  const chat = await (
    await as(f, anna.cookie)(`/api/me/agents/${agent.id}/chats`, { method: "POST" })
  ).json();
  for (let i = 0; i < 100 && !connection.pending.has(topic); i++) await settle(20);
  assert.match(JSON.stringify(connection.pending.get(topic)), new RegExp(chat.id));
  // The owner takes the agent from her: in the same tick, nothing of it is held.
  const { assistants } = f.application;
  assistants.store.setUserAccess(
    agent.id,
    { mode: "shared", members: [{ userId: ben.user.id, level: "chat" }] },
    assistants.store.getAssistant(agent.id).revision,
  );
  assistants.changed();
  assert.deepEqual(connection.pending.get(topic), { type: "revoked", topic });
  ws.bufferedAmount = 0;
  connection.flush();
  assert.deepEqual(sent.slice(1), [{ type: "revoked", topic }]);
  // No instance of hers is left to answer a late joiner.
  const scopes = [...f.application.live.instances.keys()].map((k) => JSON.parse(k)[1]);
  assert.equal(scopes.includes(`user:${anna.user.id}`), false);
});

test("her agent given back answers a fresh snapshot, never the revoked revision", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const topic = `me.chats:${agent.id}`;
  const socket = await live(t, f, anna.cookie);
  const shown = await first(socket, topic);
  const both = [
    { userId: anna.user.id, level: "chat" },
    { userId: ben.user.id, level: "chat" },
  ];
  assert.equal((await access(f, agent.id, [both[1]])).status, 200);
  await socket.next((frame) => frame.type === "revoked");
  assert.equal((await access(f, agent.id, both)).status, 200);
  const hello = socket.frames.find((frame) => frame.type === "hello");
  const again = await first(socket, topic, {
    instance: hello.instance,
    revision: shown.revision,
  });
  assert.equal(again.type, "snapshot");
  assert.ok(again.revision > shown.revision);
});

test("her session ending closes her live socket with 1008", async (t) => {
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

test("the socket and subscription caps hold for each user apart", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben } = await sharedAgentOfTwo(f);
  const sockets = [];
  for (let i = 0; i < MAX_SOCKETS_PER_PRINCIPAL; i++)
    sockets.push(await live(t, f, anna.cookie));
  assert.equal(await upgradeStatus(f, "/api/live", anna.cookie), 429);
  // Ben's sockets are counted apart.
  const bens = await live(t, f, ben.cookie);
  for (let i = 0; i < MAX_TOPICS; i++) bens.send({ op: "sub", topic: `me.chats:a${i}` });
  const limited = await first(bens, "me.agents");
  assert.deepEqual(limited, { type: "error", topic: "me.agents", code: "limit" });
});

test("lowering her below Extended revokes her bot's topic at once", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  await pairedTelegram(f, as(f, cookie), agent.id);
  const topic = `me.telegram:${agent.id}`;
  const socket = await live(t, f, cookie);
  assert.equal((await first(socket, topic)).data.channel.paired, true);
  const lowered = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: user.id, level: "chat" }] },
      revision: f.application.assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(lowered.status, 200, await lowered.clone().text());
  assert.deepEqual(await socket.next((frame) => frame.type === "revoked"), {
    type: "revoked",
    topic,
  });
  // A tab that joins afterwards gets no snapshot of the bot the route now refuses.
  const late = await live(t, f, cookie);
  assert.deepEqual(await first(late, topic), {
    type: "error",
    topic,
    code: "unknown-topic",
  });
  assert.equal((await as(f, cookie)(`/api/me/agents/${agent.id}/telegram`)).status, 403);
});

test("ten users' topics add at most one listener to each change source", async (t) => {
  const { f } = await chatFixture(t);
  const app = f.application;
  const sources = {
    "agent events": () => app.assistants.events.listenerCount("update"),
    "agents started": () => app.assistantFeature.events.listenerCount("started"),
    "agents stopped": () => app.assistantFeature.events.listenerCount("stopped"),
    "owner privacy": () => app.ownerPrivacy.listenerCount("changed"),
  };
  const count = () =>
    Object.fromEntries(Object.entries(sources).map(([name, read]) => [name, read()]));
  const users = [];
  for (let i = 0; i < 10; i++) {
    const { user, cookie } = await signedInUser(f, `User${i}`);
    const agent = await userAgent(f, {
      mode: "own",
      members: [{ userId: user.id, level: "extended" }],
    });
    users.push({ cookie, agent });
  }
  const before = count();
  const warnings = [];
  const warned = (warning) => warnings.push(warning.name);
  process.on("warning", warned);
  t.after(() => process.off("warning", warned));
  const sockets = [];
  for (const { cookie, agent } of users) {
    const socket = openLive(f, cookie);
    sockets.push(socket);
    await socket.next((frame) => frame.type === "hello");
    for (const name of ME_TOPICS) {
      const [topic] = routeOf(name, agent.id);
      assert.equal((await first(socket, topic)).type, "snapshot", topic);
    }
  }
  const during = count();
  for (const name of Object.keys(sources))
    assert.ok(
      during[name] - before[name] <= 1,
      `${name}: ${before[name]} → ${during[name]}`,
    );
  // Every instance gone: the shared listeners are gone too.
  for (const socket of sockets) {
    socket.ws.close();
    await socket.closed;
  }
  for (let i = 0; i < 50 && app.live.instances.size; i++) await settle(20);
  assert.deepEqual(count(), before);
  await settle(50);
  assert.deepEqual(
    warnings.filter((name) => name === "MaxListenersExceededWarning"),
    [],
  );
});
