import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fakeGateway } from "../helpers/user-chats.js";
import { switchTeam } from "../helpers/model-switch-team.js";
import { definitions } from "../../server/features/assistants/team-plugin/index.js";
import { deferredSwaps } from "../../server/features/assistants/deferred-swaps.js";
import { memoryReviewsSettled } from "../../server/features/assistants/memory-review.js";

// OpenRouter names the family before the slash: the fixture runs openai/gpt-4.1-mini.
const model = (agent, modelId) => ({ connectionId: agent.model.connectionId, modelId });
const otherFamily = (agent) => model(agent, "anthropic/claude-sonnet-4.6");
const sameFamily = (agent) => model(agent, "openai/gpt-5");

// The team of model-switch-team.js with a lead turn under way in its main chat, so
// the lead can call agentpier_team_member_update.
async function leadTeam(t) {
  const s = await switchTeam(t);
  const { service, main } = s;
  const turn = service.ledger.recordAttempt(
    service.ledger.accept(main.id, { clientRequestId: "lead-turn", text: "Edit" }).id,
  );
  const update = (memberId, input) =>
    service.teams.member_update(
      { attemptId: turn.id, toolCallId: randomUUID(), assertCurrent() {} },
      { memberId, ...input },
    );
  return { ...s, update };
}

// A turn under way in `conversationId`.
const running = (service, conversationId) =>
  service.ledger.recordAttempt(
    service.ledger.accept(conversationId, { clientRequestId: randomUUID(), text: "Hi" })
      .id,
  );

// The member-update notes of the member's old chat, as the chats list them.
const updateNotes = (service, assistantId, conversationId) =>
  service.workflows.store
    .list(assistantId)
    .filter(
      (a) => a.conversationId === conversationId && a.payload?.action === "member_update",
    )
    .map((a) => a.payload);

test("a lead's family switch gives the member a fresh chat", async (t) => {
  const { service, lead, main, teams, keeper, update } = await leadTeam(t);
  const result = await update(keeper.id, { model: otherFamily(lead) });
  assert.equal(result.status, "updated");
  assert.equal(result.freshChat, "started");
  // Without memory there is nothing to review.
  assert.equal("memoryReview" in result, false);
  const member = teams.member(keeper.id);
  assert.notEqual(member.conversationId, keeper.conversationId);
  const { store } = service;
  const old = store.getConversation(keeper.conversationId);
  assert.ok(old.archivedAt);
  assert.equal(old.successorId, member.conversationId);
  assert.equal(store.getConversation(member.conversationId).archivedAt ?? null, null);
  assert.deepEqual(
    service.memoryNotes.forConversation(member.conversationId).map((n) => n.details),
    [{ from: "openai/gpt-4.1-mini", to: "anthropic/claude-sonnet-4.6" }],
  );
  // The member keeps working; the lead's chat stays.
  assert.equal(member.archivedAt, null);
  assert.equal(store.getConversation(main.id).archivedAt ?? null, null);
  // The history entry and the note in the member's chat name the fresh chat.
  assert.equal(member.grantLog.at(-1).freshChat, true);
  const [note] = updateNotes(service, keeper.assistantId, keeper.conversationId);
  assert.equal(note.freshChat, true);
  assert.deepEqual(deferredSwaps(service).list(), []);
});

test("a member with memory waits for the owner's review of it", async (t) => {
  const { service, lead, keeper, update } = await leadTeam(t);
  const { revision } = service.store.getAssistant(keeper.assistantId);
  service.store.updateAssistant(
    keeper.assistantId,
    { capabilities: { memory: true, reminders: false } },
    revision,
  );
  const kept = await update(keeper.id, { model: otherFamily(lead), freshChat: false });
  assert.equal("memoryReview" in kept, false);
  const result = await update(keeper.id, { model: sameFamily(lead), freshChat: true });
  assert.equal(result.freshChat, "started");
  assert.equal(result.memoryReview, "waits_for_owner");
  const [[review]] = await memoryReviewsSettled(service);
  assert.equal(review.assistantId, keeper.assistantId);
});

