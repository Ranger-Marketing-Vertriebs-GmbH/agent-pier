import test from "node:test";
import assert from "node:assert/strict";
import { shellService } from "../helpers/assistant-shell-service.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";

// The owner's agent: memory and reminders on, a ChatGPT account model, no Telegram chat.
const chatgpt = { connectionId: "openclaw:5a3bed0e", modelId: "gpt-6-astra" };
const web = { webSearch: true, webFetch: true, browser: true, documents: true };
const webTools = ["web_search", "web_fetch", "browser", "view_image"];
const heartbeat = {
  enabled: true,
  interval: "2h",
  start: 8,
  end: 18,
  timeZone: "Europe/Berlin",
};
const revision = (f, id) => f.store.getAssistant(id).revision;

/** Check-ins as NativeHeartbeats converges them; they need no Telegram chat. */
function withChats(f) {
  const synced = [];
  f.service.reminders = {
    disable: async () => {},
    close: async () => {},
    heartbeats: { sync: async (id) => synced.push(id) },
  };
  return synced;
}

// The Gateway double already runs the agent; the store gives it the owner's profile.
function ownerAgent(f) {
  const [agent] = f.agents;
  return f.store.updateAssistant(
    agent.id,
    { model: chatgpt, capabilities: { memory: true, reminders: true } },
    agent.revision,
  );
}

test("ticked web tools survive a reload and reach the compiled agent tools", async (t) => {
  const f = shellService(t, ["News Agent"]);
  withChats(f);
  const agent = ownerAgent(f);
  const capabilities = { memory: true, reminders: true, ...web };
  await f.service.update(agent.id, { capabilities }, revision(f, agent.id));
  // A reload reads the stored profile: every choice is still there.
  const reloaded = f.service.list().assistants.find((a) => a.id === agent.id);
  assert.deepEqual(reloaded.capabilities, capabilities);
  // The live entry of the running Gateway grants them; the browser waits for the
  // proven tool guard, which this fixture never reports.
  for (const tool of webTools)
    assert.equal(
      f.live(agent).tools.allow.includes(tool),
      tool !== "browser",
      `${tool} applied live`,
    );
  // A Gateway start compiles the global sections the tools need (OpenClaw 2026.9.8).
  const compiled = compileOpenClawConfig({
    existing: {
      agents: { defaults: {}, entries: { [agent.runtimeAgentId]: {} } },
    },
    paths: { workspaces: "/w", logs: "/l" },
    port: 1234,
    token: "t",
    teams: {
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles: f.store.listAssistants(),
    },
    webTools: {
      search: { provider: "duckduckgo" },
      browser: { available: true, executablePath: "/usr/bin/chromium" },
      searchPlugins: { duckduckgo: { id: "duckduckgo", directory: "/rt/ddg" } },
    },
  });
  for (const tool of webTools) {
    assert.ok(compiled.tools.allow.includes(tool), `${tool} allowed globally`);
    // A start withholds the browser until the tool guard reports.
    assert.equal(
      compiled.agents.entries[agent.runtimeAgentId].tools.allow.includes(tool),
      tool !== "browser",
      `${tool} allowed for the agent`,
    );
  }
  assert.deepEqual(compiled.tools.web.search, { provider: "duckduckgo" });
  assert.equal(compiled.browser.enabled, true);
  assert.ok(compiled.plugins.allow.includes("duckduckgo"));
  assert.ok(compiled.plugins.allow.includes("browser"));
});

test("check-ins without a Telegram chat save together with the other choices", async (t) => {
  const f = shellService(t, ["News Agent"]);
  const synced = withChats(f);
  const agent = ownerAgent(f);
  const capabilities = { memory: true, reminders: true, ...web };
  await f.service.update(agent.id, { capabilities, heartbeat }, revision(f, agent.id));
  const saved = f.store.getAssistant(agent.id);
  assert.deepEqual(saved.capabilities, capabilities);
  assert.deepEqual(saved.heartbeat, heartbeat);
  assert.equal("heartbeatChannel" in f.service.list().assistants[0], false);
  assert.deepEqual(synced, [agent.id]);
});
