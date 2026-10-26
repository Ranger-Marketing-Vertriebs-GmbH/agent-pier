import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import {
  settingsSectionGroups,
  settingsTabOf,
  settingsTabs,
} from "../../web/features/operations/routes.js";
import {
  agentSettingsLocation,
  agentTeamRoute,
  readAgentSettingsQuery,
} from "../../web/features/assistants/settings-routes.js";
import { agentRoute } from "../../web/features/assistants/settings/agent-settings-fields.js";
import {
  defaultExtensionTab,
  extensionTabs,
} from "../../web/features/extensions/routes.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const agent = { view: "agents", assistantId: "home", agentSettings: true };

test("settings tabs follow the section and keep tab roots addressable", () => {
  assert.equal(read("/settings").settingsTab, "workspace");
  // The Access tab moved to Zugänge; its sections live there and in Coding.
  assert.deepEqual(read("/settings?tab=access"), { view: "connections" });
  assert.equal(routePath(read("/settings?tab=workspace")), "/settings");
  assert.equal(read("/settings?tab=operations").settingsTab, "operations");
  assert.equal(read("/settings?tab=bogus").settingsTab, "workspace");
  assert.equal(read("/settings/diagnostics").settingsTab, "operations");
  const contradicted = read("/settings/diagnostics?tab=access");
  assert.equal(contradicted.settingsTab, "operations");
  assert.equal(routePath(contradicted), "/settings/diagnostics");
  for (const tab of settingsTabs)
    for (const section of settingsSectionGroups[tab])
      assert.equal(settingsTabOf(section), tab, section);
});

test("agent settings tabs and subpages have their own addresses", () => {
  assert.deepEqual(read("/agents/home/settings"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=access"), {
    ...agent,
    agentTab: "access",
  });
  assert.equal(
    routePath(read("/agents/home/settings?tab=access")),
    "/agents/home/settings?tab=access",
  );
  const memory = { ...agent, agentTab: "capabilities", agentPage: "memory" };
  assert.deepEqual(read("/agents/home/settings?page=memory"), memory);
  assert.deepEqual(read("/agents/home/settings?tab=work&page=memory"), memory);
  assert.equal(routePath(memory), "/agents/home/settings?tab=capabilities&page=memory");
  assert.deepEqual(read("/agents/home/settings?tab=identity"), {
    ...agent,
    agentTab: "identity",
  });
  assert.deepEqual(read("/agents/home/settings?tab=nope&page=nope"), agent);
  // Overview is the first tab and the default; a link that names it keeps it.
  assert.deepEqual(agentSettingsLocation(agent), { tab: "overview", page: "" });
  assert.equal(
    routePath(read("/agents/home/settings?tab=overview")),
    "/agents/home/settings?tab=overview",
  );
  assert.deepEqual(read("/agents/home/settings?page=actions"), {
    ...agent,
    agentTab: "overview",
    agentPage: "actions",
  });
  assert.deepEqual(
    agentSettingsLocation({ ...agent, agentPage: "telegram-connection" }),
    {
      tab: "channels",
      page: "telegram-connection",
    },
  );
});

test("every old agent settings address of handoff 4.2 opens its new tab (AC-AS-1)", () => {
  const id = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
  for (const [old, now] of [
    ["?tab=profile", "?tab=identity"],
    ["?tab=capabilities&page=memory", "?tab=capabilities&page=memory"],
    ["?tab=capabilities&page=allowlist", "?tab=capabilities&page=allowlist"],
    ["?tab=capabilities&page=skills", "?tab=capabilities&page=skills"],
    ["?tab=work&page=projects", "?tab=access&page=projects"],
    ["?tab=work&page=pipelines", "?tab=access&page=pipelines"],
    ["?tab=work&page=ssh", "?tab=access&page=ssh"],
    ["?tab=work&page=github", "?tab=access&page=github"],
    ["?tab=work&page=secrets", "?tab=access&page=secrets"],
    ["?tab=work&team=team-1", "?tab=team&team=team-1"],
    ["?tab=work&page=actions", "?tab=overview&page=actions"],
    ["?tab=work", "?tab=overview"],
    ["?tab=routines", "?tab=automation"],
    [`?tab=routines&page=hook&hook=${id}`, `?tab=automation&page=hook&hook=${id}`],
    ["?tab=telegram", "?tab=channels"],
    ["?tab=telegram&page=telegram-activity", "?tab=channels&page=telegram-activity"],
    ["?tab=telegram&page=telegram-connection", "?tab=channels&page=telegram-connection"],
  ]) {
    const route = read(`/agents/home/settings${old}`);
    assert.equal(routePath(route), `/agents/home/settings${now}`, old);
    assert.equal(agentSettingsLocation(route).tab, new URLSearchParams(now).get("tab"));
  }
});

