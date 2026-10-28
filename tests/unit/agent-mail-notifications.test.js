import test from "node:test";
import assert from "node:assert/strict";
import {
  mailMessages,
  mailNotes,
  notifyMail,
} from "../../server/features/assistants/mail/agent-mail-notifications.js";

// A state that is not final (or not known) never reaches the owner as itself: the
// Telegram result and the chat note both read it as unknown.

const action = (state, extra = {}) => ({
  id: "action-1",
  assistantId: "agent-1",
  conversationId: "conv-1",
  revision: 2,
  state,
  chatNotes: { result: { at: "2026-10-28T10:00:00.000Z", state } },
  result: { code: "MAIL_PROTOCOL" },
  payload: {
    action: "mail_send",
    accountName: "Support",
    from: { name: "", address: "agent@example.com" },
    to: ["bob@example.org"],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "Hi there.",
  },
  ...extra,
});

function resultText(a, language = "en") {
  const sent = [];
  const w = {
    a: { store: { getAssistant: () => ({ name: "Ada" }) } },
    s: { assistantChannels: { outbox: { enqueue: (entry) => sent.push(entry) } } },
  };
  const m = mailMessages({ language });
  notifyMail(w, a, "result", "key-1", m, { kind: "telegram" });
  return { text: sent[0].text, m };
}

for (const state of ["executing", "awaiting_approval", "reviewed", "odd"]) {
  test(`an unrecognised state (${state}) reads as unknown in the result`, () => {
    const { text, m } = resultText(action(state));
    assert.ok(text.startsWith(m.mailStates.unknown), text);
    assert.equal(text.includes(state), false);
  });

  test(`an unrecognised state (${state}) is an unknown chat note with its code`, () => {
    const [note] = mailNotes(action(state));
    assert.equal(note.state, "unknown");
    assert.equal(note.code, "MAIL_PROTOCOL");
    assert.equal(note.recipientCount, 1);
  });
}

test("a final state keeps its own text and note", () => {
  const { text, m } = resultText(action("completed"));
  assert.ok(text.startsWith(m.mailStates.completed));
  assert.match(text, /Email account: Support/);
  const [note] = mailNotes(action("completed"));
  assert.equal(note.state, "completed");
  assert.equal(note.code, null);
});
