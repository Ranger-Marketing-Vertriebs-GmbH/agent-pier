import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";
import { busyChats } from "../../server/features/assistants/agent-chats.js";
import { deleteReleasedSessions } from "../../server/features/users/user-release.js";

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
  // A file the agent shared into the chat, and a memory note shown in it.
  const shared = assistants.attachments.shared;
  const sharedFile = await shared.share({
    conversation,
    requestId: "shared-request",
    name: "notes.txt",
    body: Buffer.from("Shared secret"),
  });
  const sharedCopy = path.join(
    (await shared.folder(agent.id, false)).path,
    shared.rows("id=?", sharedFile.id)[0].file,
  );
  assert.ok(fs.existsSync(sharedCopy));
  assistants.memoryNotes.record({
    key: "turn-1:forwarded",
    conversationId: second,
    reason: "forwarded",
  });
  assert.equal(assistants.memoryNotes.forConversation(second).length, 1);
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
  assert.ok(!fs.existsSync(sharedCopy));
  assert.deepEqual(assistants.memoryNotes.forConversation(second), []);
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
  const stored = assistants.store.storedConversation(second);
  assert.equal(stored.nativeDeletePending, false);
  // Its title came from her first message: it goes with the chat.
  assert.equal(stored.title, null);
  assert.equal(stored.lastActivityAt, null);
  assert.doesNotMatch(JSON.stringify(stored), /Secret plans/);
  // The audit names the deletion, never the title.
  const events = f.application.audit.list({ action: "assistant.updated" }).events;
  const event = events.find((e) => e.details?.kind === "chat-deleted");
  assert.ok(event);
  assert.doesNotMatch(JSON.stringify(events), /Secret plans/);
});

