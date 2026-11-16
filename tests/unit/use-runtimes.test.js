import test from "node:test";
import assert from "node:assert/strict";
import {
  draftRuntimeInfo,
  runtimeInfoOf,
  validRuntimes,
} from "../../web/features/assistants/runtime-list.js";

test("draftRuntimeInfo: a duplicate falls back to its source's view without the list", () => {
  const hermesInfo = { id: "hermes", capabilities: {} };
  const agents = [{ id: "a", runtimeInfo: hermesInfo }, { id: "b" }];
  const listed = { id: "hermes", capabilities: { host: {} } };
  // The list wins while it names the runtime.
  assert.equal(
    draftRuntimeInfo([{ id: "openclaw" }, listed], { runtime: "hermes" }, agents),
    listed,
  );
  // Without it, the source of a duplicate tells how its runtime behaves.
  assert.equal(
    draftRuntimeInfo([], { runtime: "hermes", duplicateOf: "a" }, agents),
    hermesInfo,
  );
  assert.equal(
    draftRuntimeInfo([], { runtime: "hermes", duplicateOf: "b" }, agents),
    undefined,
  );
  assert.equal(draftRuntimeInfo([], { runtime: "hermes" }, agents), undefined);
  assert.equal(
    draftRuntimeInfo([], { runtime: "", duplicateOf: "" }, undefined),
    undefined,
  );
});

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
