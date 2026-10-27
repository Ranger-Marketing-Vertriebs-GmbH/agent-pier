import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import {
  delegationTools,
  lockedTools,
  memberTeamTools,
  personalCapabilities,
  profileTools,
  routineTools,
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
  readPdfs: false,
  createImages: false,
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
  assert.deepEqual(profileTools(personal, true, true, true).slice(-4), [
    "web_search",
    "web_fetch",
    "browser",
    "view_image",
  ]);
  // The browser waits for the proven tool guard.
  assert.ok(!profileTools(personal, true, true, false).includes("browser"));
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
    !profileTools(personal, true, true, true, { browser: false }).includes("browser"),
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

test("members hold the member tools, leads and user agents never", () => {
  assert.deepEqual(memberTeamTools, [
    "agentpier_team_peers",
    "agentpier_team_peer_ask",
    "agentpier_team_peer_delegate",
    "agentpier_team_report",
  ]);
  const has = (agent, teamsReady = true) => {
    const tools = profileTools(agent, teamsReady, true, true);
    const held = memberTeamTools.filter((tool) => tools.includes(tool));
    assert.ok(held.length === 0 || held.length === memberTeamTools.length, held);
    return held.length > 0;
  };
  const temporary = { id: "m", teamMemberId: "t", lifetime: "task" };
  const permanent = { id: "p", teamMemberId: "t", lifetime: "permanent" };
  assert.equal(has(temporary), true);
  assert.equal(has(permanent), true);
  // Each tool exactly once, and never a lead's own team tool beside them.
  const tools = profileTools(permanent, true, true, true);
  for (const tool of memberTeamTools)
    assert.equal(tools.filter((t) => t === tool).length, 1, tool);
  assert.ok(!tools.some((tool) => delegationTools.includes(tool)));
  // Not without the team bridge, not once archived, never a lead or a personal agent.
  assert.equal(has(permanent, false), false);
  assert.equal(has({ ...permanent, archivedAt: "today" }), false);
  const lead = { id: "l", capabilities: { memory: true, reminders: true } };
  assert.equal(has(lead), false);
  assert.ok(profileTools(lead, true, true, true).includes("agentpier_team_ask"));
  // A user agent never holds them, whatever it is.
  assert.equal(has({ ...permanent, userAccess: { mode: "own" } }), false);
  for (const tool of memberTeamTools) {
    assert.ok(lockedTools.includes(tool), tool);
    // A member's routine run reaches them; a lead's allow list never holds them.
    assert.ok(routineTools.includes(tool), tool);
  }
});

test("agentpier_coding_session: own agents and permanent members, routines, never user agents", () => {
  const tool = "agentpier_coding_session";
  const own = { id: "a", capabilities: { memory: true, reminders: true } };
  assert.ok(profileTools(own, true, true).includes(tool));
  assert.ok(
    profileTools(
      { id: "p", teamMemberId: "t", lifetime: "permanent" },
      true,
      true,
    ).includes(tool),
  );
  assert.ok(
    !profileTools({ id: "m", teamMemberId: "t", lifetime: "task" }, true, true).includes(
      tool,
    ),
  );
  assert.ok(!profileTools(own, true, false).includes(tool));
  assert.ok(!profileTools({ ...own, archivedAt: "today" }, true, true).includes(tool));
  assert.ok(
    !profileTools({ ...own, userAccess: { mode: "own" } }, true, true).includes(tool),
  );
  assert.ok(lockedTools.includes(tool));
  assert.ok(routineTools.includes(tool));
});
