import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  agentRoute,
  restartNote,
  unknownUsage,
  usageEntry,
  usageValue,
} from "../../web/features/accounts/account-usage-view.js";

const used = (agents = [], sessions = 0) => ({
  agents,
  sessions,
  pipelineProfiles: [],
  clis: [],
});
const home = { id: "home", name: "Home", kind: "agent", via: "model" };
const usage = {
  agentsEnabled: true,
  connections: { c1: used([home]) },
  chatgpt: {},
  mcpServers: { s1: used() },
  webSearch: used([{ ...home, via: "capability" }]),
  speech: null,
  cliAccounts: { a1: used([], 3) },
};

test("entries are unknown until usage arrived", () => {
  assert.equal(unknownUsage, "—");
  assert.equal(usageEntry(null, "connection", "c1"), undefined);
  assert.equal(usageEntry(usage, "connection", "c2"), undefined);
  assert.equal(usageEntry(usage, "speech"), undefined);
  assert.deepEqual(usageEntry(usage, "connection", "c1"), usage.connections.c1);
  assert.deepEqual(usageEntry(usage, "web-search"), usage.webSearch);
  assert.deepEqual(usageEntry(usage, "cli-account", "a1"), usage.cliAccounts.a1);
  assert.equal(usageEntry(usage, "connection-new", "new"), undefined);
  // ChatGPT accounts no agent references are absent from the map: known unused.
  assert.deepEqual(usageEntry(usage, "chatgpt", "openclaw:x"), used());
  assert.equal(usageEntry(null, "chatgpt", "openclaw:x"), undefined);
});

test("row values never show a made-up zero", () => {
  setLanguage("en");
  assert.equal(usageValue(undefined), "—");
  assert.equal(usageValue(usage.connections.c1), "1 agent");
  assert.equal(usageValue(used([home, { ...home, id: "b" }])), "2 agents");
  assert.equal(usageValue(usage.cliAccounts.a1), "Sessions");
  assert.equal(usageValue(usage.mcpServers.s1), "");
  assert.equal(restartNote(usage.connections.c1), "Briefly restarts 1 agent.");
  assert.equal(restartNote(usage.mcpServers.s1), "");
  assert.equal(restartNote(undefined), "");
  setLanguage("de");
});

test("agents open the settings tab that uses the entry", () => {
  const base = { view: "agents", assistantId: "home", agentSettings: true };
  assert.deepEqual(agentRoute(home), base);
  assert.deepEqual(agentRoute({ ...home, via: "capability" }), {
    ...base,
    agentTab: "capabilities",
  });
  assert.deepEqual(agentRoute({ ...home, via: "binding" }), {
    ...base,
    agentTab: "capabilities",
  });
  assert.deepEqual(agentRoute({ ...home, via: "pipelines" }), {
    ...base,
    agentTab: "work",
  });
  assert.deepEqual(agentRoute({ ...home, via: "channel" }), {
    ...base,
    agentTab: "telegram",
  });
});
