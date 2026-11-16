import test from "node:test";
import assert from "node:assert/strict";
import {
  draftRuntimeInfo,
  optionalRuntime,
  otherRuntime,
  readyRuntimes,
  runtimeChoice,
  runtimeInfoOf,
  runtimeNameOf,
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

// Step 2 of ADR 0007: the list carries each runtime's install state, and the wizard's
// chooser is built from it.
const builtin = { id: "one", name: "One", install: { kind: "builtin" }, ready: true };
const extra = (state = {}, ready = false) => ({
  id: "two",
  name: "Two",
  install: { kind: "optional", enabled: false, installed: false, ...state },
  ready,
});
const on = extra({ enabled: true, installed: true }, true);

test("readyRuntimes: the runtimes a new agent may run on now, the default first", () => {
  assert.deepEqual(readyRuntimes([builtin, on]), [builtin, on]);
  assert.deepEqual(readyRuntimes([builtin, extra()]), [builtin]);
  // An entry without the field (a list that did not arrive whole) is not ready.
  assert.deepEqual(readyRuntimes([{ id: "x" }]), []);
  assert.deepEqual(readyRuntimes(undefined), []);
});

test("otherRuntime: a draft's runtime is another one when set and not the default", () => {
  assert.equal(otherRuntime([builtin, on], ""), false);
  assert.equal(otherRuntime([builtin, on], "one"), false);
  assert.equal(otherRuntime([builtin, on], "two"), true);
  // Without the list a named runtime counts as another one.
  assert.equal(otherRuntime([], "two"), true);
  assert.equal(otherRuntime([], ""), false);
});

test("runtimeChoice: the ready runtimes, offered when there is more than one", () => {
  const blank = { start: "blank", runtime: "" };
  assert.deepEqual(runtimeChoice([builtin, on], blank), {
    shown: true,
    readOnly: false,
    options: [
      { id: "one", value: "", name: "One", checked: true },
      { id: "two", value: "two", name: "Two", checked: false },
    ],
  });
  assert.deepEqual(
    runtimeChoice([builtin, on], { start: "blank", runtime: "two" }).options.map(
      (option) => option.checked,
    ),
    [false, true],
  );
  // The default named by its id is the default.
  assert.equal(
    runtimeChoice([builtin, on], { start: "blank", runtime: "one" }).options[0].checked,
    true,
  );
  // One ready runtime, or no list: no choice.
  assert.equal(runtimeChoice([builtin, extra()], blank).shown, false);
  assert.equal(runtimeChoice([builtin, extra({ enabled: true })], blank).shown, false);
  assert.equal(runtimeChoice([], blank).shown, false);
});

test("runtimeChoice: a duplicate names its source's runtime read-only", () => {
  const duplicate = (fields) => ({ start: "duplicate", duplicateOf: "a", ...fields });
  // Nothing until the source is chosen.
  assert.equal(
    runtimeChoice([builtin, on], duplicate({ duplicateOf: "", runtime: "" })).shown,
    false,
  );
  assert.deepEqual(runtimeChoice([builtin, on], duplicate({ runtime: "one" })), {
    shown: true,
    readOnly: true,
    options: [],
  });
  // One off the default shows also while the other runtime is not ready, or unknown.
  assert.equal(
    runtimeChoice([builtin, extra()], duplicate({ runtime: "two" })).shown,
    true,
  );
  assert.equal(runtimeChoice([], duplicate({ runtime: "two" })).shown, true);
  assert.equal(
    runtimeChoice([builtin, extra()], duplicate({ runtime: "" })).shown,
    false,
  );
});

test("runtimeNameOf: the view's name, the id while it is unknown", () => {
  assert.equal(runtimeNameOf(on, "two"), "Two");
  assert.equal(runtimeNameOf(undefined, "two"), "two");
  assert.equal(runtimeNameOf({ id: "two" }), "two");
  assert.equal(runtimeNameOf(undefined, ""), "");
});

test("optionalRuntime: the entry whose install state the owner switches", () => {
  assert.equal(optionalRuntime([builtin, on]), on);
  assert.equal(optionalRuntime([builtin]), undefined);
  assert.equal(optionalRuntime([{ id: "old" }]), undefined);
  assert.equal(optionalRuntime(undefined), undefined);
});
