import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import {
  conversationHistory,
  conversationMessage,
} from "../../server/features/assistants/conversations.js";
import { maxReplyParts } from "../../server/features/assistant-channels/telegram-delivery.js";
import { withoutTags } from "../helpers/telegram-parts.js";

const placeholder = "[chat.history omitted: message too large]";
const section = (n) =>
  `**Part ${n}**\n${"A sentence of the long reply, with a little content. ".repeat(12)}`;
const longReply = (sections) =>
  Array.from({ length: sections }, (_, n) => section(n)).join("\n\n");
// OpenClaw's chat.history: a page cuts each text at maxChars (8000 by default); a
// message read on its own (`messageId`) uses the caller's limit. `alone` replaces
// that single read's text (a placeholder, an error).
function setup(t, reply, { alone } = {}) {
  const f = channelFixture(t, { language: () => "en" });
  const current = f.service.store.get(f.channel.id);
  f.service.store.update(
    f.channel.id,
    { appUrl: "https://pier.example" },
    current.revision,
  );
  const reads = [];
  const state = { runId: null };
  const cut = (text, max) =>
    text.length > max ? `${text.slice(0, max)}\n...(truncated)...` : text;
  const service = {
    store: f.store,
    ledger: f.assistants.ledger,
    runtime: {
      generation: 1,
      client: {
        ready: true,
        call: async (method, input) => {
          assert.equal(method, "chat.history");
          reads.push(input);
          let text = cut(reply, input.maxChars ?? 8000);
          if (input.messageId) {
            if (alone instanceof Error) throw alone;
            if (alone !== undefined) text = alone;
          } else if (alone === placeholder && reply.length > 60000) text = placeholder;
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: 2000,
                __openclaw: { id: "m1", runId: state.runId },
              },
            ],
          };
        },
      },
    },
  };
  f.assistants.history = (id) => conversationHistory(service, id);
  f.assistants.message = (id, messageId) => conversationMessage(service, id, messageId);
  const sends = [];
  f.client.call = async (method, params) => {
    sends.push(params);
    return { message_id: sends.length, chat: { id: 42 } };
  };
  const deliver = async () => {
    await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
    await f.service.ingress.dispatch(f.channel.id);
    const entry = f.service.ledger.list(f.channel.id)[0];
    state.runId = entry.attemptId;
    f.assistants.ledger.transition(entry.attemptId, "completed");
    for (let n = 0; n < 3; n++)
      await f.service.delivery.process(f.channel.id, new AbortController().signal);
    return f.service.ledger.get(entry.id);
  };
  return { f, reads, sends, deliver };
}
const visible = (sends) => sends.map((s) => withoutTags(s.text)).join("\n\n");

test("a reply beyond the history page is read on its own and sent whole", async (t) => {
  const reply = longReply(40);
  assert.ok(reply.length > 8000 && reply.length < 65536);
  const { reads, sends, deliver } = setup(t, reply);
  const entry = await deliver();
  assert.equal(entry.state, "delivered");
  // The page keeps OpenClaw's default; only the one reply is read with the large limit.
  assert.equal(reads[0].maxChars, undefined);
  assert.deepEqual(reads.slice(1), [
    { sessionKey: "session", messageId: "m1", limit: 1, maxChars: 65536 },
  ]);
  assert.ok(sends.length > 2);
  const shown = visible(sends);
  assert.doesNotMatch(shown, /truncated|AgentPier/);
  assert.match(shown, /Part 39/);
});

test("a short reply needs no second read", async (t) => {
  const { reads, sends, deliver } = setup(t, "Short answer.");
  await deliver();
  assert.equal(reads.length, 1);
  assert.deepEqual(
    sends.map((s) => s.text),
    ["Short answer."],
  );
});

test("a reply OpenClaw will not serve whole sends what there is and a note", async (t) => {
  const reply = longReply(40);
  const { sends, deliver } = setup(t, reply, { alone: placeholder });
  const entry = await deliver();
  assert.equal(entry.state, "delivered");
  const shown = visible(sends);
  assert.doesNotMatch(shown, /chat\.history|truncated/);
  assert.ok(shown.startsWith(reply.slice(0, 200).replace(/\*\*/g, "")));
  // The note says what is true: the rest was not sent (the chat shows no more).
  assert.equal(sends.at(-1).text, "Reply shortened – the rest could not be sent.");
});

test("a reply replaced by the placeholder and unreadable alone sends only the note", async (t) => {
  const reply = longReply(200);
  const { sends, deliver } = setup(t, reply, { alone: Error("gone") });
  // The page itself carries the placeholder for an oversized message.
  const fixture = setup(t, reply, { alone: placeholder });
  const entry = await fixture.deliver();
  assert.equal(entry.state, "delivered");
  assert.equal(fixture.sends.length, 1);
  assert.match(fixture.sends[0].text, /^Reply shortened – the rest could not be sent\.$/);
  // An unreadable single message keeps the page's 8000 characters and the note.
  await deliver();
  assert.ok(sends.length >= 2);
  assert.match(sends.at(-1).text, /^Reply shortened – the rest could not be sent\.$/);
});

test("a reply beyond AgentPier's limit sends what OpenClaw serves and a note", async (t) => {
  const reply = longReply(200);
  assert.ok(reply.length > 65536);
  const { sends, deliver } = setup(t, reply);
  const entry = await deliver();
  assert.equal(entry.state, "delivered");
  assert.ok(sends.length > 16 && sends.length <= maxReplyParts + 1);
  assert.equal(sends.at(-1).text, "Reply shortened – the rest could not be sent.");
  assert.match(visible(sends.slice(0, 1)), /^Part 0/);
  assert.doesNotMatch(visible(sends), /truncated/);
});

test("a whole reply needing many messages is sent without a note", async (t) => {
  // Escaped "&" makes these 80 paragraphs need more than the old cap of 16.
  const reply = Array.from(
    { length: 80 },
    (_, n) => `Part ${n}: ${"R&D & Q&A news. ".repeat(40)}`,
  ).join("\n\n");
  assert.ok(reply.length < 65536);
  const { sends, deliver } = setup(t, reply);
  await deliver();
  assert.ok(sends.length > 16 && sends.length < maxReplyParts, `${sends.length}`);
  assert.doesNotMatch(visible(sends), /Reply shortened/);
  assert.match(visible(sends.slice(-1)), /Part 79/);
});

test("a whole reply beyond the flood bound stops at it with a note", async (t) => {
  // Escaping makes each "&" five characters of HTML: far more parts than usual.
  const reply = "&& ".repeat(21000);
  const { sends, deliver } = setup(t, reply);
  await deliver();
  assert.equal(sends.length, maxReplyParts + 1);
  assert.equal(sends.at(-1).text, "Reply shortened – the rest could not be sent.");
});
