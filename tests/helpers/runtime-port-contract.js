import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_AVAILABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PORTS,
  defineAgentRuntime,
} from "../../server/features/assistants/runtimes/agent-runtime.js";

/**
 * The contract every agent runtime adapter meets (ADR 0006), so the OpenClaw adapter,
 * a fake and a future Hermes adapter are held to the same behaviour. `make(state)`
 * returns an `AgentRuntime` whose backend reports `state`:
 * - `channels`: the channel accounts by channel, e.g. `{ telegram: [account] }`;
 * - `unreachable`: true when the backend cannot be reached at all;
 * - `version`: the version the host runs.
 * A reachable backend creates sessions keyed `session:<label>`.
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

  test(`${name}: host.ready() answers synchronously whether calls may go out`, async () => {
    assert.equal((await make({})).host.ready(), true);
    assert.equal((await make({ unreachable: true })).host.ready(), false);
  });

  test(`${name}: host.status() reports a known availability and the version`, async () => {
    const runtime = await make({ version: "2026.10.3" });
    const status = runtime.host.status();
    assert.ok(HOST_AVAILABILITY.includes(status.availability), status.availability);
    assert.equal(status.availability, "ready");
    assert.equal(status.version, "2026.10.3");
    assert.equal(runtime.host.version(), "2026.10.3");
    // A copy: changing it never changes the host's own state.
    status.availability = "failed";
    assert.equal(runtime.host.status().availability, "ready");
    const down = (await make({ unreachable: true })).host.status();
    assert.ok(HOST_AVAILABILITY.includes(down.availability), down.availability);
    assert.notEqual(down.availability, "ready");
  });

  test(`${name}: host stop and start move availability and notify subscribers`, async () => {
    const runtime = await make({ version: "2026.10.3" });
    const seen = [];
    const unsubscribe = runtime.host.subscribe((status) =>
      seen.push(status.availability),
    );
    assert.equal(typeof unsubscribe, "function");
    await runtime.host.stop();
    assert.equal(runtime.host.ready(), false);
    assert.equal(runtime.host.status().availability, "disabled");
    await runtime.host.start();
    assert.equal(runtime.host.ready(), true);
    assert.equal(seen.at(-1), "ready");
    assert.ok(seen.includes("disabled"), seen.join());
    unsubscribe();
    const before = seen.length;
    await runtime.host.restart();
    assert.equal(runtime.host.ready(), true);
    assert.equal(seen.length, before);
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

  test(`${name}: sessions.create() resolves the new session's key`, async (t) => {
    const runtime = await make({});
    if (!runtime.capabilities().sessions.available) return t.skip("no sessions");
    const created = await runtime.sessions.create({ agentId: "agent-1", label: "one" });
    assert.equal(created.key, "session:one");
    await runtime.sessions.subscribe({ key: created.key });
  });

  test(`${name}: sessions reject while the runtime is unreachable`, async (t) => {
    const runtime = await make({ unreachable: true });
    if (!runtime.capabilities().sessions.available) return t.skip("no sessions");
    const options = { budgetMs: 0 };
    await assert.rejects(runtime.sessions.create({ agentId: "a", label: "x" }, options));
    const pending = runtime.sessions.subscribe({ key: "session:x" });
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending);
  });
}

/** A runtime held in memory that meets the contract; feature tests can use it too. */
export function fakeRuntime({ channels = {}, unreachable = false, version = null } = {}) {
  const reach = async (answer) => {
    if (unreachable)
      throw Object.assign(new Error("unreachable"), { code: "UNAVAILABLE" });
    return answer();
  };
  const listeners = new Set();
  const state = {
    availability: unreachable ? "failed" : "ready",
    sync: "stale",
    version,
    diagnostic: null,
  };
  const move = (availability) => {
    Object.assign(state, { availability });
    for (const listener of listeners) listener({ ...state });
  };
  return defineAgentRuntime({
    id: "fake",
    host: {
      ready: () => state.availability === "ready",
      status: () => ({ ...state }),
      version: () => state.version,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: async () => move("ready"),
      stop: async () => move("disabled"),
      restart: async () => {
        move("disabled");
        move("ready");
      },
    },
    channels: {
      status: () => reach(() => ({ channelAccounts: structuredClone(channels) })),
    },
    sessions: {
      create: ({ label }) => reach(() => ({ key: `session:${label}` })),
      subscribe: () => reach(() => ({})),
    },
  });
}
