import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  shownSurfaces,
  slotSurfaces,
  surfaceKey,
  surfaceShows,
} from "../../web/features/assistants/runtime-surfaces.js";
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
  assert.deepEqual(RUNTIME_SLOTS, [
    "hub.runtime",
    "hub.runtime.advanced",
    "agent.capabilities",
  ]);
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
    // A described surface is checked in runtime-described-surfaces.test.js.
    [[surface({ kind: "sketched" })], /install: unknown kind "sketched"/],
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

test("Hermes registers its install group and Mixture of Agents, OpenClaw no surface", () => {
  assert.deepEqual(hermesDescriptor.surfaces, [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
    { id: "mixture", slot: "agent.capabilities", kind: "built", shows: "whileEnabled" },
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

// The web app's half: which surfaces a slot renders (runtime-surfaces.js), and that
// each runtime's web module registers what its descriptor states.

const built = (id, shows, slot = "hub.runtime") => ({ id, slot, kind: "built", shows });
const listed = (id, ready, surfaces) => ({ id, name: id, ready, surfaces });

test("surfaceShows: always, or while a new agent may run on the runtime", () => {
  const off = listed("two", false, []);
  const on = listed("two", true, []);
  assert.equal(surfaceShows(off, built("a", "always")), true);
  assert.equal(surfaceShows(on, built("a", "always")), true);
  assert.equal(surfaceShows(off, built("a", "whileEnabled")), false);
  assert.equal(surfaceShows(on, built("a", "whileEnabled")), true);
  // A rule this build does not know shows nothing.
  assert.equal(surfaceShows(on, built("a", "sometimes")), false);
  assert.equal(surfaceShows(on, { id: "a" }), false);
  assert.equal(surfaceShows(undefined, built("a", "whileEnabled")), false);
});

test("slotSurfaces: a slot's built surfaces that show, in list and descriptor order", () => {
  const one = listed("one", true, [built("b", "whileEnabled"), built("a", "always")]);
  const two = listed("two", false, [
    built("install", "always"),
    built("rows", "whileEnabled"),
    built("elsewhere", "always", "hub.other"),
    { id: "fields", slot: "hub.runtime", kind: "described", shows: "always" },
  ]);
  const plain = { id: "old", ready: true };
  assert.deepEqual(slotSurfaces([one, plain, two], "hub.runtime").map(surfaceKey), [
    "one:b",
    "one:a",
    "two:install",
  ]);
  const [first] = slotSurfaces([one, two], "hub.runtime");
  assert.equal(first.runtime, one);
  assert.equal(first.surface, one.surfaces[0]);
  assert.deepEqual(slotSurfaces([one, two], "hub.other").map(surfaceKey), [
    "two:elsewhere",
  ]);
  assert.deepEqual(slotSurfaces([one], "hub.nowhere"), []);
  assert.deepEqual(slotSurfaces([], "hub.runtime"), []);
  assert.deepEqual(slotSurfaces(undefined, "hub.runtime"), []);
  assert.deepEqual(slotSurfaces([{ id: "x", surfaces: "install" }], "hub.runtime"), []);
});

test("shownSurfaces: the built surfaces that show, of every slot", () => {
  const two = listed("two", true, [
    built("install", "always"),
    built("elsewhere", "whileEnabled", "hub.other"),
  ]);
  assert.deepEqual(shownSurfaces([two]).map(surfaceKey), [
    "two:install",
    "two:elsewhere",
  ]);
  assert.deepEqual(shownSurfaces(null), []);
});

// The web runtime modules hold components (JSX), which Node does not load: a
// component file answers a stub here, so the registry itself is the one under test.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith(".jsx")
      ? {
          format: "module",
          shortCircuit: true,
          source: "export default function Stub() { return null; }",
        }
      : nextLoad(url, context),
});
const { webRuntime, webRuntimes } =
  await import("../../web/features/assistants/runtimes/index.js");
const { runtimeSearch } =
  await import("../../web/features/assistants/runtimes/search.js");

const descriptors = [openClawDescriptor, hermesDescriptor];
const builtIds = (descriptor) =>
  descriptor.surfaces.filter((entry) => entry.kind === "built").map((entry) => entry.id);

test("every built surface a descriptor names has its component, and the reverse", () => {
  for (const descriptor of descriptors) {
    const registered = Object.keys(webRuntime(descriptor.id)?.surfaces ?? {});
    assert.deepEqual(registered.sort(), builtIds(descriptor).sort(), descriptor.id);
    for (const id of registered)
      assert.equal(
        typeof webRuntime(descriptor.id).surfaces[id],
        "function",
        `${descriptor.id}.${id}`,
      );
  }
  // No web module of a runtime this AgentPier does not ship.
  for (const runtime of webRuntimes)
    assert.ok(
      descriptors.some((descriptor) => descriptor.id === runtime.id),
      runtime.id,
    );
  assert.equal(webRuntime("next"), undefined);
  assert.equal(webRuntime("toString"), undefined);
  assert.equal(webRuntime(undefined), undefined);
});

test("the search entries of a runtime are its web module's, each of a surface it has", () => {
  for (const descriptor of descriptors) {
    const entries = runtimeSearch(descriptor.id);
    assert.deepEqual(entries, webRuntime(descriptor.id)?.search ?? [], descriptor.id);
    for (const entry of entries) {
      assert.ok(builtIds(descriptor).includes(entry.surface), entry.surface);
      assert.equal(typeof entry.label, "function");
    }
    // One entry per surface: its id in the index is the runtime's and the surface's.
    const surfaces = entries.map((entry) => entry.surface);
    assert.equal(new Set(surfaces).size, surfaces.length, descriptor.id);
    // A group of Agents › Runtime, or of an agent's tab, is findable in the search.
    for (const entry of descriptor.surfaces)
      if (entry.kind === "built")
        assert.ok(surfaces.includes(entry.id), `${descriptor.id}.${entry.id}`);
  }
  assert.deepEqual(runtimeSearch("next"), []);
  assert.deepEqual(runtimeSearch("toString"), []);
});
