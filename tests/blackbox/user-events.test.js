import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

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

test("a stream opened while agents are off ends once they start, so she reconnects", async (t) => {
  const { f } = await chatFixture(t);
  const { anna } = await sharedAgentOfTwo(f);
  const feature = (enabled) =>
    f.request("/api/assistant-feature", { method: "PUT", body: { enabled } });
  assert.equal((await feature(false)).status, 200);
  const events = await stream(f, anna.cookie);
  t.after(events.close);
  await settle();
  assert.equal(events.ended(), false);
  assert.equal((await feature(true)).status, 200);
  await Promise.race([events.done, settle().then(settle).then(settle)]);
  assert.equal(events.ended(), true);
  // The new stream follows the started agents.
  const again = await stream(f, anna.cookie);
  t.after(again.close);
  await settle();
  assert.deepEqual(again.frames(), [{ type: "connected" }]);
  assert.equal(again.ended(), false);
});

test("she learns at once when the owner turns reading her chats on or off", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben } = await sharedAgentOfTwo(f);
  const events = await stream(f, anna.cookie);
  t.after(events.close);
  await settle();
  const optIn = (user, enabled) =>
    f.request(`/api/users/${user.id}/owner-may-read`, {
      method: "PUT",
      body: { enabled },
    });
  // Ben's opt-in is not hers.
  assert.equal((await optIn(ben.user, true)).status, 200);
  await settle();
  assert.equal(events.frames().filter((e) => e.type === "account").length, 0);
  assert.equal((await optIn(anna.user, true)).status, 200);
  await settle();
  assert.equal((await optIn(anna.user, false)).status, 200);
  await settle();
  assert.equal(events.frames().filter((e) => e.type === "account").length, 2);
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
  const events = await stream(f, cookie);
  t.after(events.close);
  await settle();
  await f.application.assistantChannels.ingress.receive(channel.id, [
    telegramMessage(1, `/start ${code}`),
  ]);
  await settle();
  assert.ok(
    events.frames().some((e) => e.type === "telegram" && e.agentId === agent.id),
    JSON.stringify(events.frames()),
  );
  assert.equal((await (await request(address)).json()).channel.paired, true);
});
