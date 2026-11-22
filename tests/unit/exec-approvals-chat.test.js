import test from "node:test";
import assert from "node:assert/strict";
import { decideExec } from "../../server/features/assistants/exec-decisions.js";
import { fixture, request, settle } from "../helpers/exec-approvals-fixture.js";

// "Allow for this chat" of a Hermes agent's browser_exec (AGENTPIER-479): on
// "Dangerous commands" AgentPier's guard asks before each run, and Hermes offers only
// once or deny for it. AgentPier offers the chat-wide answer itself: it answers the
// card once and every later browser_exec card of the same agent's same session at
// once. Another chat, a routine, a reset chat (a new session), another command, every
// command and a shortened script still ask.

const browser = (agent, overrides = {}) =>
  request(agent, {
    command: "# Opening the shop\nnew_tab('https://shop.example')",
    allowedDecisions: ["allow-once", "deny"],
    tool: "browser_exec",
    ...overrides,
  });
const card = (f, id) => f.w.store.list().find((a) => a.payload.approvalId === id);
const resolves = (f) =>
  f.client.calls.filter((c) => c.method === "exec.approval.resolve").map((c) => c.params);

test("one answer allows browser_exec for the rest of the chat, and only there", async (t) => {
  const f = fixture(t);
  f.w.exec = f.exec;
  f.client.answers["exec.approval.resolve"] = { ok: true };
  f.client.emit("exec.approval.requested", browser(f.agent));
  await settle();
  const first = card(f, "approval-1");
  assert.equal(first.state, "awaiting_approval");
  assert.deepEqual(first.payload.allowedDecisions, ["allow-once", "deny", "allow-chat"]);
  assert.equal(first.payload.chatScope, true);
  const decided = await decideExec(f.w, first, "allow-chat");
  assert.equal(decided.result.decision, "allow-chat");
  // Hermes itself is answered once.
  assert.deepEqual(resolves(f).at(-1), { id: "approval-1", decision: "allow-once" });

  // The next run in this chat goes on without a card.
  const notices = f.queued.length;
  f.client.emit("exec.approval.requested", { ...browser(f.agent), id: "approval-2" });
  await settle();
  await settle();
  const second = card(f, "approval-2");
  assert.equal(second.state, "completed");
  assert.deepEqual(second.result, { decision: "allow-chat", by: "chat" });
  assert.deepEqual(resolves(f).at(-1), { id: "approval-2", decision: "allow-once" });
  assert.equal(f.queued.length, notices);

  // Another chat (or the same chat after a reset: a new session) asks again.
  f.w.a.store.saveConversation({
    assistantId: f.agent.id,
    runtimeSessionKey: "agent:home:other",
  });
  f.client.emit("exec.approval.requested", {
    ...browser(f.agent, { sessionKey: "agent:home:other" }),
    id: "approval-3",
  });
  // Another command in this chat asks again, without the chat-wide answer.
  f.client.emit("exec.approval.requested", {
    ...request(f.agent, { allowedDecisions: ["allow-once", "deny"] }),
    id: "approval-4",
  });
  await settle();
  await settle();
  assert.equal(card(f, "approval-3").state, "awaiting_approval");
  const other = card(f, "approval-4");
  assert.equal(other.state, "awaiting_approval");
  assert.equal(other.payload.allowedDecisions.includes("allow-chat"), false);
  await assert.rejects(decideExec(f.w, other, "allow-chat"), { status: 400 });
});

test("every command, a shortened script and a once-only card never allow the chat", async (t) => {
  const every = fixture(t);
  every.w.a.store.updateAssistant(
    every.agent.id,
    { shellEveryCommand: true },
    every.agent.revision,
  );
  assert.equal(every.w.a.store.getAssistant(every.agent.id).shellEveryCommand, true);
  every.client.emit("exec.approval.requested", browser(every.agent));
  await settle();
  assert.equal(
    card(every, "approval-1").payload.allowedDecisions.includes("allow-chat"),
    false,
  );

  const partial = fixture(t);
  partial.client.emit(
    "exec.approval.requested",
    browser(partial.agent, { partial: true }),
  );
  const hook = fixture(t);
  const attribute = hook.exec.attribute.bind(hook.exec);
  hook.exec.attribute = (input) => ({ ...attribute(input), onceOnly: true });
  hook.client.emit("exec.approval.requested", browser(hook.agent));
  await settle();
  for (const f of [partial, hook]) {
    const action = card(f, "approval-1");
    assert.equal(action.payload.allowedDecisions.includes("allow-chat"), false);
    assert.equal(action.payload.onceOnly, true);
  }
});
