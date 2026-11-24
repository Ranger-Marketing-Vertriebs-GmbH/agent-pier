import assert from "node:assert/strict";
import test from "node:test";
import { apiError } from "../../web/lib/api.js";
import { orderActions } from "../../web/features/autopilot/order-actions.js";

const active = {
  managed: true,
  reportedStatus: "draft",
  state: "draft",
  manualPaused: false,
  session: { id: "composer", status: "running" },
  limitations: [],
  hasOpenWork: false,
};

test("a valid historical order only permits edits to its policy", () => {
  const historical = { ...active, managed: false, limitations: ["unmanaged"] };
  assert.deepEqual(orderActions(historical), {
    policy: true,
    pause: false,
    resume: false,
    recover: false,
    remove: false,
  });
  assert.equal(
    orderActions({ ...historical, limitations: ["unreadableFile"] }).policy,
    false,
  );
});

test("manual pause and stored completion control lifecycle operations", () => {
  assert.equal(orderActions(active).pause, true);
  assert.equal(orderActions(active).recover, false);
  assert.equal(orderActions({ ...active, deliveryRejected: true }).recover, true);
  assert.equal(orderActions({ ...active, session: null }).recover, true);
  assert.equal(orderActions({ ...active, manualPaused: true }).resume, true);
  // A completed-looking group is insufficient to pass the backend's cleanup rule.
  assert.equal(
    orderActions({ ...active, state: "completed", reportedStatus: "merged" }).remove,
    false,
  );
  const completed = { ...active, state: "completed", reportedStatus: "completed" };
  assert.deepEqual(orderActions(completed), {
    policy: true,
    pause: false,
    resume: false,
    recover: false,
    remove: true,
  });
  assert.equal(orderActions({ ...completed, hasOpenWork: true }).remove, false);
  assert.equal(
    orderActions({ ...active, limitations: ["identityMismatch"] }).pause,
    false,
  );
  assert.equal(
    orderActions({ ...active, limitations: ["sessionOwnershipMismatch"] }).recover,
    false,
  );
});

test("interrupted cleanup can finish even after its file has been removed", () => {
  const cleanup = { ...active, cleanup: true, limitations: ["missingFile"] };
  assert.deepEqual(orderActions(cleanup), {
    policy: false,
    pause: false,
    resume: false,
    recover: false,
    remove: true,
  });
  assert.equal(
    orderActions({ ...cleanup, limitations: ["projectUnavailable"] }).remove,
    false,
  );
});

test("launch errors retain the reserved order ID so retries target that order", async () => {
  const response = Response.json(
    { error: "Start failed", orderId: "reserved" },
    { status: 409 },
  );
  assert.equal((await apiError(response)).orderId, "reserved");
});
