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
