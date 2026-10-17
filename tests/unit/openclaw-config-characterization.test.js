import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return runtimePaths(dir);
}
const teams = (extra = {}) => ({
  directory: "/private/plugin",
  connection: { url: "http://127.0.0.1:1235", token: "bridge" },
  hostMaxConcurrent: 4,
  ...extra,
});
const profile = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, reminders: true },
};

test("without teams the Gateway gets only session_status and no plugins", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  // Deliberately changed with agent shell access: the global exec floor is "deny",
  // since OpenClaw's gateway host otherwise defaults exec to "full". Session tools
  // are limited to the calling agent's own sessions (default "all").
  assert.deepEqual(config.tools, {
    allow: ["session_status"],
    toolSearch: false,
    exec: { mode: "deny" },
    sessions: { visibility: "agent" },
  });
  assert.deepEqual(config.plugins, { slots: { memory: "none" } });
  assert.equal(config.cron.enabled, false);
  assert.deepEqual(config.agents.defaults.skills, []);
  assert.equal(config.agents.defaults.maxConcurrent, 8);
  assert.equal(config.gateway.bind, "loopback");
  assert.equal(config.gateway.controlUi.enabled, false);
  assert.deepEqual(config.channels, {});
  assert.equal(config.browser.enabled, false);
});

test("native teams grant profile tools without guarded writes on a fresh start", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const seeded = readJSON(paths.config);
  seeded.agents.entries = { "ap-a1": { id: "ap-a1", tools: { allow: ["write"] } } };
  fs.writeFileSync(paths.config, JSON.stringify(seeded));
  prepareRuntimeConfig(
    paths,
    1234,
    teams({ native: { token: "hook" }, profiles: [profile] }),
  );
  const config = readJSON(paths.config);
  assert.deepEqual(config.agents.entries["ap-a1"].tools.allow, [
    "session_status",
    "agentpier_team_propose",
    "agentpier_team_status",
    "agentpier_team_stop",
    "agentpier_team_members",
    "agentpier_team_ask",
    "agentpier_team_delegate",
    "agentpier_team_cancel",
    "agentpier_team_archive",
    "agentpier_team_grant",
    "agentpier_team_member_update",
    "memory_search",
    "memory_get",
    "read",
    "agentpier_reminder",
    "agentpier_routine",
    "agentpier_workspace",
  ]);
  assert.equal(config.agents.entries["ap-a1"].memory.search.enabled, true);
  assert.equal(config.cron.enabled, true);
  assert.equal(config.agents.defaults.maxConcurrent, 12);
});

test("maintenance keeps native cron off", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234, teams({ native: { token: "hook" }, profiles: [] }), {
    maintenance: true,
  });
  assert.equal(readJSON(paths.config).cron.enabled, false);
});

test("models and unknown keys of an existing file survive a start", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234);
  const seeded = readJSON(paths.config);
  seeded.models = { providers: { p: { baseUrl: "http://127.0.0.1:9" } } };
  seeded.custom = { kept: true };
  fs.writeFileSync(paths.config, JSON.stringify(seeded));
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  assert.deepEqual(config.models, seeded.models);
  assert.deepEqual(config.custom, { kept: true });
});

test("native teams wire the plugin, memory, tools, cron and skills", (t) => {
  const paths = fixture(t);
  prepareRuntimeConfig(paths, 1234, teams({ native: { token: "hook" }, profiles: [] }));
  const config = readJSON(paths.config);
  assert.deepEqual(config.plugins.allow, ["agentpier-teams", "openai", "memory-core"]);
  assert.deepEqual(config.plugins.load, { paths: ["/private/plugin"] });
  assert.deepEqual(config.plugins.entries["agentpier-teams"], {
    enabled: true,
    config: {
      url: "http://127.0.0.1:1235",
      token: "bridge",
      workspaces: paths.workspaces,
    },
  });
  assert.equal(config.plugins.slots.memory, "memory-core");
  assert.deepEqual(config.plugins.entries["memory-core"], {
    enabled: true,
    config: { dreaming: { enabled: false } },
  });
  assert.deepEqual(config.memory.search, {
    enabled: false,
    provider: "none",
    sources: ["memory"],
    rememberAcrossConversations: false,
  });
  assert.deepEqual(config.tools.allow, [
    "session_status",
    "agentpier_team_propose",
    "agentpier_team_status",
    "agentpier_team_stop",
    "agentpier_team_members",
    "agentpier_team_ask",
    "agentpier_team_delegate",
    "agentpier_team_cancel",
    "agentpier_team_archive",
    "agentpier_team_grant",
    "agentpier_team_member_update",
    "memory_search",
    "memory_get",
    "read",
    "write",
    "edit",
    "agentpier_reminder",
    "agentpier_routine",
    "agentpier_workspace",
    "agentpier_ssh",
  ]);
  assert.equal(config.tools.fs.workspaceOnly, true);
  assert.deepEqual(config.cron, {
    enabled: true,
    webhookToken: "hook",
    webhookSsrfPolicy: { allowedHostnames: ["127.0.0.1"] },
  });
  assert.deepEqual(config.skills.workshop.autonomous, { mode: "off" });
});
