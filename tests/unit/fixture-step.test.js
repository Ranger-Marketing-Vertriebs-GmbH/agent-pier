import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { fixtureStep } from "../helpers/application.js";

test("a fixture step that takes long is named while it is still pending", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const result = await fixtureStep(
    "application.close()",
    async () => {
      await pause(120);
      return "closed";
    },
    { after: 40 },
  );
  assert.equal(result, "closed");
  assert.ok(error.mock.callCount() >= 1);
  assert.match(
    error.mock.calls[0].arguments[0],
    /^applicationFixture: still waiting on application\.close\(\) after \d+ s$/,
  );
  // Nothing is said once the step ended.
  const said = error.mock.callCount();
  await pause(100);
  assert.equal(error.mock.callCount(), said);
});

test("a quick or failing fixture step says nothing and keeps its outcome", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  assert.equal(await fixtureStep("a step", async () => 7, { after: 40 }), 7);
  await assert.rejects(
    fixtureStep("a step", () => Promise.reject(new Error("refused")), { after: 40 }),
    /refused/,
  );
  await pause(100);
  assert.equal(error.mock.callCount(), 0);
});
