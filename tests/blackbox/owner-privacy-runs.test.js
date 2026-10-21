import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function annaChat(f) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const opened = await as(f, cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const { id } = await opened.json();
  return { user, cookie, id };
}

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

const delta = (gateway, sessionKey, runId, text) =>
  gateway.client.emit("event", {
    event: "chat",
    payload: { sessionKey, runId, state: "delta", message: { content: text } },
  });

test("the owner never streams or reads the reply to her message from before the opt-in", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { id, user, cookie } = await annaChat(f);
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  // Reply deltas come from the fake Gateway.
  assistants.bindEvents();
  const sent = await as(f, cookie)(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "early", text: "Private-question" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  const runId = gateway.sent.at(-1).idempotencyKey;
  delta(gateway, key, runId, "Private-start");
  await pause();
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  await pause();
  const { socket, frames } = await ownerStream(f, id);
  delta(gateway, key, runId, "Private-start and more");
  for (let i = 0; i < 100 && !frames.some((frame) => frame.type === "sync"); i++)
    await pause(20);
  assert.ok(!frames.some((frame) => frame.type === "stream"), JSON.stringify(frames));
  // Her reply ends after the opt-in, yet stays hers in the history.
  gateway.history[key] = [
    {
      role: "user",
      content: "Private-question",
      timestamp: Date.now() - 1000,
      idempotencyKey: `${runId}:user`,
      __openclaw: { id: "m1", runId },
    },
    {
      role: "assistant",
      content: "Private-answer",
      timestamp: Date.now() + 1,
      __openclaw: { id: "m2", runId },
    },
  ];
  const history = await (
    await f.request(`/api/assistant-conversations/${id}/messages`)
  ).json();
  assert.doesNotMatch(JSON.stringify(history), /Private-(question|answer)/);
  // A message she writes after the opt-in streams to him.
  for (const attempt of assistants.ledger.pending())
    assistants.ledger.transition(attempt.id, "completed");
  const later = await as(f, cookie)(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "later", text: "Shared-question" },
  });
  assert.equal(later.status, 202, await later.clone().text());
  delta(gateway, key, gateway.sent.at(-1).idempotencyKey, "Shared-answer");
  for (let i = 0; i < 100 && !frames.some((frame) => frame.type === "stream"); i++)
    await pause(20);
  socket.terminate();
  const streamed = frames.filter((frame) => frame.type === "stream");
  assert.deepEqual(
    streamed.map((frame) => frame.text),
    ["Shared-answer"],
  );
});

test("a file her agent shares after the opt-in for an earlier message stays hers", async (t) => {
  const { f } = await chatFixture(t);
  const { id, user, cookie } = await annaChat(f);
  const assistants = f.application.assistants;
  const sent = await as(f, cookie)(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "early", text: "Share-early" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  const [request] = assistants.ledger.requests(id);
  await pause();
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  await pause();
  const conversation = assistants.store.getConversation(id);
  const file = await assistants.attachments.share({
    conversation,
    requestId: request.id,
    name: "early.txt",
    body: Buffer.from("Early-file"),
    caption: "Early-caption",
  });
  const history = await (
    await f.request(`/api/assistant-conversations/${id}/messages`)
  ).json();
  assert.doesNotMatch(JSON.stringify(history), /Early-caption/);
  const snapshot = await (
    await f.request(`/api/assistant-conversations/${id}/messages?cursor=`)
  ).json();
  assert.doesNotMatch(JSON.stringify(snapshot), /Early-caption/);
  assert.equal((await f.request(`/api/assistant-attachments/${file.id}`)).status, 404);
  // She still sees it.
  const own = await as(f, cookie)(`/api/me/attachments/${file.id}`);
  assert.equal(own.status, 200);
});
