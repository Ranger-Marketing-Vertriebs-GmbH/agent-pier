import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// Hermes temporary members borrow their lead's browser grant (agent-browsers.js
// ownMemberSlot): each runs its own Chromium in its own home, held under the member
// slot limit, and its profile goes when the member ends, unless it was promoted.
const lead = {
  id: "lead",
  runtime: "hermes",
  runtimeAgentId: "ap-lead",
  revision: 1,
  capabilities: { browser: true },
};
const member = (n) => ({
  id: `m${n}`,
  runtime: "hermes",
  runtimeAgentId: `ap-m${n}`,
  revision: 1,
  teamMemberId: "t1",
  lifetime: "temporary",
  parentAssistantId: "lead",
  inherited: { capabilities: { browser: true } },
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-member-browsers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = [lead, member(1), member(2), member(3), member(4)];
  const calls = [];
  const runtimeOf = (agent) => {
    const directory = path.join(root, agent.id, "user-data");
    return {
      host: { ready: () => true },
      browser: {
        profile: () => ({ cdpPort: 45000, headless: true, directory }),
        request: async (call) => {
          calls.push({ agent: agent.id, ...call });
          if (call.path === "/start") fs.mkdirSync(directory, { recursive: true });
          return { ok: true };
        },
      },
    };
  };
  const supervisor = {
    status: () => ({ availability: "disabled" }),
    paths: { state: path.join(root, "openclaw-state") },
  };
  attachHermesFleet(supervisor, { runtimeOf });
  const store = {
    listAssistants: () => agents,
    getAssistant: (id) => {
      const found = agents.find((a) => a.id === id);
      if (!found) throw Error("missing");
      return found;
    },
  };
  const browsers = new AgentBrowsers({
    store,
    runtime: supervisor,
    keeper: () => ({ start: async () => {}, close() {} }),
  });
  return { root, agents, calls, browsers };
}

test("a Hermes temporary member runs its own browser within the member slots", async (t) => {
  const { root, agents, calls, browsers } = fixture(t);
  for (const n of [1, 2, 3])
    assert.deepEqual(await browsers.policy({ agentId: `ap-m${n}`, action: "navigate" }), {
      allow: true,
      profile: `agent-m${n}`,
    });
  // Each member's own Chromium, started through its own runtime.
  assert.deepEqual(
    calls.map((c) => [c.agent, c.path]),
    [
      ["m1", "/start"],
      ["m2", "/start"],
      ["m3", "/start"],
    ],
  );
  assert.equal(browsers.viewProfile("m1").name, "agent-m1");
  // Three headless member browsers are held: a fourth member waits for a slot.
  assert.deepEqual(await browsers.policy({ agentId: "ap-m4", action: "navigate" }), {
    allow: false,
    reason: "slotsBusy",
  });
  // m1 ends: its browser stops and its profile goes. m2 is promoted: it keeps both.
  const ended = agents.findIndex((a) => a.id === "m1");
  agents[ended] = { ...agents[ended], inherited: null, archivedAt: "x" };
  const promoted = agents.findIndex((a) => a.id === "m2");
  agents[promoted] = {
    ...agents[promoted],
    lifetime: "permanent",
    inherited: null,
    capabilities: { browser: true },
  };
  await browsers.sweep();
  assert.deepEqual(calls.at(-1), {
    agent: "m1",
    method: "POST",
    path: "/stop",
    query: { profile: "agent-m1" },
  });
  assert.equal(fs.existsSync(path.join(root, "m1", "user-data")), false);
  assert.equal(fs.existsSync(path.join(root, "m2", "user-data")), true);
  assert.equal(browsers.isRunning("m1"), false);
  assert.equal(browsers.isRunning("m2"), true);
  // Both slots are free again: the fourth member gets one.
  assert.deepEqual(await browsers.policy({ agentId: "ap-m4", action: "navigate" }), {
    allow: true,
    profile: "agent-m4",
  });
});

test("a Hermes member's home turns the browser on with its lead's grant", () => {
  const options = {
    connection: { url: "http://127.0.0.1:4100", token: "t" },
    browser: { cdpUrl: "http://127.0.0.1:41235", allowPrivateNetwork: false },
  };
  const visibleLead = { ...lead, browserVisible: true };
  const agent = desiredAgent(member(1), { lead: visibleLead });
  assert.equal(agent.browser.wanted, false);
  assert.equal(agent.browser.borrowed, true);
  // Its window follows the lead's setting, as an OpenClaw member slot's does.
  assert.equal(agent.browser.visible, true);
  const home = compileHome(agent, options);
  const config = readHermesConfig(home.files["config.yaml"]);
  assert.equal(config.agent.disabled_toolsets.includes("browser"), false);
  assert.equal(config.browser.cdp_url, "http://127.0.0.1:41235");
  assert.equal(home.unsupported.includes("browser"), false);
  assert.equal(JSON.parse(home.files["plugins/agentpier-team/tools.json"]).browser, true);
  // Without the lead's grant the member has no browser.
  const without = desiredAgent({ ...member(2), inherited: { capabilities: {} } });
  assert.equal(without.browser.borrowed, false);
  const off = readHermesConfig(compileHome(without, options).files["config.yaml"]);
  assert.ok(off.agent.disabled_toolsets.includes("browser"));
});
