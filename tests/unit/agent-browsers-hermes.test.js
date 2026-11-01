import test from "node:test";
import assert from "node:assert/strict";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";

// A Hermes agent's own Chromium under AgentBrowsers' limits (agent-browsers.js): its
// profile comes from its runtime's browser sub-port, the guard's policy launches the
// browser before Hermes attaches, and the idle stop and the owner's stop end it.
function hermesBrowsers({ ready = true, startFails = false } = {}) {
  const agent = {
    id: "h1",
    runtime: "hermes",
    runtimeAgentId: "ap-h1",
    revision: 1,
    capabilities: { browser: true },
  };
  const calls = [];
  const runtime = {
    host: { ready: () => ready },
    browser: {
      profile: () => ({ cdpPort: 45123, headless: true, directory: "/x/user-data" }),
      request: async (call) => {
        calls.push(call);
        if (startFails && call.path === "/start") throw Error("no browser");
        return { ok: true };
      },
    },
  };
  const supervisor = {
    status: () => ({ availability: "disabled" }),
    paths: { state: "/nonexistent/agentpier-state" },
  };
  attachHermesFleet(supervisor, { runtimeOf: () => runtime });
  const store = {
    listAssistants: () => [agent],
    getAssistant: (id) => {
      if (id !== agent.id) throw Error("missing");
      return agent;
    },
  };
  let clock = 0;
  const browsers = new AgentBrowsers({
    store,
    runtime: supervisor,
    now: () => clock,
    keeper: () => ({ start: async () => {}, close() {} }),
  });
  return { browsers, calls, advance: (ms) => (clock += ms) };
}

test("a Hermes agent's browser call launches its own Chromium first", async () => {
  const { browsers, calls } = hermesBrowsers();
  const profiles = browsers.profiles();
  assert.deepEqual(profiles["agent-h1"], {
    cdpPort: 45123,
    headless: true,
    directory: "/x/user-data",
    agentId: "h1",
    hermes: true,
  });
  assert.deepEqual(await browsers.policy({ agentId: "ap-h1", action: "navigate" }), {
    allow: true,
    profile: "agent-h1",
  });
  assert.deepEqual(calls, [
    { method: "POST", path: "/start", query: { profile: "agent-h1" } },
  ]);
  assert.equal(browsers.isRunning("h1"), true);
  assert.equal(browsers.profileDir("agent-h1"), "/x/user-data");
  // The OpenClaw Gateway going away leaves the Hermes agent's browser tracked.
  browsers.forget();
  assert.equal(browsers.isRunning("h1"), true);
});

test("an idle Hermes browser stops through its own runtime", async () => {
  const { browsers, calls, advance } = hermesBrowsers();
  await browsers.policy({ agentId: "ap-h1", action: "navigate" });
  advance(browsers.idleMs + 1);
  await browsers.sweep();
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/stop",
    query: { profile: "agent-h1" },
  });
  assert.equal(browsers.isRunning("h1"), false);
});

test("a Hermes browser that cannot start, or a set not ready, refuses the call", async () => {
  const failing = hermesBrowsers({ startFails: true });
  assert.deepEqual(await failing.browsers.policy({ agentId: "ap-h1", action: "open" }), {
    allow: false,
    reason: "unavailable",
  });
  assert.equal(failing.browsers.isRunning("h1"), false);
  const stopped = hermesBrowsers({ ready: false });
  assert.deepEqual(await stopped.browsers.policy({ agentId: "ap-h1" }), {
    allow: false,
    reason: "unavailable",
  });
});
