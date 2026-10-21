import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { noteBrowserHandBack } from "../../server/features/assistants/browser-hand-back.js";

const stream = (agentId) => `/api/assistants/${agentId}/browser-stream`;
const opens = (f, endpoint, cookie) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http", "ws") + endpoint, {
      headers: { cookie, origin: f.url },
    });
    socket.on("open", () => resolve(socket));
    socket.on("unexpected-response", (_req, res) =>
      reject(new Error(`refused ${res.statusCode}`)),
    );
    socket.on("error", () => {});
  });
// The close code, or "open" when the socket stayed open.
const closing = (socket) =>
  Promise.race([
    new Promise((resolve) => socket.on("close", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("open"), 3000).unref()),
  ]);

// A shared agent whose users each have a turn running in their own chat.
async function busyFamily(f) {
  const family = await sharedAgentOfTwo(f);
  const turn = async ({ cookie }) => {
    const request = as(f, cookie);
    const { id } = await (
      await request(`/api/me/agents/${family.agent.id}/conversation`, { method: "POST" })
    ).json();
    await request(`/api/me/conversations/${id}/messages`, {
      method: "POST",
      body: { clientRequestId: `turn-${id}`, text: "Look this up" },
    });
    return f.application.assistants.store.getConversation(id);
  };
  const annaChat = await turn(family.anna);
  const benChat = await turn(family.ben);
  // What the tool guard reports when a turn calls the browser (team-bridge.js).
  const drive = (chat) =>
    f.application.assistantTeams.bridge.noteDriver({
      agentId: family.agent.runtimeAgentId,
      sessionKey: chat.runtimeSessionKey,
    });
  return { ...family, annaChat, benChat, drive };
}

test("A watches the shared agent's browser while her turn drives it; B and the owner are refused", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent, annaChat, drive } = await busyFamily(f);
  // Nobody's turn drives it yet: the owner may watch, the users not.
  assert.equal(await upgradeStatus(f, stream(agent.id), anna.cookie), 404);
  drive(annaChat);
  assert.equal(f.application.assistants.liveView.driver(agent.id), anna.user.id);
  const socket = await opens(f, stream(agent.id), anna.cookie);
  socket.terminate();
  assert.equal(await upgradeStatus(f, stream(agent.id), ben.cookie), 404);
  assert.equal(await upgradeStatus(f, stream(agent.id), f.cookie), 404);
  const status = await (
    await as(f, anna.cookie)(`/api/me/agents/${agent.id}/browser`)
  ).json();
  assert.equal(status.watchable, true);
  const other = await (
    await as(f, ben.cookie)(`/api/me/agents/${agent.id}/browser`)
  ).json();
  assert.equal(other.watchable, false);
});

test("after B's turn takes the browser, A is refused", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent, annaChat, benChat, drive } = await busyFamily(f);
  drive(annaChat);
  const socket = await opens(f, stream(agent.id), anna.cookie);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  drive(benChat);
  assert.equal(await closed, 1008);
  assert.equal(await upgradeStatus(f, stream(agent.id), anna.cookie), 404);
  const own = await opens(f, stream(agent.id), ben.cookie);
  own.terminate();
});

test("a user's hold on the shared browser ends after the hand-back lease", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, annaChat, drive } = await busyFamily(f);
  const live = f.application.assistants.liveView;
  live.driverMs = 50;
  drive(annaChat);
  const socket = await opens(f, stream(agent.id), anna.cookie);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  assert.equal(await upgradeStatus(f, stream(agent.id), f.cookie), 404);
  // Her turn made no browser call since: the browser is the owner's again.
  assert.equal(await closed, 1008);
  assert.equal(live.driver(agent.id), null);
  assert.equal(await upgradeStatus(f, stream(agent.id), anna.cookie), 404);
  const owner = await opens(f, stream(agent.id), f.cookie);
  owner.terminate();
});

test("the owner cannot watch an own user agent's browser without opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const { anna } = await sharedAgentOfTwo(f);
  const created = await f.request("/api/user-agents", {
    method: "POST",
    body: {
      name: "Own",
      instructions: "",
      model: f.application.assistants.store.listAssistants()[0].model,
      userAccess: { mode: "own", members: [{ userId: anna.user.id, level: "chat" }] },
    },
  });
  const agent = await created.json();
  assert.equal(await upgradeStatus(f, stream(agent.id), f.cookie), 404);
  const socket = await opens(f, stream(agent.id), anna.cookie);
  socket.terminate();
  await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  const owner = await opens(f, stream(agent.id), f.cookie);
  owner.terminate();
});

test("hand-back notes land in the driver's chat", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, annaChat, benChat, drive } = await busyFamily(f);
  drive(benChat);
  const assistants = f.application.assistants;
  assert.ok(noteBrowserHandBack(assistants, agent.id, "owner"));
  assert.ok(assistants.queued.get(benChat.id));
  assert.equal(assistants.queued.get(annaChat.id), null);
});

