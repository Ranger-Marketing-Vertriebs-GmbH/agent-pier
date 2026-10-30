import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const request = (action, details) =>
  auditEvent({
    action,
    resourceType: "request",
    resourceId: "r-1",
    source: "system",
    outcome: "success",
    details,
  }).details;

test("an ended request keeps its cause and the startup flag, nothing else", () => {
  assert.deepEqual(
    request("request.expired", {
      kind: "permission",
      cause: "stale",
      startup: true,
      command: "rm -rf /",
    }),
    { kind: "permission", cause: "stale", startup: true },
  );
  assert.deepEqual(request("request.expired", { kind: "permission", cause: "bogus" }), {
    kind: "permission",
  });
});

test("remembered and default approvals keep their own decision", () => {
  for (const decision of [
    "allow-session",
    "allow-project",
    "allow-default",
    "allow-always",
  ])
    assert.equal(
      request("request.answered", { kind: "permission", decision, auto: true }).decision,
      decision,
    );
  assert.equal(
    request("request.answered", { kind: "permission", decision: "allow-x" }).decision,
    undefined,
  );
});
