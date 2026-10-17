import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import {
  personalCapabilities,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";

const OFF = {
  memory: false,
  reminders: false,
  webSearch: false,
  webFetch: false,
  browser: false,
  documents: false,
};
test("personal capabilities are opt-in; a task member's own settings never count", () => {
  assert.deepEqual(personalCapabilities({}), OFF);
  const parent = { capabilities: { memory: true, reminders: true } };
  assert.deepEqual(personalCapabilities(parent), {
    ...OFF,
    memory: true,
    reminders: true,
  });
  assert.deepEqual(
    personalCapabilities({ ...parent, teamMemberId: "member", lifetime: "task" }),
    OFF,
  );
  assert.deepEqual(personalCapabilities({ ...parent, archivedAt: "today" }), OFF);
  // A task member runs with what the store resolved from its lead (memberInheritance).
  const inherited = { capabilities: { ...OFF, memory: true }, skills: [], shell: "off" };
  assert.deepEqual(
    personalCapabilities({ teamMemberId: "member", lifetime: "task", inherited }),
    { ...OFF, memory: true },
  );
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
  Object.assign(config.agents.entries, {
    "ap-memory": { skills: ["planted"], tools: { allow: ["read", "write", "edit"] } },
    "ap-orphan": { tools: { allow: ["read", "write", "edit"] } },
  });
  fs.writeFileSync(paths.config, JSON.stringify(config));
  prepareRuntimeConfig(paths, 1234, teams);
  config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  const entries = Object.entries(config.agents.entries);
  assert.ok(entries.every(([, a]) => !("skills" in a)));
  assert.deepEqual(config.agents.defaults.skills, []);
  for (const [id, entry] of entries.filter(([, a]) => a.tools))
    assert.ok(
      !entry.tools.allow.includes("write") && !entry.tools.allow.includes("edit"),
      id,
    );
  assert.ok(config.agents.entries["ap-memory"].tools.allow.includes("read"));
});

test("new capabilities default to off and are validated as booleans", () => {
  assert.deepEqual(
    validateDefinition({ capabilities: { memory: true, reminders: false } }, true)
      .capabilities,
    { memory: true, reminders: false },
  );
  assert.deepEqual(
    validateDefinition(
      {
        capabilities: { memory: false, reminders: false, webSearch: true, browser: true },
      },
      true,
    ).capabilities,
    { memory: false, reminders: false, webSearch: true, browser: true },
  );
  assert.throws(
    () =>
      validateDefinition(
        { capabilities: { memory: false, reminders: false, webSearch: "yes" } },
        true,
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      validateDefinition(
        { capabilities: { memory: false, reminders: false, shell: true } },
        true,
      ),
    { status: 400 },
  );
});

test("eligible agents get granted web and document tools, temporary members their lead's", () => {
  const caps = {
    memory: false,
    reminders: false,
    webSearch: true,
    webFetch: true,
    browser: true,
    documents: true,
  };
  const personal = { id: "a", capabilities: caps };
  assert.deepEqual(profileTools(personal, true, true, false).slice(-4), [
    "web_search",
    "web_fetch",
    "browser",
    "view_image",
  ]);
  const temporary = { id: "m", teamMemberId: "t", lifetime: "task", capabilities: caps };
  assert.ok(!profileTools(temporary, true, true, false).includes("web_search"));
  const following = {
    ...temporary,
    capabilities: undefined,
    inherited: { capabilities: { ...caps, browser: false }, skills: [], shell: "off" },
  };
  const memberTools = profileTools(following, true, true, false);
  assert.ok(memberTools.includes("web_search") && memberTools.includes("view_image"));
  assert.ok(!memberTools.includes("browser"));
  assert.ok(
    !profileTools(personal, true, true, false, { browser: false }).includes("browser"),
  );
  assert.ok(
    !profileTools({ ...personal, archivedAt: "x" }, true, true, false).includes(
      "web_fetch",
    ),
  );
  assert.ok(!profileTools(personal, true, false, false).includes("web_search"));
});

test("an update with only the original capability keys keeps stored new keys", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-caps-merge-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const a = store.createAssistant({
    name: "A",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false, webSearch: true },
  });
  const next = store.updateAssistant(
    a.id,
    { capabilities: { memory: true, reminders: false } },
    1,
  );
  assert.deepEqual(next.capabilities, {
    memory: true,
    reminders: false,
    webSearch: true,
  });
  assert.deepEqual(store.getAssistant(a.id).capabilities, next.capabilities);
});