test("a chat deleted while the Gateway is away loses its session at the next start", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(second).runtimeSessionKey;
  gateway.client.ready = false;
  const deleted = await f.request(routes(false).chat(second), {
    method: "DELETE",
    body: { confirm: true },
  });
  assert.equal(deleted.status, 204, await deleted.clone().text());
  const nativeDeletes = () =>
    gateway.calls.filter((c) => c.method === "sessions.delete" && c.params.key === key);
  assert.equal(nativeDeletes().length, 0);
  assert.equal(assistants.store.storedConversation(second).nativeDeletePending, true);
  gateway.client.ready = true;
  await deleteReleasedSessions({ assistants });
  assert.equal(nativeDeletes().length, 1);
  assert.equal(nativeDeletes()[0].params.deleteTranscript, true);
  assert.equal(assistants.store.storedConversation(second).nativeDeletePending, false);
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

test("a legacy main chat and a team member's chat cannot be archived or deleted", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const store = f.application.assistants.store;
  // Stored before chats had a main flag, and not read since the upgrade.
  const legacy = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:legacy:1",
  });
  // A member's chat (team-provisioning.js) carries no main flag either.
  const member = store.reserveMember({
    id: "member-1",
    parent: agent.id,
    assignment: { name: "Researcher" },
    snapshot: { model: agent.model },
    teamId: "team-1",
    lifetime: "permanent",
  });
  const memberChat = store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "agent:member:1",
  });
  const r = routes(false);
  for (const [id, status, code] of [
    [legacy.id, 409, "CHAT_MAIN"],
    [memberChat.id, 400, undefined],
  ])
    for (const [endpoint, method, body] of [
      [`${r.chat(id)}/archive`, "POST"],
      [r.chat(id), "DELETE", { confirm: true }],
    ]) {
      const refused = await f.request(endpoint, { method, ...(body && { body }) });
      assert.equal(refused.status, status, endpoint);
      if (code) assert.equal((await refused.json()).code, code);
    }
  for (const id of [legacy.id, memberChat.id]) {
    assert.equal(store.getConversation(id).archivedAt ?? null, null);
    assert.equal(store.getConversation(id).deletedAt ?? null, null);
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

test("a chat a team or lead request still reports into cannot be archived or deleted", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const teams = f.application.assistants.teams.store;
  const r = routes(false);
  const refused = async () => {
    for (const [endpoint, method, body] of [
      [`${r.chat(second)}/archive`, "POST"],
      [r.chat(second), "DELETE", { confirm: true }],
    ]) {
      const response = await f.request(endpoint, { method, ...(body && { body }) });
      assert.equal(response.status, 409, endpoint);
      assert.equal((await response.json()).code, "CHAT_BUSY");
    }
  };
  // Its members still work after the lead's turn ended.
  const team = teams.insert({
    id: "team-1",
    kind: "team",
    revision: 1,
    parentAssistantId: agent.id,
    parentConversationId: second,
    phase: "running",
  });
  await refused();
  // Finished, but its result is not yet sent into the chat.
  const finished = teams.write(team, {
    phase: "completed",
    resultBatch: [],
    resultState: "queued",
  });
  await refused();
  teams.write(finished, { resultState: "skipped" });
  // A lead's request to its member not yet delivered holds the chat too.
  const request = teams.insert({
    id: "request-1",
    kind: "lead-request",
    revision: 1,
    parentAssistantId: agent.id,
    parentConversationId: second,
    phase: "running",
  });
  await refused();
  teams.write(request, { phase: "completed", settled: true });
  await json(await f.request(`${r.chat(second)}/archive`, { method: "POST" }), 200);
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

test("a retried deletion removes the archive of a session the first try already deleted", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(second).runtimeSessionKey;
  const sessions = path.join(
    assistants.runtime.paths.state,
    "agents",
    agent.runtimeAgentId,
    "sessions",
  );
  const archive = path.join(sessions, "session-x.jsonl.deleted.2026-10-21T08-00-00.000Z");
  let exists = true;
  const call = gateway.client.call;
  gateway.client.call = async (method, params) => {
    if (params?.key !== key) return call(method, params);
    if (method === "sessions.describe") {
      if (!exists) throw new Error("session not found");
      return { session: { sessionId: "session-x" } };
    }
    if (method === "sessions.delete") {
      // Deleted on the Gateway, but its answer never arrives.
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(archive, "her transcript");
      exists = false;
      throw new Error("timeout");
    }
    return call(method, params);
  };
  const deleted = await f.request(routes(false).chat(second), {
    method: "DELETE",
    body: { confirm: true },
  });
  assert.equal(deleted.status, 204, await deleted.clone().text());
  assert.ok(fs.existsSync(archive));
  assert.equal(assistants.store.storedConversation(second).nativeDeletePending, true);
  // The next try: the session is gone, deleting the missing key succeeds.
  gateway.client.call = async (method, params) =>
    params?.key === key && method === "sessions.describe"
      ? Promise.reject(new Error("session not found"))
      : call(method, params);
  await deleteReleasedSessions({ assistants });
  assert.ok(!fs.existsSync(archive));
  assert.equal(assistants.store.storedConversation(second).nativeDeletePending, false);
});

test("a chat an approved SSH command, coding run or memory write still owes a turn stays busy", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const actions = f.application.assistants.workflows.store;
  const r = routes(false);
  const archive = () => f.request(`${r.chat(second)}/archive`, { method: "POST" });
  const action = (key, payload, patch) =>
    actions.patch(
      actions.reserve({ key, assistantId: agent.id, conversationId: second, payload }).id,
      patch,
    );
  // Approved after the agent's call returned: the result goes into the chat later.
  const ssh = action("ssh", { action: "ssh" }, { state: "executing", followUp: true });
  // A member's run the team summary may list as pending reports to the parent chat.
  const coding = action(
    "coding",
    { action: "coding_start" },
    { state: "running", requestedBy: "member-1" },
  );
  // A declined project-knowledge write is reported once.
  const memory = action("memory", { action: "memory_write" }, { state: "declined" });
  for (const [owing, done] of [
    [ssh, { state: "completed", followUpSent: true }],
    [coding, { state: "completed", parentResult: { attemptId: "x" } }],
    [memory, { memoryFollowUp: { attemptId: "y" } }],
  ]) {
    const refused = await archive();
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "CHAT_BUSY");
    actions.patch(owing.id, done);
  }
  // An SSH call that got its own result, or a run that is unknown, owes nothing.
  action("ssh-delivered", { action: "ssh" }, { state: "completed", delivered: true });
  action("lost", { action: "coding_start" }, { state: "unknown", requestedBy: "m" });
  await json(await archive(), 200);
});

test("busy chats read team members once however many teams ended", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const teams = f.application.assistants.teams.store;
  for (let n = 0; n < 20; n++) {
    teams.insert({
      id: `team-${n}`,
      kind: "team",
      revision: 1,
      parentAssistantId: agent.id,
      parentConversationId: second,
      phase: "completed",
    });
    teams.insert({
      id: `member-${n}`,
      kind: "member",
      revision: 1,
      teamId: `team-${n}`,
      phase: "completed",
    });
  }
  let reads = 0;
  const members = teams.members.bind(teams);
  teams.members = (...args) => (reads++, members(...args));
  t.after(() => delete teams.members);
  assert.equal(busyChats(f.application.assistants).has(second), false);
  assert.equal(reads, 1);
  // A member still at work keeps its ended team's chat busy.
  teams.write(teams.get("member-7"), { phase: "running" });
  const refused = await f.request(`${routes(false).chat(second)}/archive`, {
    method: "POST",
  });
  assert.equal(refused.status, 409);
});
