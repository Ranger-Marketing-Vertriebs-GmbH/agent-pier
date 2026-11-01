import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_PORTS,
  available,
  defineAgentRuntime,
  unavailable,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import {
  runtimeFor,
  runtimeResolver,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { fakeRuntime, runtimePortContract } from "../helpers/runtime-port-contract.js";

// A supervisor whose Gateway client answers like OpenClaw, or none while it is down.
function fakeSupervisor({ channels = {}, unreachable = false } = {}) {
  const calls = [];
  const client = {
    ready: true,
    async call(method, params) {
      calls.push([method, params]);
      if (method === "sessions.create") return { key: `session:${params.label}` };
      if (method === "sessions.messages.subscribe") return {};
      if (method !== "channels.status") throw new Error(`unexpected ${method}`);
      return { channelAccounts: structuredClone(channels) };
    },
  };
  return { client: unreachable ? null : client, calls };
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

test("the OpenClaw adapter creates and subscribes sessions on the current client", async () => {
  const supervisor = fakeSupervisor();
  const runtime = createOpenClawRuntime(supervisor);
  const created = await runtime.sessions.create({ agentId: "agent-1", label: "main" });
  await runtime.sessions.subscribe({ key: created.key });
  assert.deepEqual(supervisor.calls, [
    ["sessions.create", { agentId: "agent-1", label: "main" }],
    ["sessions.messages.subscribe", { key: "session:main" }],
  ]);
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
