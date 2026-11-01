import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PORTS,
  defineAgentRuntime,
} from "../../server/features/assistants/runtimes/agent-runtime.js";

/**
 * The contract every agent runtime adapter meets (ADR 0006), so the OpenClaw adapter,
 * a fake and a future Hermes adapter are held to the same behaviour. `make(state)`
 * returns an `AgentRuntime` whose backend reports `state`:
 * - `channels`: the channel accounts by channel, e.g. `{ telegram: [account] }`;
 * - `unreachable`: true when the backend cannot be reached at all.
 * Later tickets add a section per sub-port as its methods arrive.
 */
export function runtimePortContract(name, make) {
  const account = { accountId: "agent-1", running: true, connected: true };

  test(`${name}: names an id and every sub-port`, async () => {
    const runtime = await make({});
    assert.equal(typeof runtime.id, "string");
    assert.ok(runtime.id.length > 0);
    for (const port of RUNTIME_PORTS) {
      assert.equal(typeof runtime[port], "object", port);
      assert.ok(Object.isFrozen(runtime[port]), port);
    }
    assert.ok(Object.isFrozen(runtime));
  });

  test(`${name}: capabilities() answers each capability with a boolean and a reason`, async () => {
    const capabilities = (await make({})).capabilities();
    assert.deepEqual(Object.keys(capabilities).sort(), [...RUNTIME_CAPABILITIES].sort());
    for (const [capability, value] of Object.entries(capabilities)) {
      assert.equal(typeof value.available, "boolean", capability);
      if (value.available) assert.equal(value.reason, undefined, capability);
      else assert.match(value.reason, /^[a-zA-Z][\w.-]*$/, capability);
    }
  });

  test(`${name}: channels.status() reports the channel accounts`, async (t) => {
    const runtime = await make({ channels: { telegram: [account] } });
    if (!runtime.capabilities().channels.available) return t.skip("no channels");
    const status = await runtime.channels.status({ probe: false });
    assert.deepEqual(status.channelAccounts.telegram, [account]);
    const defaults = await runtime.channels.status();
    assert.deepEqual(defaults.channelAccounts.telegram, [account]);
  });

  test(`${name}: channels.status() rejects while the runtime is unreachable`, async (t) => {
    const runtime = await make({ unreachable: true });
    if (!runtime.capabilities().channels.available) return t.skip("no channels");
    // A rejection, never a synchronous throw: callers await it inside try/catch.
    const pending = runtime.channels.status({ probe: false });
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending);
  });
}

/** A runtime held in memory that meets the contract; feature tests can use it too. */
export function fakeRuntime({ channels = {}, unreachable = false } = {}) {
  const reach = async (answer) => {
    if (unreachable)
      throw Object.assign(new Error("unreachable"), { code: "UNAVAILABLE" });
    return answer();
  };
  return defineAgentRuntime({
    id: "fake",
    channels: {
      status: () => reach(() => ({ channelAccounts: structuredClone(channels) })),
    },
  });
}
