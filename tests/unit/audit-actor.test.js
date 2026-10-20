import test from "node:test";
import assert from "node:assert/strict";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { auditActor } from "../../server/features/audit/audit-actor.js";

test("user events keep the acting user and the password kind, never other details", () => {
  const event = auditEvent({
    action: "user.updated",
    resourceType: "user",
    resourceId: "user-1",
    actorUserId: "user-1",
    source: "user",
    outcome: "success",
    details: { kind: "password-changed", password: "never-kept" },
  });
  assert.equal(event.actorUserId, "user-1");
  assert.deepEqual(event.details, { kind: "password-changed" });
  assert.throws(() =>
    auditEvent({
      action: "user.updated",
      resourceType: "user",
      actorUserId: "../x",
      source: "user",
      outcome: "success",
    }),
  );
  const owner = auditEvent({
    action: "user.created",
    resourceType: "user",
    source: "user",
    outcome: "success",
  });
  assert.equal("actorUserId" in owner, false);
});

test("only a user principal names an acting user", () => {
  assert.deepEqual(auditActor({ role: "user", userId: "u1" }), { actorUserId: "u1" });
  assert.deepEqual(auditActor({ role: "owner" }), {});
  assert.deepEqual(auditActor(undefined), {});
});