test("a member of a user's own lead is not reviewed and reports no review", async (t) => {
  const { service, lead, keeper, update } = await leadTeam(t);
  const store = service.store;
  const withMemory = { capabilities: { memory: true, reminders: false } };
  store.updateAssistant(
    keeper.assistantId,
    withMemory,
    store.getAssistant(keeper.assistantId).revision,
  );
  // As if the lead had become a user's own agent (user-agent-lock.js forbids a team).
  const userAccess = { mode: "own", members: [{ userId: "u1", level: "extended" }] };
  store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...store.getAssistant(lead.id), userAccess }), lead.id);
  const result = await update(keeper.id, { model: otherFamily(lead) });
  assert.equal(result.freshChat, "started");
  assert.equal("memoryReview" in result, false);
  assert.deepEqual(await memoryReviewsSettled(service), []);
});

test("freshChat false keeps it", async (t) => {
  const { service, lead, teams, keeper, update } = await leadTeam(t);
  const result = await update(keeper.id, { model: otherFamily(lead), freshChat: false });
  assert.equal(result.freshChat, "off");
  const member = teams.member(keeper.id);
  assert.equal(member.conversationId, keeper.conversationId);
  assert.deepEqual(
    service.store.getAssistant(keeper.assistantId).model,
    otherFamily(lead),
  );
  assert.equal(
    service.store.getConversation(keeper.conversationId).archivedAt ?? null,
    null,
  );
  assert.equal(member.grantLog.at(-1).freshChat, false);
  const [note] = updateNotes(service, keeper.assistantId, keeper.conversationId);
  assert.equal(note.freshChat, false);
});

test("a same-family move keeps the chat unless the lead asks; freshChat is a boolean", async (t) => {
  const { lead, teams, keeper, update } = await leadTeam(t);
  const kept = await update(keeper.id, { model: sameFamily(lead) });
  assert.equal(kept.freshChat, "off");
  assert.equal(teams.member(keeper.id).conversationId, keeper.conversationId);
  const asked = await update(keeper.id, {
    model: model(lead, "openai/gpt-5-mini"),
    freshChat: true,
  });
  assert.equal(asked.freshChat, "started");
  assert.notEqual(teams.member(keeper.id).conversationId, keeper.conversationId);
  await assert.rejects(
    update(keeper.id, { model: otherFamily(lead), freshChat: "yes" }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    update(keeper.id, { role: "Notes", freshChat: 1 }),
    (error) => error.status === 400,
  );
});

test("a running member turn finishes in the old chat and the swap follows", async (t) => {
  const { service, lead, teams, keeper, update } = await leadTeam(t);
  const turn = running(service, keeper.conversationId);
  const result = await update(keeper.id, { model: otherFamily(lead) });
  assert.equal(result.freshChat, "waits_for_turn");
  // The turn is not cut and its chat stays while it runs.
  assert.ok(service.ledger.pending().some((a) => a.id === turn.id));
  assert.equal(teams.member(keeper.id).conversationId, keeper.conversationId);
  const swaps = deferredSwaps(service);
  assert.deepEqual(
    swaps.list().map((s) => [s.conversationId, s.memberId]),
    [[keeper.conversationId, keeper.id]],
  );
  await swaps.tick();
  assert.equal(teams.member(keeper.id).conversationId, keeper.conversationId);
  service.ledger.transition(turn.id, "completed");
  await swaps.tick();
  const fresh = teams.member(keeper.id).conversationId;
  assert.notEqual(fresh, keeper.conversationId);
  assert.equal(service.store.getConversation(keeper.conversationId).successorId, fresh);
  assert.deepEqual(
    service.memoryNotes.forConversation(fresh).map((n) => [n.reason, n.details]),
    [
      [
        "model-switched",
        { from: "openai/gpt-4.1-mini", to: "anthropic/claude-sonnet-4.6" },
      ],
    ],
  );
  assert.deepEqual(swaps.list(), []);
});

test("a deferred swap survives a service restart", async (t) => {
  const { f, lead, keeper, update, service: before } = await leadTeam(t);
  const turn = running(before, keeper.conversationId);
  await update(keeper.id, { model: otherFamily(lead) });
  await f.restart();
  fakeGateway(f);
  const service = f.application.assistants;
  // The restart leaves the turn uncertain; it ends in the old chat.
  service.ledger.transition(turn.id, "completed");
  const swaps = deferredSwaps(service);
  assert.equal(swaps.list().length, 1);
  await swaps.tick();
  const member = service.teams.store.member(keeper.id);
  assert.notEqual(member.conversationId, keeper.conversationId);
  assert.equal(
    service.store.getConversation(keeper.conversationId).successorId,
    member.conversationId,
  );
  assert.deepEqual(swaps.list(), []);
});

test("a task member that finishes while its swap is held still gets a fresh chat", async (t) => {
  const { service, lead, teams, scout, update } = await leadTeam(t);
  const turn = running(service, scout.conversationId);
  const result = await update(scout.id, { model: otherFamily(lead) });
  assert.equal(result.freshChat, "waits_for_turn");
  // Its turn ends its task; the lead can still reach it in its chat.
  service.ledger.transition(turn.id, "completed");
  teams.write(teams.member(scout.id), { phase: "completed", attemptId: turn.id });
  const swaps = deferredSwaps(service);
  await swaps.tick();
  const fresh = teams.member(scout.id).conversationId;
  assert.notEqual(fresh, scout.conversationId);
  assert.equal(service.store.getConversation(scout.conversationId).successorId, fresh);
  assert.deepEqual(swaps.list(), []);
});

test("a held chat archived meanwhile is dropped; one held a day is given up", async (t) => {
  const { service, lead, keeper, scout, update } = await leadTeam(t);
  running(service, keeper.conversationId);
  running(service, scout.conversationId);
  await update(keeper.id, { model: otherFamily(lead) });
  await update(scout.id, { model: otherFamily(lead) });
  const swaps = deferredSwaps(service);
  assert.equal(swaps.list().length, 2);
  service.store.updateConversation(keeper.conversationId, {
    archivedAt: new Date().toISOString(),
  });
  await swaps.tick();
  assert.deepEqual(
    swaps.list().map((s) => s.conversationId),
    [scout.conversationId],
  );
  const errors = t.mock.method(console, "error", () => {});
  const day = Date.now() + 24 * 60 * 60 * 1000 + 1000;
  t.mock.method(service, "now", () => day);
  await swaps.tick();
  assert.deepEqual(swaps.list(), []);
  assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes("gave up")));
  assert.equal(
    service.store.getConversation(scout.conversationId).archivedAt ?? null,
    null,
  );
});

