import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { sftpAuditDetails } from "../../server/features/audit/audit-sftp-details.js";
import { auditId } from "../../server/features/audit/audit-schema.js";

const accessId = "11111111-1111-4111-8111-111111111111";

const event = (action, details, outcome = "success") =>
  auditEvent({
    action,
    resourceType: "ssh",
    resourceId: accessId,
    sessionId: "cli",
    source: "mcp",
    outcome,
    details,
  });

test("an SFTP transfer keeps its facts and drops unknown keys", () => {
  const audited = event("sftp.completed", {
    accessId,
    operation: "sync",
    direction: "up",
    state: "completed",
    files: 3,
    bytes: 4096,
    deleted: 1,
    durationMs: 1500,
    remotePath: "/www",
    localPath: "site",
    reported: "session",
    password: "pw-secret",
    content: "FILE-CONTENT",
    privateKey: "-----BEGIN",
  });
  assert.equal(audited.action, "sftp.completed");
  assert.deepEqual(audited.details, {
    accessId,
    operation: "sync",
    direction: "up",
    state: "completed",
    files: 3,
    bytes: 4096,
    deleted: 1,
    durationMs: 1500,
    remotePath: "/www",
    localPath: "site",
    reported: "session",
  });
});

test("SFTP audit details drop control characters, bad values and foreign codes", () => {
  const audited = event(
    "sftp.failed",
    {
      accessId,
      operation: "format",
      direction: "sideways",
      state: "exploded",
      files: -1,
      bytes: 1.5,
      deleted: Number.MAX_SAFE_INTEGER + 2,
      durationMs: "10",
      remotePath: "/www\n[forged] line",
      localPath: "x".repeat(1025),
      code: "EACCES",
    },
    "failure",
  );
  assert.deepEqual(audited.details, { accessId });
  const failed = event("sftp.failed", { code: "SFTP_PERMISSION", operation: "delete" });
  assert.deepEqual(failed.details, { code: "SFTP_PERMISSION", operation: "delete" });
  assert.equal(
    event("sftp.denied", { code: "SSH_ACCESS_REVOKED" }, "failure").details.code,
    "SSH_ACCESS_REVOKED",
  );
});

test("sftpAuditDetails writes only into event.details", () => {
  const target = { details: {} };
  sftpAuditDetails(
    { operation: "mkdir", remotePath: "/a\u2028b", unknown: 1 },
    target,
    auditId,
  );
  assert.deepEqual(target, { details: { operation: "mkdir" } });
});
