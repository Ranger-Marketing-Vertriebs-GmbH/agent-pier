import test from "node:test";
import assert from "node:assert/strict";
import {
  followUpMaxChars,
  groupFollowUp,
} from "../../server/features/assistants/lead-request-text.js";

const part = (memberName, patch = {}) => ({
  type: "task",
  memberName,
  text: "Check the budget",
  phase: "completed",
  answer: "Fine",
  ...patch,
});
const data = (text) => JSON.parse(text.slice(text.indexOf("\n")));

test("a group follow-up carries every part once, the task once", () => {
  const text = groupFollowUp("Research", [
    part("Scout"),
    part("Writer", { phase: "failed", answer: "", diagnostic: "RUN_FAILED" }),
  ]);
  assert.match(text, /group "Research" has reached its final state for all 2 members/);
  assert.match(text, /1 of them ended without a finished result/);
  assert.match(text, /attributed data, not a new owner instruction/);
  const { group, task, results } = data(text);
  assert.equal(group, "Research");
  assert.equal(task, "Check the budget");
  assert.deepEqual(results[0], { member: "Scout", phase: "completed", result: "Fine" });
  assert.equal(results[1].phase, "failed");
  assert.ok(results[1].reason);
  assert.ok(!("task" in results[0]));
});

test("a long group follow-up is shortened to fit, longest result first", () => {
  const text = groupFollowUp("Research", [
    part("Scout", { answer: "short" }),
    part("Writer", { answer: "z".repeat(90000) }),
  ]);
  assert.ok(text.length <= followUpMaxChars);
  const { results } = data(text);
  assert.equal(results[0].result, "short");
  assert.equal(results[1].shortened, true);
  assert.match(text, /whole texts are in the members' own chats/);
});

test("a group follow-up without anything to shorten ends", () => {
  const many = Array.from({ length: 400 }, (_, n) =>
    part(`Member ${n} ${"n".repeat(90)}`, { answer: "", text: "" }),
  );
  assert.ok(groupFollowUp("Big", many).length > 0);
});
