import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  RUNTIME_PORTS,
  available,
  defineAgentRuntime,
  unavailable,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import {
  hostReady,
  runtimeFor,
  runtimeResolver,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { fakeRuntime, runtimePortContract } from "../helpers/runtime-port-contract.js";
import { openClawClientFake, openClawStore } from "../helpers/openclaw-client-fake.js";

// A supervisor whose Gateway client answers like OpenClaw, or none while it is down.
// Its lifecycle moves availability as runtime-supervisor.js does; every start
// connects a new client, as each launch does, to the Gateway's one store.
function fakeSupervisor({
  channels = {},
  unreachable = false,
  version = null,
  runFailure = null,
} = {}) {
  const calls = [];
  const store = openClawStore();
  const connect = () => openClawClientFake({ channels, runFailure, calls, store });
  const supervisor = new EventEmitter();
  const state = {
    availability: unreachable ? "failed" : "ready",
    sync: "stale",
    version,
    diagnostic: unreachable ? "PROCESS_EXIT" : null,
  };
  const setState = (patch) => {
    Object.assign(state, patch);
    supervisor.emit("status", { ...state });
  };
  return Object.assign(supervisor, {
    client: unreachable ? null : connect(),
    calls,
    lifecycle: [],
    status: () => ({ ...state }),
    async start(options) {
      supervisor.lifecycle.push(["start", options]);
      setState({ availability: "starting" });
      supervisor.client = connect();
      setState({ availability: "ready", sync: "reconciling" });
    },
    async stop(options) {
      supervisor.lifecycle.push(["stop", options]);
      // The supervisor closes the client it lets go (runtime-supervisor.js).
      supervisor.client?.close?.();
      supervisor.client = null;
      setState({ availability: "stopping" });
      setState({ availability: "disabled", sync: "stale" });
    },
    async restart() {
      supervisor.lifecycle.push(["restart"]);
      await supervisor.stop();
      await supervisor.start();
    },
  });
}

runtimePortContract("fake runtime", (state) => fakeRuntime(state));
runtimePortContract("OpenClaw adapter", (state) =>
  createOpenClawRuntime(fakeSupervisor(state)),
);

test("the OpenClaw adapter calls channels.status on the current client", async () => {
  const supervisor = fakeSupervisor({ channels: { telegram: [] } });
  const runtime = createOpenClawRuntime(supervisor);
  assert.equal(runtime.id, "openclaw");
  await runtime.channels.status({ probe: false });
  // A restart replaces the client; the adapter follows it.
  const replaced = fakeSupervisor({ channels: { telegram: [{ accountId: "a" }] } });
  supervisor.client = replaced.client;
  const status = await runtime.channels.status({ probe: true });
  assert.deepEqual(supervisor.calls, [["channels.status", { probe: false }]]);
  assert.deepEqual(replaced.calls, [["channels.status", { probe: true }]]);
  assert.deepEqual(status.channelAccounts.telegram, [{ accountId: "a" }]);
});

test("the OpenClaw host follows the supervisor's client and lifecycle", async () => {
  const supervisor = fakeSupervisor({ version: "2026.10.3" });
  const { host } = createOpenClawRuntime(supervisor);
  assert.equal(host.ready(), true);
  // Readiness is the client's: a connected process whose client dropped is not ready.
  supervisor.client = { ready: false };
  assert.equal(host.ready(), false);
  supervisor.client = null;
  assert.equal(host.ready(), false);
  const seen = [];
  const unsubscribe = host.subscribe((status) => seen.push(status.availability));
  await host.start({ automatic: true });
  await host.stop({ urgent: true });
  unsubscribe();
  assert.equal(supervisor.listenerCount("status"), 0);
  await host.restart();
  assert.deepEqual(seen, ["starting", "ready", "stopping", "disabled"]);
  assert.deepEqual(supervisor.lifecycle, [
    ["start", { automatic: true }],
    ["stop", { urgent: true }],
    ["restart"],
    ["stop", undefined],
    ["start", undefined],
  ]);
  assert.equal(host.version(), "2026.10.3");
  assert.equal(createOpenClawRuntime(fakeSupervisor()).host.version(), null);
});

test("hostReady answers for a supervisor, or false without one", () => {
  assert.equal(hostReady(fakeSupervisor()), true);
  assert.equal(hostReady(fakeSupervisor({ unreachable: true })), false);
  assert.equal(hostReady(undefined), false);
  assert.equal(hostReady(null), false);
  // Feature tests pass bare stand-ins of the supervisor.
  assert.equal(hostReady({ client: { ready: true } }), true);
  assert.equal(hostReady({}), false);
});

test("runtimeFor returns one OpenClaw adapter per supervisor for every agent", () => {
  const supervisor = fakeSupervisor();
  const first = runtimeFor({ id: "a" }, supervisor);
  assert.equal(first.id, "openclaw");
  assert.equal(runtimeFor({ id: "b" }, supervisor), first);
  assert.equal(runtimeFor(null, supervisor), first);
  assert.notEqual(runtimeFor({ id: "a" }, fakeSupervisor()), first);
  assert.throws(() => runtimeFor({ id: "a" }, null), TypeError);
});

test("runtimeResolver reads the supervisor at each resolution", () => {
  let supervisor = fakeSupervisor();
  const resolve = runtimeResolver(() => supervisor);
  const first = resolve({ id: "a" });
  supervisor = fakeSupervisor();
  assert.notEqual(resolve({ id: "a" }), first);
});

test("defineAgentRuntime fills sub-ports and capabilities and refuses unknown ones", () => {
  const runtime = defineAgentRuntime({
    id: "x",
    capabilities: { browser: unavailable("runtimeBrowserUnsupported") },
  });
  assert.deepEqual(
    Object.keys(runtime).sort(),
    ["capabilities", "id", ...RUNTIME_PORTS].sort(),
  );
  assert.deepEqual(runtime.capabilities().browser, {
    available: false,
    reason: "runtimeBrowserUnsupported",
  });
  assert.deepEqual(runtime.capabilities().sessions, available());
  assert.throws(
    () => defineAgentRuntime({ id: "x", shells: {} }),
    /Unknown runtime ports/,
  );
  assert.throws(
    () => defineAgentRuntime({ id: "x", capabilities: { teleport: available() } }),
    /Unknown runtime capabilities/,
  );
  assert.throws(() => defineAgentRuntime({}), TypeError);
  assert.throws(() => unavailable(""), TypeError);
});
