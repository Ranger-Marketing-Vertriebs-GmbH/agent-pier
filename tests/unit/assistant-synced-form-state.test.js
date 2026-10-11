import test from "node:test";
import assert from "node:assert/strict";
import { isDirty, sameValue } from "../../web/features/assistants/synced-form-state.js";

const base = {
  name: "Home",
  instructions: "Plan meals",
  connectionId: "router",
  modelId: "model",
  capabilities: { memory: false, reminders: false },
};

test("identical values are clean", () => {
  assert.equal(isDirty({ ...base, capabilities: { ...base.capabilities } }, base), false);
});

test("a changed text field is dirty", () => {
  assert.equal(isDirty({ ...base, name: "Home 2" }, base), true);
});

test("a changed nested capability is dirty", () => {
  assert.equal(
    isDirty({ ...base, capabilities: { memory: true, reminders: false } }, base),
    true,
  );
});

test("a key present on only one side is dirty", () => {
  const { modelId, ...withoutModel } = base;
  assert.equal(modelId, "model");
  assert.equal(isDirty(withoutModel, base), true);
  assert.equal(isDirty(base, withoutModel), true);
});

test("sameValue compares by value", () => {
  assert.equal(sameValue({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(sameValue({ a: [1, 2] }, { a: [2, 1] }), false);
});