test("a team link from the chat focuses that team in the Team tab only", () => {
  const focused = agentTeamRoute("home", "team-1");
  assert.equal(routePath(focused), "/agents/home/settings?tab=team&team=team-1");
  assert.deepEqual(read(routePath(focused)), focused);
  assert.equal(agentSettingsLocation(focused).tab, "team");
  // Elsewhere, on a subpage or with an invalid id, the focus is dropped.
  assert.deepEqual(read("/agents/home/settings?team=team-1"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=team&page=actions&team=team-1"), {
    ...agent,
    agentTab: "overview",
    agentPage: "actions",
  });
  assert.deepEqual(read("/agents/home/settings?tab=team&team=..%2Fx"), {
    ...agent,
    agentTab: "team",
  });
  assert.equal(
    routePath({ ...agent, agentTab: "profile", agentTeam: "team-1" }),
    "/agents/home/settings?tab=identity",
  );
});

test("a hook's detail is an automation subpage that keeps a valid hook id", () => {
  const id = "0f8b6a52-3c1d-4e2f-9a7b-5d6c8e9f0a1b";
  assert.deepEqual(agentSettingsLocation({ agentPage: "hook" }), {
    tab: "automation",
    page: "hook",
  });
  const hook = { ...agent, agentTab: "automation", agentPage: "hook", agentHook: id };
  assert.deepEqual(readAgentSettingsQuery(`?page=hook&hook=${id}`), {
    agentTab: "automation",
    agentPage: "hook",
    agentHook: id,
  });
  // An old link to the routines tab opens the automation tab.
  const built = agentRoute("home", "routines", "hook", id);
  assert.equal(
    routePath(built),
    `/agents/home/settings?tab=automation&page=hook&hook=${id}`,
  );
  assert.deepEqual(read(routePath(built)), hook);
  // A malformed id, or one outside the hook page, is dropped.
  assert.deepEqual(readAgentSettingsQuery("?page=hook&hook=..%2Fx"), {
    agentTab: "automation",
    agentPage: "hook",
  });
  assert.deepEqual(readAgentSettingsQuery(`?tab=automation&hook=${id}`), {
    agentTab: "automation",
  });
  assert.equal(
    routePath({ ...agent, agentTab: "routines", agentHook: id }),
    "/agents/home/settings?tab=automation",
  );
});

test("connection subpages keep section and item and old Accounts links keep working", () => {
  const item = { view: "connections", section: "models", item: "conn-1" };
  assert.deepEqual(read("/connections?section=models&item=conn-1"), item);
  assert.deepEqual(read("/accounts?section=models&item=conn-1"), item);
  assert.equal(routePath(item), "/connections?section=models&item=conn-1");
  assert.deepEqual(read("/accounts?section=cli&item=new"), {
    view: "coding",
    codingTab: "accounts",
    item: "new",
  });
  const chatgpt = `openclaw:${"a".repeat(64)}`;
  const linked = read(`/connections?section=models&item=${encodeURIComponent(chatgpt)}`);
  assert.equal(linked.item, chatgpt);
  assert.deepEqual(read(routePath(linked)), linked);
  assert.deepEqual(read("/connections?item=conn-1"), { view: "connections" });
  assert.deepEqual(read("/accounts?section=cli&item=..%2Fx"), {
    view: "coding",
    codingTab: "accounts",
  });
  const oauth = read("/accounts?section=mcp-servers&oauth=connected&server=s1");
  assert.deepEqual(oauth, {
    view: "connections",
    section: "mcp-servers",
    mcpOAuth: { result: "connected", serverId: "s1" },
  });
  assert.equal(routePath(oauth), "/connections?section=mcp-servers");
});

test("the extensions default tab has one definition", () => {
  assert.ok(extensionTabs.includes(defaultExtensionTab));
  assert.equal(read("/coding/clis/extensions/p1").extensionTab, defaultExtensionTab);
  assert.equal(read("/extensions/p1?tab=bogus").extensionTab, defaultExtensionTab);
  assert.equal(
    routePath({ view: "extensions", profileId: "p1", extensionTab: defaultExtensionTab }),
    "/coding/clis/extensions/p1",
  );
});

test("a settings section change carries the tab of its section", () => {
  const stale = read("/settings?tab=operations");
  const moved = { ...stale, settingsSection: "diagnostics", settingsTab: "operations" };
  assert.equal(routePath(moved), "/settings/diagnostics");
  assert.equal(
    routePath({ ...stale, settingsSection: "mcp", settingsTab: settingsTabOf("mcp") }),
    "/coding/clis?tab=mcp",
  );
});

test("the users page and one user's detail have their own addresses", () => {
  const list = read("/settings/users");
  assert.equal(list.settingsSection, "users");
  assert.equal(list.settingsTab, "access");
  assert.equal(list.userId, undefined);
  const detail = read("/settings/users?user=u-1");
  assert.equal(detail.userId, "u-1");
  assert.equal(routePath(detail), "/settings/users?user=u-1");
  assert.equal(read("/settings/users?user=..%2Fx").userId, undefined);
});