test("the tool result names the fresh chat and the waiting review", async (t) => {
  const { lead, keeper, update } = await leadTeam(t);
  const result = await update(keeper.id, { model: otherFamily(lead) });
  assert.deepEqual(
    { ...result, changed: undefined },
    {
      status: "updated",
      memberId: keeper.id,
      changed: undefined,
      effective: "next_turn",
      freshChat: "started",
    },
  );
  // memoryReview: "waits_for_owner" comes with the memory review (Task 6).
  assert.equal("memoryReview" in result, false);
  const { properties, required } = definitions.member_update.parameters;
  assert.deepEqual(properties.freshChat, {
    type: "boolean",
    description:
      "Start the member in a fresh chat (default: when the model family changes).",
  });
  assert.deepEqual(required, ["memberId"]);
  assert.match(definitions.member_update.description, /freshChat/);
});

test("a member whose chat is swapped after its turn ends still reports to the lead", async (t) => {
  const { service, lead, teams, scout, keeper, update } = await leadTeam(t);
  // Scout's run ends in its task chat; then its lead moves it to another family.
  const attempt = running(service, scout.conversationId);
  service.ledger.transition(attempt.id, "completed");
  teams.write(teams.member(scout.id), { phase: "completed", attemptId: attempt.id });
  assert.equal(
    (await update(scout.id, { model: otherFamily(lead) })).freshChat,
    "started",
  );
  const fresh = teams.member(scout.id).conversationId;
  assert.notEqual(fresh, scout.conversationId);
  const replies = {
    [scout.conversationId]: [
      { id: "m1", role: "assistant", runId: attempt.id, text: "Found the answer" },
    ],
  };
  t.mock.method(service, "history", async (id) => ({
    stale: false,
    messages: replies[id] || [],
  }));
  assert.equal(teams.member(keeper.id).phase, "completed");
  await service.teams.scheduler.results.collect(scout.teamId);
  const entry = teams.get(scout.teamId).resultBatch.find((m) => m.memberId === scout.id);
  assert.equal(entry.text, "Found the answer");
  assert.equal(entry.reportAvailable, true);
});
