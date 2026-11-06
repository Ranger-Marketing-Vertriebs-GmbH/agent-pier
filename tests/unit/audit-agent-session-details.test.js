import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionAuditDetails } from "../../server/features/audit/audit-agent-session-details.js";

const kept = (status) => {
  const event = { details: {} };
  agentSessionAuditDetails(
    { agentSession: { assistantId: "a1", op: "send", deliveryId: "d1", status } },
    event,
  );
  return event.details.agentSession?.status;
};

test("audit keeps the delivery statuses incl. accepted and hook-blocked", () => {
  for (const status of ["handed-off", "accepted", "rejected", "hook-blocked"])
    assert.equal(kept(status), status);
  assert.equal(kept("bogus"), undefined);
});
