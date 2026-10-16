import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const accessId = "11111111-1111-4111-8111-111111111111";
const assistantId = "22222222-2222-4222-8222-222222222222";

test("an SSH execution keeps its facts and never the command or output", () => {
  const event = auditEvent({
    action: "ssh.executed",
    resourceType: "ssh",
    resourceId: accessId,
    source: "system",
    outcome: "success",
    details: {
      assistantId,
      accessId,
      hostName: "opnsense",
      originClass: "owner",
      authorizedBy: "mode",
      mode: "trusted",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      revoked: false,
      durationMs: 1200,
      commandSha256: "a".repeat(64),
      commandBytes: 6,
      command: "uptime # SECRET",
      stdout: "up 3 days",
    },
  });
  assert.equal(event.action, "ssh.executed");
  assert.deepEqual(event.details, {
    assistantId,
    accessId,
    hostName: "opnsense",
    originClass: "owner",
    authorizedBy: "mode",
    mode: "trusted",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    revoked: false,
    durationMs: 1200,
    commandSha256: "a".repeat(64),
    commandBytes: 6,
  });
});

test("a refusal names its stable code", () => {
  const event = auditEvent({
    action: "ssh.denied",
    resourceType: "ssh",
    source: "system",
    outcome: "failure",
    details: { assistantId, code: "SSH_NOT_GRANTED", originClass: "routine" },
  });
  assert.deepEqual(event.details, {
    assistantId,
    code: "SSH_NOT_GRANTED",
    originClass: "routine",
  });
});

test("grant changes list ids and modes only", () => {
  const event = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: assistantId,
    source: "user",
    outcome: "success",
    details: {
      kind: "ssh-grants",
      revision: 4,
      added: [accessId, "../bad"],
      removed: [],
      modeChanged: [{ accessId, from: "approval", to: "trusted", extra: "x" }],
      reason: "owner",
    },
  });
  assert.deepEqual(event.details, {
    kind: "ssh-grants",
    revision: 4,
    added: [accessId],
    removed: [],
    modeChanged: [{ accessId, from: "approval", to: "trusted" }],
    reason: "owner",
  });
});

test("an owner decision on an SSH approval keeps kind ssh", () => {
  const event = auditEvent({
    action: "assistant.answered",
    resourceType: "assistant",
    source: "user",
    outcome: "success",
    details: { kind: "ssh", decision: "approve", channel: "ui", actor: "owner" },
  });
  assert.equal(event.details.kind, "ssh");
});

test("host names with control characters are dropped", () => {
  const event = auditEvent({
    action: "ssh.executed",
    resourceType: "ssh",
    source: "system",
    outcome: "success",
    details: { hostName: "evil\u001b[2J" },
  });
  assert.equal(event.details.hostName, undefined);
});
