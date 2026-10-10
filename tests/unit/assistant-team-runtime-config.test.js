import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";
test("team configuration advertises only managed delegation and removes retired bridge credentials", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234, {
    directory: "/private/plugin",
    connection: { url: "http://127.0.0.1:1235", token: "private-bridge" },
    hostMaxConcurrent: 8,
  });
  let config = readJSON(paths.config);
  assert.deepEqual(config.tools.allow, [
    "session_status",
    "agentpier_team_propose",
    "agentpier_team_status",
    "agentpier_team_stop",
  ]);
  assert.equal(config.agents.defaults.maxConcurrent, 16);
  assert.equal(config.plugins.entries["agentpier-teams"].config.token, "private-bridge");
  // The write guard classifies absolute targets against the workspaces root.
  assert.equal(
    config.plugins.entries["agentpier-teams"].config.workspaces,
    paths.workspaces,
  );
  // Workspace skill folders never load: they would be model-writable instructions.
  assert.deepEqual(config.agents.defaults.skills, []);
  prepareRuntimeConfig(paths, 1234);
  config = readJSON(paths.config);
  assert.deepEqual(config.agents.defaults.skills, []);
  assert.deepEqual(config.tools.allow, ["session_status"]);
  assert.ok(!JSON.stringify(config).includes("private-bridge"));
});

test("native cron remains disabled throughout candidate maintenance startup", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-maintenance-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  const teams = {
    directory: "/private/plugin",
    connection: { url: "http://127.0.0.1:1235", token: "bridge" },
    hostMaxConcurrent: 8,
    native: { token: "webhook" },
  };
  prepareRuntimeConfig(paths, 1234, teams);
  assert.equal(readJSON(paths.config).cron.enabled, true);
  prepareRuntimeConfig(paths, 1234, teams, { maintenance: true });
  assert.equal(readJSON(paths.config).cron.enabled, false);
  assert.equal(readJSON(paths.config).cron.webhookToken, "webhook");
  prepareRuntimeConfig(paths, 1234, teams);
  assert.equal(readJSON(paths.config).cron.enabled, true);
});

test("an existing configuration cannot choose the default workspace path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  fs.writeFileSync(
    paths.config,
    JSON.stringify({ agents: { defaults: { workspace: "/elsewhere", skills: [] } } }),
  );
  prepareRuntimeConfig(paths, 1234);
  assert.equal(readJSON(paths.config).agents.defaults.workspace, paths.workspaces);
});
