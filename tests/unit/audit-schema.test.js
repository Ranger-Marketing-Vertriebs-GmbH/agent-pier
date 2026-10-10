import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const event = (details) =>
  auditEvent({
    action: "setting.updated",
    resourceType: "setting",
    resourceId: "network-access",
    source: "user",
    outcome: "success",
    details,
  });

test("network access details keep the mode, the wildcard bind and the host count", () => {
  assert.deepEqual(event({ enabled: true, bind: "::", count: 3 }).details, {
    enabled: true,
    bind: "::",
    count: 3,
  });
  assert.deepEqual(event({ enabled: false, bind: "0.0.0.0" }).details, {
    enabled: false,
    bind: "0.0.0.0",
  });
  assert.deepEqual(event({ enabled: "yes", bind: "192.168.1.5" }).details, {});
});
test("pipeline override audits keep the stage, overridden reason and path only", () => {
  const event = auditEvent({
    action: "pipeline.overridden",
    resourceType: "pipeline",
    resourceId: "run-1",
    source: "user",
    outcome: "success",
    details: {
      kind: "gate",
      stageId: "stage-1",
      failReason: "verify-failed",
      path: "skips-checks",
      summary: "free text never enters the audit",
    },
  });
  assert.deepEqual(event.details, {
    kind: "gate",
    stageId: "stage-1",
    failReason: "verify-failed",
    path: "skips-checks",
  });
  assert.deepEqual(
    auditEvent({
      action: "pipeline.overridden",
      resourceType: "pipeline",
      source: "user",
      outcome: "success",
      details: { failReason: "Free Text", path: "anything" },
    }).details,
    {},
  );
});
