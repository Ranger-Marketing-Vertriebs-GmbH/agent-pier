import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { AssistantEvents } from "../../server/features/assistants/assistant-events.js";

// The owner's Telegram chat with the lead ("Home"), whose finished team has a member.
async function telegramLead(t, text) {
  const f = channelFixture(t, { language: () => "en" });
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.cancel = async () => {};
  f.assistants.events = new AssistantEvents();
  f.assistants.teams = new TeamService({ assistants: f.assistants, autoStart: false });
  t.after(() => f.assistants.teams.close());
  const leads = leadStoreFixture(t, { store: f.store });
  const lead = {
    assistant: f.store.getAssistant(f.channel.assistantId),
    chat: f.store.getConversation(f.channel.conversationId),
  };
  const [member] = leads.team(lead, { count: 1 });
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1, text)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  f.assistants.teams.store.recordContext(entry.requestId, origin);
  // Histories by conversation: the member answers, the lead relays.
  const replies = new Map();
  f.assistants.history = async (id) => ({
    stale: false,
    messages: replies.get(id) || [],
  });
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return method === "sendMessage"
      ? { message_id: sends.length, chat: { id: 42 } }
      : true;
  };
  return {
    ...f,
    member,
    entry,
    replies,
    sends,
    lead,
    signal: new AbortController().signal,
  };
}

test("a slow answer to a Telegram request goes back to the owner's Telegram chat", async (t) => {
  const f = await telegramLead(t, "Please ask Member 0 what the budget is");
  const teams = f.assistants.teams;
  teams.requests.waitMs = 0;
  const result = await teams.ask(
    { attemptId: f.entry.attemptId, toolCallId: "ask", assertCurrent() {} },
    {
      memberId: f.member.id,
      question: "What is the budget?",
    },
  );
  assert.equal(result.status, "asked");
  const r = teams.requests.store.get(result.requestId);
  assert.equal(r.phase, "running");
  f.replies.set(f.member.conversationId, [
    { role: "assistant", runId: r.attemptId, text: "The budget is 5k." },
  ]);
  f.assistants.ledger.transition(r.attemptId, "completed");
  f.assistants.ledger.transition(f.entry.attemptId, "completed");
  await teams.requests.advance();
  const delivered = teams.requests.store.get(r.id);
  assert.equal(delivered.delivery, "sent");
  // The lead relays the answer in its follow-up turn, which goes to Telegram.
  f.replies.set(f.lead.chat.id, [
    { role: "assistant", runId: delivered.resultAttemptId, text: "Member 0 says: 5k." },
  ]);
  f.assistants.ledger.transition(delivered.resultAttemptId, "completed");
  await f.service.teamOutbox.transfer();
  const notice = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.kind === "lead-request-result");
  assert.equal(notice.text, "Member 0 says: 5k.");
  await f.service.teamOutbox.process(f.channel.id, f.signal);
  assert.ok(
    f.sends.some(
      (s) => s.method === "sendMessage" && s.input.text.includes("Member 0 says: 5k."),
    ),
  );
  // Transferred once.
  await f.service.teamOutbox.transfer();
  assert.equal(
    f.service.outbox.all(f.channel.id).filter((e) => e.kind === "lead-request-result")
      .length,
    1,
  );
});

test("a long relayed answer is read whole, or relayed as far as it goes with a note", async (t) => {
  for (const [alone, expected] of [
    [(text) => text, (text) => text],
    [
      () => "[chat.history omitted: message too large]",
      (text) => `${text.slice(0, 8000).trimEnd()}\n\nThe full reply is in AgentPier.`,
    ],
  ]) {
    const f = await telegramLead(t, "Please ask Member 0 what the budget is");
    const teams = f.assistants.teams;
    teams.requests.waitMs = 0;
    const result = await teams.ask(
      { attemptId: f.entry.attemptId, toolCallId: "ask", assertCurrent() {} },
      { memberId: f.member.id, question: "What is the budget?" },
    );
    const r = teams.requests.store.get(result.requestId);
    f.replies.set(f.member.conversationId, [
      { role: "assistant", runId: r.attemptId, text: "The budget is 5k." },
    ]);
    f.assistants.ledger.transition(r.attemptId, "completed");
    f.assistants.ledger.transition(f.entry.attemptId, "completed");
    await teams.requests.advance();
    const delivered = teams.requests.store.get(r.id);
    // The lead's relay is longer than the history page serves.
    const full = `Member 0 says: ${"the budget, in detail. ".repeat(600)}`;
    f.replies.set(f.lead.chat.id, [
      {
        id: "lead-1",
        role: "assistant",
        runId: delivered.resultAttemptId,
        text: `${full.slice(0, 8000)}\n...(truncated)...`,
      },
    ]);
    const asked = [];
    f.assistants.message = async (conversationId, messageId) => {
      asked.push([conversationId, messageId]);
      return alone(full);
    };
    f.assistants.ledger.transition(delivered.resultAttemptId, "completed");
    await f.service.teamOutbox.transfer();
    const notice = f.service.outbox
      .all(f.channel.id)
      .find((e) => e.kind === "lead-request-result");
    assert.deepEqual(asked, [[f.lead.chat.id, "lead-1"]]);
    assert.equal(notice.text, expected(full));
  }
});
