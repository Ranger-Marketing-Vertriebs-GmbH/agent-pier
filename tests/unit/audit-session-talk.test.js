import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const audit = (action, details) =>
  auditEvent({
    action,
    resourceType: "session",
    resourceId: "s1",
    outcome: "success",
    source: "agent",
    details,
  });

test("session.asked keeps ids and enums and drops text", () => {
  const event = audit("session.asked", {
    sessionTalk: {
      assistantId: "a1",
      op: "ask",
      requestId: "r1",
      via: "project",
      status: "queued",
      text: "secret",
    },
  });
  assert.deepEqual(event.details.sessionTalk, {
    assistantId: "a1",
    op: "ask",
    requestId: "r1",
    via: "project",
    status: "queued",
  });
});

test("session.told drops bad enums and a wrong op", () => {
  const event = audit("session.told", {
    sessionTalk: { assistantId: "a1", op: "tell", via: "x", status: "bogus" },
  });
  assert.deepEqual(event.details.sessionTalk, { assistantId: "a1", op: "tell" });
  assert.equal(
    audit("session.told", { sessionTalk: { assistantId: "a1", op: "send" } }).details
      .sessionTalk,
    undefined,
  );
});

test("session.sent keeps agentSession.via for project and session only", () => {
  const via = (value) =>
    audit("session.sent", { agentSession: { assistantId: "a1", op: "send", via: value } })
      .details.agentSession.via;
  assert.equal(via("session"), "session");
  assert.equal(via("project"), "project");
  assert.equal(via("x"), undefined);
});
