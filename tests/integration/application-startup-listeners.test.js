import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

// The server's start hooks run once it listens. Each hook used to be its own
// "listening" listener; with Node's own listener and listen()'s callback they passed
// the default limit of 10 and Node warned of a leak on every start.
test("starting the application stays below the listener warning limit", async (t) => {
  const warnings = [];
  const onWarning = (warning) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
  };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  await applicationFixture(t, enabledAssistants);
  // Warnings are emitted on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, []);
});
