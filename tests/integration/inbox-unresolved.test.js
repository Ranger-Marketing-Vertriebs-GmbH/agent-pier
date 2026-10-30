import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { OwnerInbox } from "../../server/features/inbox/owner-inbox.js";

const hour = 60 * 60000;

// Work that would block an OpenClaw update shows in the inbox once it has not moved
// for a day (inbox-sources.js), and leaves when it is resolved where it lives.
async function fixture(t) {
  const f = await workflowFixture(t);
  const clock = { now: Date.now() };
  const inbox = new OwnerInbox({
    services: { assistants: f.assistants, assistantChannels: f.service },
    now: () => clock.now,
    intervalMs: 0,
    onError: () => {},
  });
  t.after(() => inbox.close());
  const unresolved = async () => {
    inbox.changed();
    return (await inbox.snapshot()).items.filter((i) => i.type === "unresolved");
  };
  return { f, clock, inbox, unresolved };
}

test("stale channel inputs, unknown turns and stalled actions appear after a day and leave once resolved", async (t) => {
  const { f, clock, inbox, unresolved } = await fixture(t);
  const input = f.service.ledger.accept(f.channel, telegramMessage(1, "stuck"));
  f.service.ledger.patch(input.id, {
    state: "model_reviewed",
    diagnostic: "MODEL_OUTCOME_REVIEWED",
  });
  const { attempt } = await f.assistants.send(f.channel.conversationId, {
    clientRequestId: "turn",
    text: "turn",
  });
  f.assistants.ledger.transition(attempt.id, "uncertain");
  const action = f.workflows.store.reserve({
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    attemptId: null,
    origin: { kind: "owner" },
    key: "stalled",
    state: "unknown",
    payload: {
      action: "memory_write",
      projectId: f.project.id,
      title: "N",
      content: "x",
    },
  });
  assert.deepEqual(await unresolved(), []);
  clock.now += 23 * hour;
  assert.deepEqual(await unresolved(), [], "a day has not passed yet");
  clock.now += 2 * hour;
  const items = await unresolved();
  const chat = `/agents/${f.id}/chats/${f.channel.conversationId}`;
  assert.deepEqual(
    items
      .map((i) => [i.id, i.kind, i.tab, i.status, i.source.name, i.link, i.title])
      .sort(),
    [
      [
        `channel_input-${input.id}`,
        "channel_input",
        "agents",
        "model_reviewed",
        "Home",
        `/agents/${f.id}/settings?tab=channels&page=telegram-activity`,
        "",
      ],
      [
        `chat_attempt-${attempt.id}`,
        "chat_attempt",
        "agents",
        "uncertain",
        "Home",
        chat,
        "",
      ],
      [
        `stalled_action-${action.id}`,
        "stalled_action",
        "agents",
        "unknown",
        "Home",
        chat,
        "",
      ],
    ].sort(),
  );
  assert.equal((await inbox.snapshot()).counts.agents, 3);
  // Each address resolves while it waits.
  const stale = await inbox.status("unresolved", `channel_input-${input.id}`);
  assert.equal(stale.state, "pending");
  // Resolved where they live: acknowledged without resending, reviewed in the chat,
  // reviewed as an action.
  await f.service.recoverInput(f.channel.id, input.id, "review");
  f.assistants.ledger.review(attempt.id);
  f.workflows.store.patch(action.id, { state: "reviewed" });
  assert.deepEqual(await unresolved(), []);
  assert.equal(
    (await inbox.status("unresolved", `channel_input-${input.id}`)).state,
    "gone",
  );
});

test("an action that keeps moving is not stalled, and a user's chat stays hers", async (t) => {
  const { f, clock, unresolved } = await fixture(t);
  const action = f.workflows.store.reserve({
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    attemptId: null,
    origin: { kind: "owner" },
    key: "moving",
    state: "running",
    payload: { action: "coding_start", task: "Fix" },
  });
  // A user's own chat: its unknown turn is hers to review, never the owner's.
  const userChat = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "user-session",
    userId: "user-1",
  });
  const { attempt } = await f.assistants.send(userChat.id, {
    clientRequestId: "hers",
    text: "hers",
  });
  f.assistants.ledger.transition(attempt.id, "interrupted");
  // The action changed recently, so it moved within the last day.
  t.mock.timers.enable({ apis: ["Date"], now: clock.now + 20 * hour });
  f.workflows.store.patch(action.id, { run: { status: "running", step: 2 } });
  t.mock.timers.reset();
  clock.now += 25 * hour;
  const items = await unresolved();
  assert.deepEqual(items, []);
});
