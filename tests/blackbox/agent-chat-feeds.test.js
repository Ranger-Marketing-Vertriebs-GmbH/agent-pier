import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { agentNotice } from "../../server/application/push-notices.js";
import { pushLink } from "../../server/features/notifications/push-content.js";
import { noteBrowserHandBack } from "../../server/features/assistants/browser-hand-back.js";

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function ownerAgent(f, body = {}) {
  return json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f), ...body },
    }),
    201,
  );
}

// The person's main chat and a second chat (the owner's without `user`).
async function twoChats(request, agentId, user = false) {
  const main = (
    await json(
      await request(
        user
          ? `/api/me/agents/${agentId}/conversation`
          : `/api/assistants/${agentId}/conversations`,
        { method: "POST" },
      ),
      200,
    )
  ).id;
  const second = (
    await json(
      await request(
        user ? `/api/me/agents/${agentId}/chats` : `/api/assistants/${agentId}/chats`,
        { method: "POST" },
      ),
      201,
    )
  ).id;
  return { main, second };
}

// A user's event stream; `frames()` are its data frames so far.
async function events(f, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/me/events`, {
    headers: { cookie, origin: f.url, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
      }
    } catch {
      // Aborted.
    }
  })();
  return {
    frames: () =>
      text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))),
    close: () => controller.abort(),
  };
}

test("a turn in chat 2 updates the list without touching chat 1's feed", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { main, second } = await twoChats(f.request, agent.id);
  const assistants = f.application.assistants;
  const frames = { [main]: [], [second]: [] };
  for (const id of [main, second]) {
    const stop = assistants.feeds.subscribe(id, {}, (frame) => frames[id].push(frame));
    t.after(stop);
  }
  await settle();
  const before = frames[main].length;
  assert.ok(before >= 1);
  const announced = [];
  const onConversation = (id) => announced.push(id);
  assistants.events.on("conversation", onConversation);
  t.after(() => assistants.events.off("conversation", onConversation));
  await json(
    await f.request(`/api/assistant-conversations/${second}/messages`, {
      method: "POST",
      body: { clientRequestId: "two", text: "Work in chat two" },
    }),
    202,
  );
  await settle();
  assert.ok(frames[second].length > 1);
  assert.equal(frames[main].length, before);
  assert.deepEqual([...new Set(announced)], [second]);
  // The list shows chat two at work, and newest after the main chat.
  const list = await json(await f.request(`/api/assistants/${agent.id}/chats`), 200);
  assert.deepEqual(
    list.map((c) => [c.id, c.busy]),
    [
      [main, false],
      [second, true],
    ],
  );
  // The agent works while any of its chats does.
  const listed = await json(await f.request("/api/assistants"), 200);
  assert.equal(listed.activity[agent.id].state, "working");
});

test("archiving closes open viewers of that chat", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const { main, second } = await twoChats(request, agent.id, true);
  const open = (id) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${f.url.replace("http", "ws")}/api/assistant-conversations/${id}/stream`,
        { headers: { cookie: anna.cookie, origin: f.url } },
      );
      socket.on("open", () => resolve(socket));
      socket.on("unexpected-response", (_req, res) =>
        reject(new Error(`refused ${res.statusCode}`)),
      );
      socket.on("error", () => {});
    });
  const viewer = await open(second);
  const other = await open(main);
  t.after(() => other.close());
  const closed = new Promise((resolve) => viewer.on("close", (code) => resolve(code)));
  await json(
    await request(`/api/me/conversations/${second}/archive`, { method: "POST" }),
    200,
  );
  assert.equal(await closed, 1001);
  assert.equal(other.readyState, WebSocket.OPEN);
  // An archived chat may still be watched, read-only; a deleted one is gone.
  const again = await open(second);
  again.close();
  await json(
    await request(`/api/me/conversations/${second}/restore`, { method: "POST" }),
    200,
  );
  const watched = await open(second);
  const gone = new Promise((resolve) => watched.on("close", (code) => resolve(code)));
  const deleted = await request(`/api/me/conversations/${second}`, {
    method: "DELETE",
    body: { confirm: true },
  });
  assert.equal(deleted.status, 204);
  // Closed by the end frame, or by the access check that runs on the same change.
  assert.ok([1001, 1008].includes(await gone));
  await assert.rejects(open(second), /refused 404/);
});

test("A's /me/events never announce B's chats", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const annaRequest = as(f, anna.cookie);
  const benRequest = as(f, ben.cookie);
  await twoChats(annaRequest, agent.id, true);
  await twoChats(benRequest, agent.id, true);
  const stream = await events(f, anna.cookie);
  t.after(stream.close);
  await settle();
  const baseline = stream.frames().length;
  // Ben starts a chat, writes in it and renames it: nothing reaches Anna.
  const benThird = await json(
    await benRequest(`/api/me/agents/${agent.id}/chats`, { method: "POST" }),
    201,
  );
  await benRequest(`/api/me/conversations/${benThird.id}/messages`, {
    method: "POST",
    body: { clientRequestId: "ben", text: "Mine" },
  });
  await benRequest(`/api/me/conversations/${benThird.id}`, {
    method: "PATCH",
    body: { title: "Ben's" },
  });
  await settle();
  assert.equal(stream.frames().length, baseline);
  assert.doesNotMatch(JSON.stringify(stream.frames()), new RegExp(benThird.id));
  // Her own new chat is announced for its agent.
  await json(
    await annaRequest(`/api/me/agents/${agent.id}/chats`, { method: "POST" }),
    201,
  );
  await settle();
  assert.deepEqual(stream.frames().slice(baseline), [
    { type: "chats", agentId: agent.id },
  ]);
});

