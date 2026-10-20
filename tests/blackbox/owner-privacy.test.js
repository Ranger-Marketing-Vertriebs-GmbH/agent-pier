import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const message = (id, text, timestamp) => ({
  role: "user",
  content: text,
  timestamp,
  __openclaw: { id },
});

async function annaChat(f, level = "chat") {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level }],
  });
  const opened = await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  return { user, cookie, agent, id };
}

const optIn = (f, userId, enabled) =>
  f.request(`/api/users/${userId}/owner-may-read`, { method: "PUT", body: { enabled } });

const ownerStream = (f, id) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${f.url.replace("http", "ws")}/api/assistant-conversations/${id}/stream`,
      { headers: { cookie: f.cookie, origin: f.url } },
    );
    const frames = [];
    socket.on("message", (data) => frames.push(JSON.parse(data)));
    socket.on("open", () => resolve({ socket, frames }));
    socket.on("unexpected-response", (_req, res) =>
      reject(new Error(`refused ${res.statusCode}`)),
    );
    socket.on("error", () => {});
  });

// Reads the owner's agent event stream for `ms` and returns its text.
async function capture(f, ms) {
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/assistant-events`, {
    headers: { cookie: f.cookie, origin: f.url, accept: "text/event-stream" },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let text = "";
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
  } catch {
    // Aborted after `ms`.
  }
  clearTimeout(timer);
  return text;
}

test("owner cannot read private chats without opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const { id, agent } = await annaChat(f);
  const messages = await f.request(`/api/assistant-conversations/${id}/messages`);
  assert.equal(messages.status, 404);
  assert.deepEqual(await messages.json(), notFoundBody());
  const sent = await f.request(`/api/assistant-conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "x", text: "Hi" },
  });
  assert.equal(sent.status, 404);
  const list = await (await f.request("/api/assistants")).json();
  assert.ok(list.assistants.some((a) => a.id === agent.id));
  assert.ok(!list.conversations.some((c) => c.id === id));
  assert.equal(
    await upgradeStatus(f, `/api/assistant-conversations/${id}/stream`, f.cookie),
    404,
  );
  const events = capture(f, 1000);
  f.application.assistants.changed({ conversationId: id });
  assert.doesNotMatch(await events, new RegExp(id));
});

test("owner cannot read an own user agent's memory, attachments or browser without opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const { agent, user } = await annaChat(f);
  for (const endpoint of [
    `/api/assistants/${agent.id}/memory`,
    `/api/assistants/${agent.id}/memory/files`,
    `/api/assistants/${agent.id}/browser`,
  ]) {
    const response = await f.request(endpoint);
    assert.equal(response.status, 404, endpoint);
    assert.deepEqual(await response.json(), notFoundBody(), endpoint);
  }
  const cleared = await f.request(`/api/assistants/${agent.id}/attachments`, {
    method: "DELETE",
  });
  assert.equal(cleared.status, 404);
  assert.equal(
    await upgradeStatus(f, `/api/assistants/${agent.id}/browser-stream`, f.cookie),
    404,
  );
  // On a shared agent the memory is everyone's, the owner's too.
  const shared = await sharedAgentOfTwo(f, "chat", ["Carla", "Dora"]);
  const memory = await f.request(`/api/assistants/${shared.agent.id}/memory`);
  assert.notEqual(memory.status, 404);
  // Under the opt-in the owner reads the own agent's memory, but never changes it.
  assert.equal((await optIn(f, user.id, true)).status, 200);
  const read = await f.request(`/api/assistants/${agent.id}/memory`);
  assert.notEqual(read.status, 404);
  const cleared2 = await f.request(`/api/assistants/${agent.id}/attachments`, {
    method: "DELETE",
  });
  assert.equal(cleared2.status, 404);
});

test("opt-in is not retroactive", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { id, user } = await annaChat(f);
  const key = f.application.assistants.store.getConversation(id).runtimeSessionKey;
  const before = Date.now() - 60000;
  gateway.history[key] = [message("m1", "Earlier-text", before)];
  const enabled = await (await optIn(f, user.id, true)).json();
  assert.equal(enabled.ownerMayRead.enabled, true);
  gateway.history[key].push(message("m2", "Later-text", Date.now() + 1000));
  const history = await (
    await f.request(`/api/assistant-conversations/${id}/messages`)
  ).json();
  assert.deepEqual(
    history.messages.map((m) => m.text),
    ["Later-text"],
  );
  const snapshot = await (
    await f.request(`/api/assistant-conversations/${id}/messages?cursor=`)
  ).json();
  assert.doesNotMatch(JSON.stringify(snapshot), /Earlier-text/);
  assert.match(JSON.stringify(snapshot), /Later-text/);
  const { socket, frames } = await ownerStream(f, id);
  for (let i = 0; i < 100 && !frames.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  socket.terminate();
  assert.doesNotMatch(JSON.stringify(frames), /Earlier-text/);
  assert.match(JSON.stringify(frames), /Later-text/);
  // Listed now, but the owner still never writes into her chat.
  const list = await (await f.request("/api/assistants")).json();
  assert.ok(list.conversations.some((c) => c.id === id));
  const sent = await f.request(`/api/assistant-conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "x", text: "Hi" },
  });
  assert.equal(sent.status, 404);
});

