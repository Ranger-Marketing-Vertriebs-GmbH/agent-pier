import test from "node:test";
import assert from "node:assert/strict";
import { replaceWhenSettled } from "../../web/features/assistants/replace-route.js";

const target = { view: "agents", assistantId: "home", conversationId: "dinner" };

test("a refused replace is tried again until the navigation takes it", async () => {
  const calls = [];
  const answers = [false, false, true];
  const navigate = async (...args) => (calls.push(args), answers.shift());
  assert.equal(await replaceWhenSettled(navigate, target, () => true, { wait: 1 }), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], [target, true, true]);
});

test("a replace no longer needed stops, and the tries are bounded", async () => {
  let needed = true;
  let calls = 0;
  const navigate = async () => {
    calls++;
    needed = false;
    return false;
  };
  assert.equal(
    await replaceWhenSettled(navigate, target, () => needed, { wait: 1 }),
    false,
  );
  assert.equal(calls, 1);
  calls = 0;
  const refusing = async () => (calls++, false);
  assert.equal(
    await replaceWhenSettled(refusing, target, () => true, { tries: 4, wait: 1 }),
    false,
  );
  assert.equal(calls, 4);
});
