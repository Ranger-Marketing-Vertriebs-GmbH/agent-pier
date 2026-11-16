import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_SLOTS,
  defineRuntimeDescriptor,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  runtimeDetails,
  runtimeList,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";

// ADR 0007, step 3: a runtime registers its own UI as surfaces at named slots of
// pages AgentPier owns.

const describe = (surfaces) => defineRuntimeDescriptor({ id: "x", name: "X", surfaces });
const surface = (extra = {}) => ({
  id: "install",
  slot: "hub.runtime",
  kind: "built",
  ...extra,
});

test("the slots are AgentPier's: a fixed list the port exports", () => {
  assert.deepEqual(RUNTIME_SLOTS, ["hub.runtime"]);
  assert.ok(Object.isFrozen(RUNTIME_SLOTS));
});

test("a descriptor resolves its surfaces; a surface shows while enabled by default", () => {
  assert.deepEqual(describe(undefined).surfaces, []);
  const { surfaces } = describe([surface(), surface({ id: "more", shows: "always" })]);
  assert.deepEqual(surfaces, [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "whileEnabled" },
    { id: "more", slot: "hub.runtime", kind: "built", shows: "always" },
  ]);
  assert.ok(Object.isFrozen(surfaces));
  assert.ok(Object.isFrozen(surfaces[0]));
});

test("a wrong surface fails as the module loads, naming what is wrong", () => {
  const refused = [
    [[surface({ id: "" })], /needs an id/],
    [[{ slot: "hub.runtime", kind: "built" }], /needs an id/],
    [[surface(), surface()], /x: duplicate surface id install/],
    [[surface({ slot: "hub.nowhere" })], /install: unknown slot "hub\.nowhere"/],
    [[surface({ slot: undefined })], /install: unknown slot/],
    [[surface({ kind: "described" })], /install: unknown kind "described"/],
    [[surface({ kind: undefined })], /install: unknown kind/],
    [[surface({ shows: "never" })], /install: unknown shows "never"/],
    [[surface({ fields: [] })], /install: unknown key fields/],
    [[null], /needs an id/],
    ["install", /surfaces must be a list/],
  ];
  for (const [surfaces, message] of refused)
    assert.throws(
      () => describe(surfaces),
      (error) => error instanceof TypeError && message.test(error.message),
      JSON.stringify(surfaces),
    );
});

test("Hermes registers its install group, OpenClaw no surface", () => {
  assert.deepEqual(hermesDescriptor.surfaces, [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
  ]);
  assert.deepEqual(openClawDescriptor.surfaces, []);
});

test("an agent's runtime view and the runtime list carry the surfaces", () => {
  const supervisor = { client: null, status: () => ({ version: "2026.10.9" }) };
  assert.deepEqual(
    runtimeDetails({ runtime: "hermes" }, null).surfaces,
    hermesDescriptor.surfaces,
  );
  assert.deepEqual(runtimeDetails({ runtime: "openclaw" }, supervisor).surfaces, []);
  assert.deepEqual(runtimeDetails(null, null).surfaces, []);
  // A runtime this AgentPier lacks registers nothing here.
  assert.deepEqual(runtimeDetails({ runtime: "next" }, supervisor).surfaces, []);
  const [openclaw, hermes] = runtimeList(supervisor);
  assert.deepEqual(openclaw.surfaces, []);
  assert.deepEqual(hermes.surfaces, hermesDescriptor.surfaces);
  // The list is sent as JSON: the surfaces survive it unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(hermes)).surfaces, hermes.surfaces);
});
