import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import {
  personalCapabilities,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";

test("personal capabilities are opt-in and never inherited by task members", () => {
  assert.deepEqual(personalCapabilities({}), { memory: false, reminders: false });
  const parent = { capabilities: { memory: true, reminders: true } };
  assert.deepEqual(personalCapabilities(parent), { memory: true, reminders: true });
  assert.deepEqual(
    personalCapabilities({ ...parent, teamMemberId: "member", lifetime: "task" }),
    { memory: false, reminders: false },
  );
  assert.deepEqual(personalCapabilities({ ...parent, archivedAt: "today" }), {
    memory: false,
    reminders: false,
  });
  const tools = profileTools(parent, false, true, true);
  assert.ok(tools.includes("memory_search") && tools.includes("write"));
  // Without a live write guard in the Gateway, memory stays read-only.
  const unguarded = profileTools(parent, false, true);
  assert.ok(unguarded.includes("memory_search") && unguarded.includes("read"));
  assert.ok(!unguarded.includes("write") && !unguarded.includes("edit"));
  assert.ok(tools.includes("agentpier_reminder"));
  assert.ok(!tools.includes("exec") && !tools.includes("automations"));
  assert.deepEqual(profileTools(parent, false, false), ["session_status"]);
});
test("capability settings validate booleans and reject arbitrary grants", () => {
  assert.deepEqual(
    validateDefinition({ capabilities: { memory: true, reminders: false } }, true),
    { capabilities: { memory: true, reminders: false } },
  );
  for (const capabilities of [
    null,
    [],
    { memory: "yes", reminders: false },
    { memory: true },
    { memory: true, reminders: false, exec: true },
  ])
    assert.throws(() => validateDefinition({ capabilities }, true), { status: 400 });
});
test("managed native runtime enables upstream capabilities without automatic recall or new credentials", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234, {
    directory: "/private/plugin",
    connection: { url: "http://127.0.0.1:1235", token: "teams" },
    hostMaxConcurrent: 8,
    native: { url: "http://127.0.0.1:1236", token: "private-native-token" },
  });
  const config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  assert.equal(config.plugins.slots.memory, "memory-core");
  assert.equal(config.plugins.entries["memory-core"].config.dreaming.enabled, false);
  assert.equal(config.memory.search.provider, "none");
  assert.equal(config.memory.search.rememberAcrossConversations, false);
  assert.equal(config.skills.workshop.autonomous.mode, "off");
  assert.equal(config.cron.enabled, true);
  assert.equal(config.cron.webhookToken, "private-native-token");
  assert.deepEqual(config.cron.webhookSsrfPolicy.allowedHostnames, ["127.0.0.1"]);
  assert.ok(config.tools.allow.includes("agentpier_reminder"));
  assert.equal(config.tools.fs.workspaceOnly, true);
});
test("a fresh Gateway grants no profile write tools before its guard reports live", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-guard-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  const profile = {
    runtimeAgentId: "ap-memory",
    capabilities: { memory: true, reminders: false },
  };
  const teams = {
    directory: "/private/plugin",
    connection: { url: "http://127.0.0.1:1235", token: "teams" },
    hostMaxConcurrent: 8,
    native: { token: "native" },
    profiles: [profile],
  };
  prepareRuntimeConfig(paths, 1234, teams);
  let config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  // A previous run's granted entries and orphaned profiles lose their writes too.
  config.agents.list.push(
    { id: "ap-memory", skills: ["planted"], tools: { allow: ["read", "write", "edit"] } },
    { id: "ap-orphan", tools: { allow: ["read", "write", "edit"] } },
  );
  fs.writeFileSync(paths.config, JSON.stringify(config));
  prepareRuntimeConfig(paths, 1234, teams);
  config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  assert.ok(config.agents.list.every((a) => !("skills" in a)));
  assert.deepEqual(config.agents.defaults.skills, []);
  for (const entry of config.agents.list.filter((a) => a.tools))
    assert.ok(
      !entry.tools.allow.includes("write") && !entry.tools.allow.includes("edit"),
      entry.id,
    );
  assert.ok(
    config.agents.list.find((a) => a.id === "ap-memory").tools.allow.includes("read"),
  );
});