test("a user's routine on a shared agent hands the browser to her, not the owner", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const agent = await userAgent(
    f,
    {
      mode: "shared",
      members: [
        { userId: anna.user.id, level: "personalize" },
        { userId: ben.user.id, level: "personalize" },
      ],
    },
    { capabilities: { memory: false, reminders: true } },
  );
  const request = as(f, anna.cookie);
  await request(`/api/me/agents/${agent.id}/conversation`, { method: "POST" });
  const created = await request(`/api/me/agents/${agent.id}/routines`, {
    method: "POST",
    body: {
      clientRequestId: "bank-request",
      name: "bank",
      prompt: "Check my bank",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const binding = f.application.assistants.reminders.bindings.get(
    (await created.json()).id,
  );
  const runtimeAgentId = f.application.assistants.store.getAssistant(
    agent.id,
  ).runtimeAgentId;
  f.application.assistantTeams.bridge.noteDriver({
    agentId: runtimeAgentId,
    sessionKey: `agent:${runtimeAgentId}:cron:${binding.nativeId}:run:r1`,
  });
  assert.equal(f.application.assistants.liveView.driver(agent.id), anna.user.id);
  assert.equal(await upgradeStatus(f, stream(agent.id), f.cookie), 404);
  const socket = await opens(f, stream(agent.id), anna.cookie);
  socket.terminate();
});

// Anna's own agent under her opt-in, its browser open in the owner's view.
async function ownersView(f) {
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  return { anna, agent, socket: await opens(f, stream(agent.id), f.cookie) };
}

test("under the opt-in the owner watches a user's own agent's browser, never drives it", async (t) => {
  const { f } = await chatFixture(t);
  const { socket } = await ownersView(f);
  const errors = [];
  socket.on("message", (data, binary) => {
    if (binary) return;
    const message = JSON.parse(String(data));
    if (message.type === "error") errors.push(message.code);
  });
  for (const type of ["take", "start", "handBack", "key"])
    socket.send(JSON.stringify({ type, key: "a" }));
  for (let i = 0; i < 100 && errors.length < 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  socket.terminate();
  assert.deepEqual(errors, ["VIEW_ONLY", "VIEW_ONLY", "VIEW_ONLY", "VIEW_ONLY"]);
});

// The first state message a new view of `endpoint` gets.
const firstState = (f, endpoint, cookie) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http", "ws") + endpoint, {
      headers: { cookie, origin: f.url },
    });
    socket.on("message", (data, binary) => {
      if (binary) return;
      const message = JSON.parse(String(data));
      if (message.type !== "state") return;
      socket.terminate();
      resolve(message.state);
    });
    socket.on("unexpected-response", (_req, res) =>
      reject(new Error(`refused ${res.statusCode}`)),
    );
    socket.on("error", () => {});
  });

test("the owner's view of a user's own agent's browser says it only watches", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, socket } = await ownersView(f);
  socket.terminate();
  assert.equal((await firstState(f, stream(agent.id), f.cookie)).viewOnly, true);
  // She drives her own agent's browser: her view is not view-only.
  assert.equal((await firstState(f, stream(agent.id), anna.cookie)).viewOnly, undefined);
});

test("under the opt-in the owner's view never moves a user's own agent's browser tab", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, socket } = await ownersView(f);
  const errors = [];
  socket.on("message", (data, binary) => {
    if (binary) return;
    const message = JSON.parse(String(data));
    if (message.type === "error") errors.push(message.code);
  });
  socket.send(JSON.stringify({ type: "select", targetId: "tab-b" }));
  socket.send(JSON.stringify({ type: "follow" }));
  for (let i = 0; i < 100 && errors.length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  socket.terminate();
  assert.deepEqual(errors, ["VIEW_ONLY", "VIEW_ONLY"]);
  assert.equal(
    f.application.assistants.liveView.streams.get(agent.id)?.pinned ?? null,
    null,
  );
});

test("a hand-back note reaches a user's own agent without a recorded driver", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, socket } = await ownersView(f);
  socket.terminate();
  const request = as(f, anna.cookie);
  const { id } = await (
    await request(`/api/me/agents/${agent.id}/conversation`, { method: "POST" })
  ).json();
  const assistants = f.application.assistants;
  assert.equal(assistants.liveView.driver(agent.id), null);
  assert.ok(noteBrowserHandBack(assistants, agent.id, "owner"));
  assert.ok(assistants.queued.get(id));
});

test("turning the opt-in off closes the owner's view of a user's own agent's browser", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, socket } = await ownersView(f);
  const closed = closing(socket);
  const off = await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal(await closed, 1008);
  assert.equal(await upgradeStatus(f, stream(agent.id), f.cookie), 404);
});

test("the owner's driving view closes once a shared agent becomes a user's own under her opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const members = [{ userId: anna.user.id, level: "chat" }];
  const agent = await userAgent(f, { mode: "shared", members });
  await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  // Nobody drives the shared agent: the owner's view may take over.
  const socket = await opens(f, stream(agent.id), f.cookie);
  const closed = closing(socket);
  const switched = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members },
      revision: f.application.assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(switched.status, 200, await switched.clone().text());
  // Still admitted, now to watch: a close the page reconnects after.
  assert.equal(await closed, 4000);
  // He reconnects view-only: watching, never driving.
  const again = await opens(f, stream(agent.id), f.cookie);
  const error = new Promise((resolve) =>
    again.on("message", (data, binary) => {
      if (!binary && JSON.parse(String(data)).type === "error")
        resolve(JSON.parse(String(data)).code);
    }),
  );
  again.send(JSON.stringify({ type: "take" }));
  assert.equal(await error, "VIEW_ONLY");
  again.terminate();
});
