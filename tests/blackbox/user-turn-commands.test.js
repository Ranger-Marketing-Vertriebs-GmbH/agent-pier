import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import {
  plainTurnText,
  shownTurnText,
} from "../../server/features/assistants/plain-turn-text.js";

// OpenClaw 2026.10.3 runs a leading `/word` as an owner's command and inline
// `/model …`, `/think …` after whitespace as directives (chat-send-handler,
// get-reply MODEL_DIRECTIVE_PATTERN).
const command = (text) => text.trim().startsWith("/") || /(?<!\S)[/!]\w/.test(text);

test("a user's /restart or /model message reaches the Gateway as plain text", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const request = as(f, anna.cookie);
  const { id } = await (
    await request(`/api/me/agents/${agent.id}/conversation`, { method: "POST" })
  ).json();
  const assistants = f.application.assistants;
  const texts = ["/restart", "Please switch\n/model other/model and !ls"];
  for (const [i, text] of texts.entries()) {
    const sent = await request(`/api/me/conversations/${id}/messages`, {
      method: "POST",
      body: { clientRequestId: `c${i}`, text },
    });
    assert.equal(sent.status, 202, await sent.clone().text());
    for (const attempt of assistants.ledger.pending())
      assistants.ledger.transition(attempt.id, "completed");
  }
  const delivered = gateway.sent.map((s) => s.message);
  assert.equal(delivered.length, 2);
  for (const message of delivered) assert.equal(command(message), false, message);
  assert.deepEqual(delivered.map(shownTurnText), texts);
  // Her chat shows what she wrote.
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  gateway.history[key] = gateway.sent.map((s, i) => ({
    role: "user",
    content: s.message,
    timestamp: Date.now() + i,
    idempotencyKey: `${s.idempotencyKey}:user`,
    __openclaw: { id: `m${i}` },
  }));
  const history = await (await request(`/api/me/conversations/${id}/messages`)).json();
  assert.deepEqual(
    history.messages.map((m) => m.text),
    texts,
  );
});

test("the owner's own chat keeps OpenClaw commands", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { agent } = await sharedAgentOfTwo(f);
  const { id } = await (
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" })
  ).json();
  const sent = await f.request(`/api/assistant-conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "o1", text: "/status" },
  });
  assert.equal(sent.status, 202, await sent.clone().text());
  assert.equal(gateway.sent.at(-1).message, "/status");
});

test("plain turn text leaves paths and URLs inside words alone", () => {
  assert.equal(plainTurnText("see a/b and https://x.y/z"), "see a/b and https://x.y/z");
  assert.equal(shownTurnText(plainTurnText(" /a\t!b")), " /a\t!b");
});