test("push deep links name the chat that produced the event", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { main, second } = await twoChats(f.request, agent.id);
  const assistants = f.application.assistants;
  const notice = agentNotice(assistants, agent.id, second);
  assert.equal(notice.conversationId, second);
  assert.equal(
    pushLink({ kind: "agent-approval", ...notice }),
    `/agents/${agent.id}/chats/${second}`,
  );
  // Without a chat of its own a notice opens the main chat, never the newest one.
  assert.equal(agentNotice(assistants, agent.id).conversationId, main);
  // An archived chat is no target: the main chat is.
  await json(
    await f.request(`/api/assistant-conversations/${second}/archive`, { method: "POST" }),
    200,
  );
  assert.equal(agentNotice(assistants, agent.id, second).conversationId, main);
});

test("reminders deep-link to the main chat", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "personalize" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const request = as(f, anna.cookie);
  const { main, second } = await twoChats(request, agent.id, true);
  // The newer chat is the more recently active one.
  await json(
    await request(`/api/me/conversations/${second}/messages`, {
      method: "POST",
      body: { clientRequestId: "x", text: "Newer" },
    }),
    202,
  );
  const reminders = f.application.assistants.reminders;
  const sent = [];
  reminders.notifications = { notify: async (event) => sent.push(event) };
  const created = await json(
    await request(`/api/me/agents/${agent.id}/reminders`, {
      method: "POST",
      body: {
        clientRequestId: "dentist-request",
        name: "dentist",
        message: "Remember the dentist",
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      },
    }),
    201,
  );
  const binding = reminders.bindings.get(created.id);
  await reminders.complete(created.id, {
    jobId: binding.nativeId,
    runAtMs: 1000,
    status: "ok",
    summary: "Dentist at three",
  });
  await settle(50);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, main);
  assert.equal(pushLink(sent[0]), `/agents/${agent.id}/chats/${main}`);
});

test("hand-back lands in the driving chat", async (t) => {
  const { f } = await chatFixture(t);
  const agent = await ownerAgent(f);
  const { second } = await twoChats(f.request, agent.id);
  const assistants = f.application.assistants;
  const queuedTo = [];
  const queue = assistants.queue.bind(assistants);
  assistants.queue = (id, input) => {
    queuedTo.push(id);
    return queue(id, input);
  };
  // The owner's turn in chat two drove the browser.
  assistants.liveView.setDriver(agent.id, null, second);
  assert.ok(noteBrowserHandBack(assistants, agent.id, "owner"));
  assert.deepEqual(queuedTo, [second]);
  // A user's turn in her second chat on a shared agent.
  const { anna, agent: shared } = await sharedAgentOfTwo(f);
  const chats = await twoChats(as(f, anna.cookie), shared.id, true);
  assistants.liveView.setDriver(shared.id, anna.user.id, chats.second);
  await settle();
  assert.ok(noteBrowserHandBack(assistants, shared.id, "timeout"));
  assert.deepEqual(queuedTo.slice(1), [chats.second]);
  // A driving chat archived since leaves the note in the driver's main chat.
  await settle();
  assistants.store.updateConversation(chats.second, {
    archivedAt: new Date().toISOString(),
  });
  assert.ok(noteBrowserHandBack(assistants, shared.id, "owner"));
  assert.deepEqual(queuedTo.slice(2), [chats.main]);
});

test("owner opt-in lists only readable chats and filters each by since", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const request = as(f, anna.cookie);
  const { main, second } = await twoChats(request, agent.id, true);
  await json(
    await request(`/api/me/conversations/${second}/messages`, {
      method: "POST",
      body: { clientRequestId: "early", text: "Before the opt-in" },
    }),
    202,
  );
  const assistants = f.application.assistants;
  gateway.runs[gateway.sent[0].idempotencyKey] = { status: "ok" };
  await assistants.reconcile();
  // Without the opt-in the owner sees none of her chats.
  assert.equal((await f.request(`/api/assistants/${agent.id}/chats`)).status, 404);
  await settle(20);
  await json(
    await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
      method: "PUT",
      body: { enabled: true },
    }),
    200,
  );
  await settle(20);
  // Chats she has not used since stay out of his list.
  assert.deepEqual(
    await json(await f.request(`/api/assistants/${agent.id}/chats`), 200),
    [],
  );
  const third = await json(
    await request(`/api/me/agents/${agent.id}/chats`, { method: "POST" }),
    201,
  );
  await json(
    await request(`/api/me/conversations/${third.id}/messages`, {
      method: "POST",
      body: { clientRequestId: "late", text: "After the opt-in" },
    }),
    202,
  );
  await json(
    await request(`/api/me/conversations/${second}/messages`, {
      method: "POST",
      body: { clientRequestId: "later", text: "Second, later" },
    }),
    202,
  );
  const listed = await json(await f.request(`/api/assistants/${agent.id}/chats`), 200);
  const byId = Object.fromEntries(listed.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [second, third.id].sort());
  assert.ok(!(main in byId));
  // An earlier chat shows without the title her first message gave it.
  assert.equal(byId[second].title, null);
  assert.equal(byId[third.id].title, "After the opt-in");
  assert.equal(byId[third.id].userId, anna.user.id);
  // Each chat reads from the opt-in on.
  const history = await json(
    await f.request(`/api/assistant-conversations/${second}/messages`),
    200,
  );
  assert.deepEqual(
    history.requests.map((r) => r.text),
    ["Second, later"],
  );
});
