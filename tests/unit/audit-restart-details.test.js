import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const work = {
  turns: 1,
  teams: 0,
  members: 2,
  requests: 0,
  coding: 1,
  goals: 0,
  approvals: 3,
};
const restarted = (details) =>
  auditEvent({
    action: "assistant.main-chat-restarted",
    resourceType: "assistant",
    resourceId: "agent-1",
    outcome: "success",
    source: "user",
    details,
  });

test("a main chat restart keeps its counts", () => {
  const event = restarted({ chats: 3, members: { ended: 1, restarted: 2 }, work });
  assert.deepEqual(event.details, {
    chats: 3,
    members: { ended: 1, restarted: 2 },
    work,
  });
});

test("a main chat restart drops ids, text and malformed counts", () => {
  const event = restarted({
    chats: [{ from: "chat-1" }],
    members: { ended: ["member-1"], restarted: 1 },
    work: { ...work, turns: -1, text: "secret" },
    conversationId: "chat-1",
  });
  assert.deepEqual(event.details, {});
});

test("a partly failed restart is marked partial", () => {
  const event = restarted({
    chats: 1,
    members: { ended: 0, restarted: 0 },
    work,
    partial: true,
  });
  assert.equal(event.details.partial, true);
  assert.equal(restarted({ chats: 1, partial: "yes" }).details.partial, undefined);
});
