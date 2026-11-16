import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_CAPABILITIES,
  defineAgentRuntime,
  defineRuntimeDescriptor,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  DEFAULT_TRAITS,
  RUNTIME_TRAITS,
} from "../../server/features/assistants/runtimes/runtime-traits.js";
import { hermesFleetOf } from "../../server/features/assistants/runtimes/hermes/hermes-hosts.js";
import {
  keepsExecAllowlist,
  runtimeDetails,
  runtimeList,
  traitOf,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";

// ADR 0007: each runtime states its traits in its descriptor; feature code reads them.

test("trait features are capabilities", () => {
  for (const feature of Object.keys(RUNTIME_TRAITS))
    assert.ok(RUNTIME_CAPABILITIES.includes(feature), feature);
});

test("a descriptor needs an id and a name and checks its traits", () => {
  assert.throws(() => defineRuntimeDescriptor({ name: "X" }), TypeError);
  assert.throws(() => defineRuntimeDescriptor({ id: "x" }), TypeError);
  assert.throws(
    () => defineRuntimeDescriptor({ id: "x", name: "X", traits: { host: { kind: 1 } } }),
    /host\.kind/,
  );
  const descriptor = defineRuntimeDescriptor({ id: "x", name: "X" });
  assert.deepEqual(descriptor, {
    id: "x",
    name: "X",
    // What its agents go by in a sentence; the name unless stated.
    shortName: "X",
    traits: DEFAULT_TRAITS,
    surfaces: [],
  });
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(
    defineRuntimeDescriptor({ id: "x", name: "X Agent", shortName: "X" }).shortName,
    "X",
  );
  assert.throws(
    () => defineRuntimeDescriptor({ id: "x", name: "X", shortName: "" }),
    TypeError,
  );
  assert.equal(openClawDescriptor.shortName, "OpenClaw");
  assert.equal(hermesDescriptor.shortName, "Hermes");
});

test("OpenClaw states the defaults, Hermes its own", () => {
  assert.equal(openClawDescriptor.id, "openclaw");
  assert.equal(openClawDescriptor.name, "OpenClaw");
  assert.deepEqual(openClawDescriptor.traits, DEFAULT_TRAITS);
  assert.equal(hermesDescriptor.id, "hermes");
  assert.deepEqual(hermesDescriptor.traits, {
    approvals: {
      shellLevels: ["off", "approval", "every", "full"],
      allowlist: "exactCommands",
    },
    agentFiles: { memoryFormat: "entries", dreaming: "agent" },
    models: { chatgptLogin: "agentpierHeld" },
    channelBots: { peopleApply: "restart" },
    skills: { learnsByDefault: true, userAgentsLearn: true, writesWhenAsked: true },
    sessions: { chatFolders: true },
    host: { process: "perAgent", install: "optional" },
  });
});

test("traitOf reads the agent's runtime without a supervisor", () => {
  assert.equal(traitOf({ runtime: "hermes" }, "sessions", "chatFolders"), true);
  assert.equal(traitOf({ runtime: "openclaw" }, "sessions", "chatFolders"), false);
  assert.equal(traitOf(null, "approvals", "allowlist"), "patterns");
  assert.equal(traitOf({ runtime: "next" }, "host", "process"), "shared");
  assert.throws(() => traitOf(null, "host", "kind"), TypeError);
  assert.throws(() => traitOf(null, "kanban", "board"), TypeError);
});

test("the exec allowlist follows the trait and still refuses an unknown runtime", () => {
  assert.equal(keepsExecAllowlist({ runtime: "openclaw" }), true);
  assert.equal(keepsExecAllowlist({ runtime: "hermes" }), false);
  assert.throws(() => keepsExecAllowlist({ runtime: "next" }), { status: 409 });
});

test("a capability carries its traits beside its availability", () => {
  const runtime = defineAgentRuntime({ id: "x", traits: hermesDescriptor.traits });
  assert.deepEqual(runtime.capabilities().sessions, {
    available: true,
    chatFolders: true,
  });
  assert.deepEqual(runtime.capabilities().routines, { available: true });
  assert.equal("everyCommandApproval" in runtime.capabilities(), false);
  assert.ok(Object.isFrozen(runtime.capabilities().sessions));
  const plain = defineAgentRuntime({ id: "y" });
  assert.deepEqual(plain.capabilities().approvals, {
    available: true,
    ...DEFAULT_TRAITS.approvals,
  });
});

test("details carry traits while no host answers", () => {
  const details = runtimeDetails({ runtime: "hermes" }, null);
  assert.equal(details.name, "Hermes Agent");
  assert.equal(details.version, null);
  assert.deepEqual(details.capabilities.approvals, {
    shellLevels: ["off", "approval", "every", "full"],
    allowlist: "exactCommands",
  });
  assert.equal("routines" in details.capabilities, false);
});

test("an unknown runtime is unavailable with default traits", () => {
  const { capabilities } = runtimeDetails({ runtime: "next" }, null);
  assert.deepEqual(capabilities.sessions, {
    available: false,
    reason: "runtimeUnknown",
    chatFolders: false,
  });
  assert.deepEqual(capabilities.routines, {
    available: false,
    reason: "runtimeUnknown",
  });
});

test("the list makes no process set for an agent that does not exist", () => {
  const supervisor = { client: null, status: () => ({ version: "2026.10.9" }) };
  const [openclaw, hermes] = runtimeList(supervisor);
  assert.equal(openclaw.capabilities.routines.available, true);
  assert.deepEqual(hermes.capabilities.sessions, { chatFolders: true });
  assert.deepEqual(hermesFleetOf(supervisor).list(), []);
});

test("the list names every runtime this AgentPier ships", () => {
  assert.deepEqual(
    runtimeList(null).map((r) => [r.id, r.name]),
    [
      ["openclaw", "OpenClaw"],
      ["hermes", "Hermes Agent"],
    ],
  );
});

// Step 2 of ADR 0007: the list carries each runtime's install state.

test("the list names a built-in runtime ready and an optional one by its install state", () => {
  const supervisor = { client: null, status: () => ({ version: "2026.10.9" }) };
  const state = {
    enabled: true,
    installed: true,
    installing: false,
    updating: false,
    version: "0.22.5",
    targetVersion: "0.22.6",
    updateAvailable: true,
    error: null,
    errorCause: null,
    blockerItems: [],
    agents: 2,
    pythonVersion: "3.13.1",
  };
  const [openclaw, hermes] = runtimeList(supervisor, {
    [hermesDescriptor.id]: () => state,
  });
  assert.deepEqual(openclaw.install, { kind: "builtin" });
  assert.equal(openclaw.ready, true);
  // Every field of the state, none renamed.
  assert.deepEqual(hermes.install, { kind: "optional", ...state });
  assert.equal(hermes.ready, true);
  // A runtime with a host per agent shows its installed version.
  assert.equal(hermes.version, "0.22.5");
  assert.deepEqual(Object.keys(openclaw), [
    "id",
    "name",
    "version",
    "capabilities",
    "surfaces",
    "install",
    "ready",
  ]);
});

test("an optional runtime is ready only while switched on and installed", () => {
  const ready = (state) =>
    runtimeList(null, { [hermesDescriptor.id]: () => state })[1].ready;
  assert.equal(ready({ enabled: true, installed: true }), true);
  assert.equal(ready({ enabled: false, installed: true }), false);
  assert.equal(ready({ enabled: true, installed: false, installing: true }), false);
});

test("without an install source an optional runtime is listed off and not installed", () => {
  for (const installs of [undefined, {}, { [hermesDescriptor.id]: () => undefined }]) {
    const [openclaw, hermes] = runtimeList(null, installs);
    assert.deepEqual(openclaw.install, { kind: "builtin" });
    assert.equal(openclaw.ready, true);
    assert.deepEqual(hermes.install, {
      kind: "optional",
      enabled: false,
      installed: false,
    });
    assert.equal(hermes.ready, false);
    assert.equal(hermes.version, null);
  }
});
