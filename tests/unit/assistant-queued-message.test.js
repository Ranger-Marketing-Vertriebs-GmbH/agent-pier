import test from "node:test";
import assert from "node:assert/strict";
import {
  queueMessage,
  queuedDelivery,
  sendsQueued,
  takeBack,
} from "../../web/features/assistants/queued-message.js";

const ids = () => {
  let n = 0;
  return () => `key-${++n}`;
};

test("a queued message keeps its text, team permission, files and delivery key", () => {
  const queued = queueMessage(
    null,
    { text: "Add a dessert\n", teamAllowed: true, files: ["file-1"] },
    ids(),
  );
  assert.deepEqual(queued, {
    text: "Add a dessert",
    teamAllowed: true,
    files: ["file-1"],
    clientRequestId: "key-1",
  });
  assert.deepEqual(queuedDelivery(queued), {
    text: "Add a dessert",
    clientRequestId: "key-1",
    teamAllowed: true,
  });
  assert.deepEqual(queuedDelivery({ ...queued, teamAllowed: false }), {
    text: "Add a dessert",
    clientRequestId: "key-1",
  });
});

test("a second message joins the queued one on a new line with a new key", () => {
  const next = ids();
  const first = queueMessage(null, { text: "Add a dessert", files: ["a"] }, next);
  const second = queueMessage(first, { text: "Without nuts", files: ["b"] }, next);
  assert.deepEqual(second, {
    text: "Add a dessert\nWithout nuts",
    teamAllowed: false,
    files: ["a", "b"],
    clientRequestId: "key-2",
  });
  // Files alone add no empty line; the team permission, once given, stays.
  const files = queueMessage(
    { ...second, teamAllowed: true },
    { text: "  ", files: ["c"] },
    next,
  );
  assert.equal(files.text, "Add a dessert\nWithout nuts");
  assert.equal(files.teamAllowed, true);
  assert.deepEqual(files.files, ["a", "b", "c"]);
});

test("taking a queued message back puts it before the composer text", () => {
  const queued = queueMessage(null, { text: "Swap Tuesday" }, ids());
  assert.equal(takeBack(queued, ""), "Swap Tuesday");
  assert.equal(takeBack(queued, "Also Sunday"), "Swap Tuesday\nAlso Sunday");
  assert.equal(takeBack({ ...queued, text: "" }, "Also Sunday"), "Also Sunday");
  assert.equal(takeBack(null, "Draft"), "Draft");
});

test("a queued message goes out only once the agent is free to take it", () => {
  const queued = queueMessage(null, { text: "Next" }, ids());
  const free = { active: false, busy: false, available: true };
  assert.equal(sendsQueued(queued, free), true);
  assert.equal(sendsQueued(null, free), false);
  assert.equal(sendsQueued(queued, { ...free, active: true }), false);
  assert.equal(sendsQueued(queued, { ...free, busy: true }), false);
  assert.equal(sendsQueued(queued, { ...free, available: false }), false);
});
