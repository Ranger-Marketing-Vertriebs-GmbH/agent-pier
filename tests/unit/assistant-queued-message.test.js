import test from "node:test";
import assert from "node:assert/strict";
import { queuedNotice, takeBack } from "../../web/features/assistants/queued-message.js";

test("taking a queued message back puts it before the composer text", () => {
  assert.equal(takeBack("Swap Tuesday\n", ""), "Swap Tuesday");
  assert.equal(takeBack("Swap Tuesday", "Also Sunday"), "Swap Tuesday\nAlso Sunday");
  assert.equal(takeBack("", "Also Sunday"), "Also Sunday");
  assert.equal(takeBack("  ", "  "), "");
});

test("the queued notice follows the server state and whether the agent can take it", () => {
  const free = { active: false, available: true };
  assert.equal(queuedNotice(null, free), null);
  assert.equal(
    queuedNotice({ state: "waiting" }, { active: true, available: true }),
    "waiting",
  );
  // An uncertain or interrupted turn counts as active: the message waits for its review.
  assert.equal(
    queuedNotice({ state: "waiting" }, { active: true, available: false }),
    "waiting",
  );
  assert.equal(queuedNotice({ state: "waiting" }, free), "waiting");
  assert.equal(
    queuedNotice({ state: "waiting" }, { active: false, available: false }),
    "blocked",
  );
  assert.equal(
    queuedNotice({ state: "sending" }, { active: false, available: false }),
    "sending",
  );
  assert.equal(
    queuedNotice({ state: "failed" }, { active: true, available: true }),
    "failed",
  );
  // Retried for a while: the card says so once the turn is over.
  const retrying = { state: "waiting", retrying: true };
  assert.equal(queuedNotice(retrying, free), "retrying");
  assert.equal(queuedNotice(retrying, { active: true, available: true }), "waiting");
  assert.equal(queuedNotice(retrying, { active: false, available: false }), "blocked");
});
