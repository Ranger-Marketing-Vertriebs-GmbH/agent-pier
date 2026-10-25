import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

test("a secret audit event keeps the name and changed fields and drops the rest", () => {
  const event = auditEvent({
    action: "secret.updated",
    resourceType: "secret",
    resourceId: "11111111-1111-4111-8111-111111111111",
    source: "user",
    outcome: "success",
    details: {
      name: "API_KEY",
      changed: ["value", "bogus", "name"],
      value: "hunter2",
      description: "note",
    },
  });
  assert.deepEqual(event.details, { name: "API_KEY", changed: ["name", "value"] });
  assert.equal(JSON.stringify(event).includes("hunter2"), false);
});

test("a secret audit event drops a malformed name", () => {
  const event = auditEvent({
    action: "secret.created",
    resourceType: "secret",
    source: "user",
    outcome: "success",
    details: { name: "bad name\n" },
  });
  assert.deepEqual(event.details, {});
});