test("turning opt-in off closes the owner's stream", async (t) => {
  const { f } = await chatFixture(t);
  const { id, user } = await annaChat(f);
  await optIn(f, user.id, true);
  const { socket } = await ownerStream(f, id);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  assert.equal((await optIn(f, user.id, false)).status, 200);
  assert.equal(await closed, 1008);
  const messages = await f.request(`/api/assistant-conversations/${id}/messages`);
  assert.equal(messages.status, 404);
});

test("re-enabling starts a new since", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { id, user } = await annaChat(f);
  const key = f.application.assistants.store.getConversation(id).runtimeSessionKey;
  const first = (await (await optIn(f, user.id, true)).json()).ownerMayRead.since;
  gateway.history[key] = [message("m1", "While on", Date.parse(first) + 1)];
  await optIn(f, user.id, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = (await (await optIn(f, user.id, true)).json()).ownerMayRead.since;
  assert.ok(Date.parse(second) > Date.parse(first));
  gateway.history[key].push(message("m2", "Again", Date.parse(second) + 1));
  const history = await (
    await f.request(`/api/assistant-conversations/${id}/messages`)
  ).json();
  assert.deepEqual(
    history.messages.map((m) => m.text),
    ["Again"],
  );
});

test("switching the opt-in on again keeps its since", async (t) => {
  const { f } = await chatFixture(t);
  const { user } = await annaChat(f);
  const first = (await (await optIn(f, user.id, true)).json()).ownerMayRead.since;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = (await (await optIn(f, user.id, true)).json()).ownerMayRead;
  assert.deepEqual(again, { enabled: true, since: first });
});

test("the user sees the opt-in state", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await annaChat(f);
  const off = await (await as(f, cookie)("/api/me")).json();
  assert.deepEqual(off.ownerMayRead, { enabled: false, since: null });
  await optIn(f, user.id, true);
  const [audited] = f.application.audit.list({}).events;
  assert.equal(audited.action, "user.updated");
  assert.equal(audited.details.kind, "owner-may-read");
  const on = await (await as(f, cookie)("/api/me")).json();
  assert.equal(on.ownerMayRead.enabled, true);
  assert.ok(Date.parse(on.ownerMayRead.since));
  const invalid = await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: "yes" },
  });
  assert.equal(invalid.status, 400);
  // Users never reach the switch.
  const refused = await as(f, cookie)(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal(refused.status, 404);
});

test("owner inbox never shows a user's approvals", async (t) => {
  const { f } = await chatFixture(t);
  await annaChat(f);
  const inbox = await (await f.request("/api/inbox")).json();
  assert.deepEqual(
    (inbox.items || []).filter((item) => item.type === "action"),
    [],
  );
});

test("opt-in is not retroactive for her queued message and files", async (t) => {
  const { f } = await chatFixture(t);
  const { id, user, cookie } = await annaChat(f);
  const stage = async () => {
    const response = await fetch(
      `${f.url}/api/me/conversations/${id}/attachments?name=dot.png`,
      {
        method: "POST",
        headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
        body: png,
      },
    );
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).id;
  };
  const early = await stage();
  const queued = await as(f, cookie)(`/api/me/conversations/${id}/queued`, {
    method: "POST",
    body: { text: "Queued-before", attachments: [early] },
  });
  assert.equal(queued.status, 200, await queued.clone().text());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await optIn(f, user.id, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const history = await (
    await f.request(`/api/assistant-conversations/${id}/messages`)
  ).json();
  assert.equal(history.queued, null);
  const snapshot = await (
    await f.request(`/api/assistant-conversations/${id}/messages?cursor=`)
  ).json();
  assert.doesNotMatch(JSON.stringify(snapshot), /Queued-before/);
  const before = await f.request(`/api/assistant-attachments/${early}`);
  assert.equal(before.status, 404);
  assert.deepEqual(await before.json(), notFoundBody());
  const later = await stage();
  assert.equal((await f.request(`/api/assistant-attachments/${later}`)).status, 200);
});
