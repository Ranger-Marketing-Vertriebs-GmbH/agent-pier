import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";

// Reads a user's event stream; `frames()` are the data frames so far.
async function stream(f, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${f.url}/api/me/events`, {
    headers: { cookie, origin: f.url, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = "";
  let ended = false;
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
      }
    } catch {
      // Aborted.
    }
    ended = true;
  })();
  return {
    frames: () =>
      text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))),
    ended: () => ended,
    done,
    close: () => controller.abort(),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("A gets a frame for her conversation and none for B's turn on the shared agent", async (t) => {
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
  const events = await stream(f, anna.cookie);
  t.after(events.close);
  await settle();
  assert.deepEqual(events.frames(), [{ type: "connected" }]);
  await as(f, ben.cookie)(`/api/me/conversations/${benChat}/messages`, {
    method: "POST",
    body: { clientRequestId: "ben", text: "Mine" },
  });
  f.application.assistants.changed({ conversationId: benChat });
  await settle();
  assert.deepEqual(events.frames(), [{ type: "connected" }]);
  f.application.assistants.changed({ conversationId: annaChat });
  await settle();
  assert.deepEqual(events.frames().at(-1), { type: "agents" });
  assert.doesNotMatch(JSON.stringify(events.frames()), new RegExp(benChat));
});

test("the stream closes when A is disabled", async (t) => {
  const { f } = await chatFixture(t);
  const { anna } = await sharedAgentOfTwo(f);
  const events = await stream(f, anna.cookie);
  t.after(events.close);
  await settle();
  const disabled = await f.request(`/api/users/${anna.user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200);
  await Promise.race([events.done, settle().then(settle).then(settle)]);
  assert.equal(events.ended(), true);
});

test("an approval of a chat she left no longer counts for her", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const request = as(f, anna.cookie);
  const opened = await request(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversationId = (await opened.json()).id;
  const events = await stream(f, anna.cookie);
  t.after(events.close);
  await settle();
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
  await settle();
  assert.deepEqual(events.frames().at(-1), { type: "approvals", count: 1 });
  const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members: [{ userId: ben.user.id, level: "chat" }] },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(moved.status, 200, await moved.clone().text());
  assistants.changed();
  await settle();
  // Her badge matches what she can open: nothing.
  assert.deepEqual(await (await request("/api/me/approvals")).json(), { actions: [] });
  assert.deepEqual(
    events.frames().filter((e) => e.type === "approvals"),
    [
      { type: "approvals", count: 1 },
      { type: "approvals", count: 0 },
    ],
  );
});
