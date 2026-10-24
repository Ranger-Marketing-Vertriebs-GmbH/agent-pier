import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { firstTurnTitle } from "../../server/features/assistants/chat-titles.js";

function setup(t) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Agent",
    instructions: "Work",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent-${agent.id}-${crypto.randomUUID()}`,
  });
  // The Gateway stays unreachable: the history serves the cached turns.
  f.assistants.runtime.client.ready = false;
  return { f, chat };
}

function turn(f, chat, context, text, timestamp) {
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text,
  });
  f.service.store.recordContext(request.id, context);
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  if (timestamp)
    f.store.cacheMessages(chat.id, [
      ...f.store.messages(chat.id),
      { id: `m-${request.id}`, role: "user", text, timestamp, runId: null },
    ]);
  return { request, attempt };
}

const setGoal = async (f, chat) => {
  const { request, attempt } = turn(f, chat, { kind: "owner" }, "Finish the episode");
  const inv = { attemptId: attempt.id, toolCallId: "c", assertCurrent() {} };
  await f.service.goal(inv, { action: "set", title: "Episode", done: "Review cut" });
  return { request, inv };
};

test("a continuation shows as a marked event, never its prompt", async (t) => {
  const { f, chat } = setup(t);
  const { request } = await setGoal(f, chat);
  const goal = { id: "g", anchorRequestId: request.id, title: "Episode" };
  const prompt = "This is AgentPier, not the owner. Continue.";
  turn(f, chat, { kind: "owner", goal }, prompt, 10);
  const history = await f.assistants.history(chat.id);
  const event = history.messages.find((m) => m.event === "goal-continuation");
  assert.equal(event.goalTitle, "Episode");
  assert.ok(!JSON.stringify(history).includes("This is AgentPier, not the owner"));
  assert.equal(history.requests.at(-1).internal, "goal-continuation");
});

test("the history carries the open goal and its notes", async (t) => {
  const { f, chat } = setup(t);
  const { inv } = await setGoal(f, chat);
  let history = await f.assistants.history(chat.id);
  assert.deepEqual(Object.keys(history.goal).sort(), [
    "createdAt",
    "done",
    "id",
    "state",
    "steps",
    "title",
  ]);
  assert.ok(history.messages.some((m) => m.event === "goal" && m.phase === "set"));
  await f.service.goal(inv, { action: "done", summary: "All cut" });
  history = await f.assistants.history(chat.id);
  assert.equal(history.goal, null);
  const done = history.messages.find((m) => m.event === "goal" && m.phase === "done");
  assert.equal(done.text, "All cut");
});

test("a member's result during a goal shows as a member result", async (t) => {
  const { f, chat } = setup(t);
  const { request } = await setGoal(f, chat);
  const goal = { id: "g", anchorRequestId: request.id, title: "Episode" };
  const context = {
    kind: "owner",
    goal,
    result: { kind: "member-result", requestId: "r1" },
  };
  turn(f, chat, context, "Result from member: done", 10);
  const history = await f.assistants.history(chat.id);
  const event = history.messages.find((m) => m.event === "member-result");
  assert.ok(event);
  assert.equal(event.goalTitle, undefined);
  assert.equal(history.requests.at(-1).internal, "member-result");
  assert.equal(history.requests.at(-1).goAhead, undefined);
});

test("a continuation never names the chat", async (t) => {
  const { f, chat } = setup(t);
  const { request } = turn(f, chat, { kind: "owner" }, "\u200b");
  const goal = { id: "g", anchorRequestId: request.id, title: "Episode" };
  turn(f, chat, { kind: "owner", goal }, "Continue with the next step");
  assert.equal(firstTurnTitle(f.assistants, chat.id), null);
});
