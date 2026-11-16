import test from "node:test";
import assert from "node:assert/strict";
import {
  runtimeInfoOf,
  validRuntimes,
} from "../../web/features/assistants/runtime-list.js";

test("validRuntimes keeps the entries with an id", () => {
  assert.deepEqual(validRuntimes({ runtimes: [{ id: "a" }, null, { name: "x" }] }), [
    { id: "a" },
  ]);
  assert.deepEqual(validRuntimes({}), []);
  assert.deepEqual(validRuntimes(null), []);
  assert.deepEqual(validRuntimes({ runtimes: "openclaw" }), []);
});

// The runtime list the wizard reads (GET /api/assistant-runtimes, ADR 0007).

test("runtimeInfoOf: the default is the first entry", () => {
  const list = [{ id: "openclaw" }, { id: "hermes" }];
  assert.equal(runtimeInfoOf(list, ""), list[0]);
  assert.equal(runtimeInfoOf(list, undefined), list[0]);
  assert.equal(runtimeInfoOf(list, null), list[0]);
  assert.equal(runtimeInfoOf(list, "hermes"), list[1]);
  assert.equal(runtimeInfoOf(list, "next"), undefined);
  assert.equal(runtimeInfoOf([], ""), undefined);
  assert.equal(runtimeInfoOf(undefined, "hermes"), undefined);
});
