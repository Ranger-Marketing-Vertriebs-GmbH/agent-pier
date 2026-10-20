import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function ownerAgent(f) {
  const response = await f.request("/api/assistants", {
    method: "POST",
    body: { name: "Helper", instructions: "", model: fixtureModel(f) },
  });
  return json(response, 201);
}

// The owner's routes, or a user's with `user`.
const routes = (user) => ({
  open: (agentId) =>
    user
      ? `/api/me/agents/${agentId}/conversation`
      : `/api/assistants/${agentId}/conversations`,
  chats: (agentId) =>
    user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
  chat: (id) =>
    user ? `/api/me/conversations/${id}` : `/api/assistant-conversations/${id}`,
});

async function twoChats(request, agentId, user = false) {
  const r = routes(user);
  const main = (await json(await request(r.open(agentId), { method: "POST" }), 200)).id;
  const second = (await json(await request(r.chats(agentId), { method: "POST" }), 201))
    .id;
  return { main, second };
}

const listed = async (request, agentId, user, query = "") =>
  (await json(await request(`${routes(user).chats(agentId)}${query}`), 200)).map(
    (c) => c.id,
  );

test("an archived chat is hidden, read-only and restorable", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const r = routes(true);
  const { main, second } = await twoChats(request, agent.id, true);
  const archived = await json(
    await request(`${r.chat(second)}/archive`, { method: "POST" }),
    200,
  );
  assert.ok(archived.archivedAt);
  assert.deepEqual(await listed(request, agent.id, true), [main]);
  assert.deepEqual(await listed(request, agent.id, true, "?archived=1"), [second]);
  // Still readable, never writable.
  await json(await request(`${r.chat(second)}/messages`), 200);
  for (const [endpoint, body] of [
    [`${r.chat(second)}/messages`, { clientRequestId: "a", text: "Hello" }],
    [`${r.chat(second)}/queued`, { text: "Later" }],
  ]) {
    const refused = await request(endpoint, { method: "POST", body });
    assert.equal(refused.status, 409, endpoint);
    assert.equal((await refused.json()).code, "CHAT_ARCHIVED");
  }
  const rename = await request(r.chat(second), { method: "PATCH", body: { title: "x" } });
  assert.equal(rename.status, 409);
  const restored = await json(
    await request(`${r.chat(second)}/restore`, { method: "POST" }),
    200,
  );
  assert.equal(restored.archivedAt, null);
  const sent = await request(`${r.chat(second)}/messages`, {
    method: "POST",
    body: { clientRequestId: "b", text: "Hello again" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
});

test("delete removes chat and transcript", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const r = routes(true);
  const { second } = await twoChats(request, agent.id, true);
  const assistants = f.application.assistants;
  const conversation = assistants.store.getConversation(second);
  // The native session's id, and the archive OpenClaw keeps of a deleted transcript.
  const call = gateway.client.call;
  gateway.client.call = async (method, params) =>
    method === "sessions.describe" && params.key === conversation.runtimeSessionKey
      ? { session: { sessionId: "session-two" } }
      : call(method, params);
  const sessions = path.join(
    assistants.runtime.paths.state,
    "agents",
    agent.runtimeAgentId,
    "sessions",
  );
  fs.mkdirSync(sessions, { recursive: true });
  const archive = path.join(
    sessions,
    "session-two.jsonl.deleted.2026-10-21T08-00-00.000Z.zst",
  );
  const other = path.join(
    sessions,
    "session-one.jsonl.deleted.2026-10-21T08-00-00.000Z.zst",
  );
  fs.writeFileSync(archive, "transcript");
  fs.writeFileSync(other, "another chat");
  const staged = await fetch(
    `${f.url}/api/me/conversations/${second}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: {
        cookie: anna.cookie,
        origin: f.url,
        "content-type": "application/octet-stream",
      },
      body: png,
    },
  );
  const file = await json(staged, 201);
  await json(
    await request(`${r.chat(second)}/messages`, {
      method: "POST",
      body: { clientRequestId: "a", text: "Secret plans", attachments: [file.id] },
    }),
    202,
  );
  gateway.runs[gateway.sent[0].idempotencyKey] = { status: "ok" };
  await assistants.reconcile();
  const [row] = assistants.attachments.rows(
    "SELECT * FROM agent_attachments WHERE conversation_id=?",
    second,
  );
  const folder = await assistants.attachments.folder(agent.id, false);
  const copy = path.join(folder.path, row.file);
  assert.ok(fs.existsSync(copy));
  const deleted = await request(r.chat(second), {
    method: "DELETE",
    body: { confirm: true },
  });
  assert.equal(deleted.status, 204, await deleted.clone().text());
  assert.ok(
    gateway.calls.some(
      (c) =>
        c.method === "sessions.delete" &&
        c.params.key === conversation.runtimeSessionKey &&
        c.params.deleteTranscript === true,
    ),
  );
  assert.ok(!fs.existsSync(archive));
  assert.ok(fs.existsSync(other));
  assert.ok(!fs.existsSync(copy));
  assert.deepEqual(
    assistants.attachments.rows(
      "SELECT * FROM agent_attachments WHERE conversation_id=?",
      second,
    ),
    [],
  );
  // Gone everywhere: history, list, the store's texts.
  const history = await request(`${r.chat(second)}/messages`);
  assert.equal(history.status, 404);
  assert.ok(!(await listed(request, agent.id, true)).includes(second));
  assert.ok(!(await listed(request, agent.id, true, "?archived=1")).includes(second));
  assert.deepEqual(
    assistants.ledger.requests(second).map((q) => q.text),
    [""],
  );
  assert.equal(assistants.store.storedConversation(second).nativeDeletePending, false);
  // The audit names the deletion, never the title.
  const events = f.application.audit.list({ action: "assistant.updated" }).events;
  const event = events.find((e) => e.details?.kind === "chat-deleted");
  assert.ok(event);
  assert.doesNotMatch(JSON.stringify(events), /Secret plans/);
});

test("main chat cannot be archived or deleted", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { main } = await twoChats(f.request, agent.id);
  const r = routes(false);
  for (const [endpoint, method, body] of [
    [`${r.chat(main)}/archive`, "POST"],
    [r.chat(main), "DELETE", { confirm: true }],
  ]) {
    const refused = await f.request(endpoint, { method, ...(body && { body }) });
    assert.equal(refused.status, 409, endpoint);
    assert.equal((await refused.json()).code, "CHAT_MAIN");
  }
});

test("a chat with a turn running cannot be archived or deleted", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const r = routes(false);
  await json(
    await f.request(`${r.chat(second)}/messages`, {
      method: "POST",
      body: { clientRequestId: "a", text: "Work on it" },
    }),
    202,
  );
  for (const [endpoint, method, body] of [
    [`${r.chat(second)}/archive`, "POST"],
    [r.chat(second), "DELETE", { confirm: true }],
  ]) {
    const refused = await f.request(endpoint, { method, ...(body && { body }) });
    assert.equal(refused.status, 409, endpoint);
    assert.equal((await refused.json()).code, "CHAT_BUSY");
  }
});

test("user A cannot archive, restore or delete B's chat", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const { second } = await twoChats(as(f, ben.cookie), agent.id, true);
  const annaRequest = as(f, anna.cookie);
  const r = routes(true);
  for (const [endpoint, method, body] of [
    [`${r.chat(second)}/archive`, "POST"],
    [`${r.chat(second)}/restore`, "POST"],
    [r.chat(second), "DELETE", { confirm: true }],
  ]) {
    const refused = await annaRequest(endpoint, { method, ...(body && { body }) });
    assert.equal(refused.status, 404, endpoint);
    assert.deepEqual(await refused.json(), notFoundBody());
  }
  assert.equal(f.application.assistants.store.getConversation(second).archivedAt, null);
});

test("the owner cannot archive or delete a user's chat", async (t) => {
  const { f } = await chatFixture(t);
  const { ben, agent } = await sharedAgentOfTwo(f);
  const { second } = await twoChats(as(f, ben.cookie), agent.id, true);
  // Even under her opt-in the owner only reads.
  const optIn = await f.request(`/api/users/${ben.user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(optIn.status, 200);
  const r = routes(false);
  for (const [endpoint, method, body] of [
    [`${r.chat(second)}/archive`, "POST"],
    [`${r.chat(second)}/restore`, "POST"],
    [r.chat(second), "DELETE", { confirm: true }],
  ]) {
    const refused = await f.request(endpoint, { method, ...(body && { body }) });
    assert.equal(refused.status, 404, endpoint);
    assert.deepEqual(await refused.json(), notFoundBody());
  }
  assert.ok(f.application.assistants.store.getConversation(second));
});

test("delete without confirm is refused", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  for (const body of [undefined, {}, { confirm: "yes" }]) {
    const refused = await f.request(routes(false).chat(second), {
      method: "DELETE",
      ...(body && { body }),
    });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal((await refused.json()).code, "CHAT_CONFIRM");
  }
  assert.ok(f.application.assistants.store.getConversation(second));
});
