import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import { upgradeStatus } from "../helpers/users.js";
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
