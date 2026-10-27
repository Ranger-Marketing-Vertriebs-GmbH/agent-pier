import test from "node:test";
import assert from "node:assert/strict";
import { auditAction, auditEvent } from "../../server/features/audit/audit-schema.js";

const accountId = "11111111-1111-4111-8111-111111111111";

const event = (action, details, outcome = "success") =>
  auditEvent({
    action,
    resourceType: "mail",
    resourceId: accountId,
    source: "user",
    outcome,
    details,
  });

test("mail actions are part of the audit vocabulary", () => {
  for (const verb of ["created", "updated", "deleted", "tested", "sent"])
    assert.equal(auditAction(`mail.${verb}`), `mail.${verb}`);
  assert.throws(() => auditAction("mail.read"), { status: 400 });
});

test("audit details keep kind, fields and codes only", () => {
  const audited = event(
    "mail.tested",
    {
      kind: "account",
      fields: ["name", "address", "imap", "password", "secret", 3],
      imap: "ok",
      smtp: "MAIL_AUTH_FAILED",
      address: "owner@example.com",
      host: "imap.example.com",
      subject: "Hello",
      password: "pw-secret",
      body: "text",
    },
    "failure",
  );
  assert.deepEqual(audited.details, {
    kind: "account",
    fields: ["name", "address", "imap", "password"],
    imap: "ok",
    smtp: "MAIL_AUTH_FAILED",
  });
});

test("mail codes must be stable codes", () => {
  const audited = event("mail.tested", {
    kind: "account",
    imap: "Server said: hello owner@example.com",
    smtp: "MAIL_auth",
  });
  assert.deepEqual(audited.details, { kind: "account" });
});

test("unknown mail kinds are dropped", () => {
  assert.deepEqual(event("mail.updated", { kind: "inbox" }).details, {});
});

test("an assistant mail-grants event keeps its kind", () => {
  const audited = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    source: "user",
    outcome: "success",
    details: { kind: "mail-grants", address: "owner@example.com" },
  });
  assert.deepEqual(audited.details, { kind: "mail-grants" });
});

test("mail grant changes keep account ids, a rule count and the reason only", () => {
  const audited = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: "agent-1",
    source: "user",
    outcome: "success",
    details: {
      kind: "mail-grants",
      revision: 3,
      added: [accountId, "bob@example.com"],
      removed: [],
      changed: [accountId],
      ruleCount: 2,
      reason: "account-removed",
      recipients: ["bob@example.com"],
      address: "owner@example.com",
    },
  });
  assert.deepEqual(audited.details, {
    kind: "mail-grants",
    revision: 3,
    added: [accountId],
    removed: [],
    changed: [accountId],
    ruleCount: 2,
    reason: "account-removed",
  });
});

test("a sent message keeps the agent, action, authorization, recipient count and code", () => {
  const audited = event(
    "mail.sent",
    {
      kind: "message",
      assistantId: "agent-1",
      actionId: "action-1",
      authorizedBy: "approval",
      recipients: 3,
      code: "MAIL_AUTH_FAILED",
      to: ["bob@example.com"],
      subject: "Offer",
      body: "text",
    },
    "failure",
  );
  assert.deepEqual(audited.details, {
    kind: "message",
    assistantId: "agent-1",
    actionId: "action-1",
    authorizedBy: "approval",
    recipients: 3,
    code: "MAIL_AUTH_FAILED",
  });
  const odd = event("mail.sent", {
    kind: "message",
    authorizedBy: "chat",
    recipients: 51,
    code: "Server said bob@example.com",
  });
  assert.deepEqual(odd.details, { kind: "message" });
});
