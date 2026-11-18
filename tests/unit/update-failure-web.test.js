import test from "node:test";
import assert from "node:assert/strict";
import { updateFailure } from "../../web/features/assistants/update-cause.js";
import { assistantCopy as de } from "../../web/lib/i18n/de/assistants.js";
import { assistantCopy as en } from "../../web/lib/i18n/en/assistants.js";

const steps = ["stop", "snapshot", "migrate", "start", "validate", "verify"];

test("a rolled-back update shows the step, check and code that failed", () => {
  assert.deepEqual(
    updateFailure({
      diagnosticStep: "validate",
      diagnosticCheck: "session:c1",
      diagnosticErrorCode: "agent-database-inspection-failed",
    }),
    { step: "validate", detail: "session:c1 · agent-database-inspection-failed" },
  );
  assert.deepEqual(updateFailure({ diagnosticStep: "start" }), {
    step: "start",
    detail: "",
  });
  // Nothing to show, a step this build does not know, or markup.
  for (const status of [
    null,
    {},
    { diagnosticStep: "toString" },
    { diagnosticStep: "unknown-step" },
  ])
    assert.equal(updateFailure(status), null);
  assert.equal(
    updateFailure({ diagnosticStep: "validate", diagnosticCheck: "<b>x</b>" }).detail,
    "",
  );
});

test("every step has its name in both languages", () => {
  for (const catalog of [de, en]) {
    const { updates } = catalog;
    assert.deepEqual(Object.keys(updates.steps).sort(), [...steps].sort());
    assert.match(updates.failedAt(updates.steps.validate, "session:c1"), /session:c1/);
    assert.doesNotMatch(updates.failedAt(updates.steps.start, ""), /\(\)/);
  }
});
