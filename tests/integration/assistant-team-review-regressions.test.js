import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
test("terminal members without a text report still produce one bounded result batch", async (t) => {
  const f = teamFixture(t),
    { team, attempt } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const m = f.service.store.members(team.id)[0];
  f.complete(m.attemptId);
  f.assistants.ledger.transition(attempt.id, "completed");
  f.assistants.history = async () => ({ stale: false, messages: [] });
  await f.service.reconcile();
  await f.service.reconcile();
  const completed = f.service.store.get(team.id);
  assert.equal(completed.phase, "completed");
  assert.equal(completed.resultBatch[0].reportAvailable, false);
  assert.equal(f.calls.filter((c) => c.method === "sessions.send").length, 2);
});
async function notificationFixture(t) {
  const f = channelFixture(t),
    teams = new TeamStore({ store: f.store });
  f.assistants.teams = { store: teams };
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1, "Plan")]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  teams.recordContext(entry.requestId, {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  });
  const team = teams.propose({
    operationId: "call",
    parentAttemptId: entry.attemptId,
    objective: "Review",
    members: [
      {
        name: "Reviewer",
        role: "Security",
        assignment: "Review account isolation before recommending changes.",
      },
    ],
  });
  return { ...f, teams, team, entry };
}
test("a completed synthesis without text delivers attributed member reports instead of waiting forever", async (t) => {
  const f = await notificationFixture(t);
  f.assistants.ledger.transition(f.entry.attemptId, "completed");
  f.teams.write(f.team, {
    phase: "completed",
    resultAttemptId: f.entry.attemptId,
    resultState: "completed",
    resultBatch: [
      {
        name: "Reviewer",
        role: "Security",
        phase: "completed",
        text: "Member report",
        reportAvailable: true,
      },
    ],
  });
  f.assistants.history = async () => ({ stale: false, messages: [] });
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.transfer();
  const pending = f.service.outbox.pending(f.channel.id);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].text.includes("Member report"));
  assert.ok(pending[0].text.includes("Reviewer"));
});
test("Telegram approval includes the actual proposed names, roles and assignments", async (t) => {
  const f = await notificationFixture(t);
  await f.service.teamOutbox.transfer();
  const entry = f.service.outbox.pending(f.channel.id)[0];
  assert.ok(entry.text.includes("Reviewer"));
  assert.ok(entry.text.includes("Security"));
  assert.ok(entry.text.includes("Review account isolation before recommending changes."));
});

test("stale terminal histories also finish with explicit unavailable reports", async (t) => {
  const f = teamFixture(t),
    { team, attempt } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const m = f.service.store.members(team.id)[0];
  f.complete(m.attemptId);
  f.assistants.ledger.transition(attempt.id, "completed");
  f.assistants.history = async () => ({ stale: true, messages: [] });
  await f.service.reconcile();
  assert.equal(f.service.store.get(team.id).resultBatch?.[0].reportAvailable, false);
});
test("maximum Telegram proposal is complete and buttons follow all delivered details", async (t) => {
  const f = await notificationFixture(t);
  const members = Array.from({ length: 8 }, (_, n) => ({
    name: `Reviewer ${n}`,
    role: "R".repeat(200),
    assignment: "x".repeat(8190) + "😀",
  }));
  f.teams.write(f.team, { objective: "o".repeat(4096), members });
  await f.service.teamOutbox.transfer();
  const entry = f.service.outbox.pending(f.channel.id)[0];
  for (const member of members) assert.ok(entry.text.includes(member.assignment));
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push(input);
    return { message_id: sends.length, chat: { id: 42 } };
  };
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.ok(sends.length > 1);
  assert.ok(sends.slice(0, -1).every((s) => !s.reply_markup));
  assert.equal(sends.at(-1).reply_markup.inline_keyboard[0].length, 2);
  assert.equal(sends.map((s) => s.text).join(""), entry.text);
});
