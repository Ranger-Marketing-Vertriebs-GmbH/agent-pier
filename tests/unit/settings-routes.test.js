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
} from "../../web/features/assistants/settings-routes.js";
import {
  defaultExtensionTab,
  extensionTabs,
} from "../../web/features/extensions/routes.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const agent = { view: "agents", assistantId: "home", agentSettings: true };

test("settings tabs follow the section and keep tab roots addressable", () => {
  assert.equal(read("/settings").settingsTab, "workspace");
  assert.equal(read("/settings?tab=access").settingsTab, "access");
  assert.equal(read("/settings?tab=access").settingsSection, "general");
  assert.equal(routePath(read("/settings?tab=access")), "/settings?tab=access");
  assert.equal(routePath(read("/settings?tab=workspace")), "/settings");
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
  assert.deepEqual(read("/agents/home/settings?tab=work"), {
    ...agent,
    agentTab: "work",
  });
  assert.equal(
    routePath(read("/agents/home/settings?tab=work")),
    "/agents/home/settings?tab=work",
  );
  const memory = { ...agent, agentTab: "capabilities", agentPage: "memory" };
  assert.deepEqual(read("/agents/home/settings?page=memory"), memory);
  assert.deepEqual(read("/agents/home/settings?tab=work&page=memory"), memory);
  assert.equal(routePath(memory), "/agents/home/settings?tab=capabilities&page=memory");
  assert.deepEqual(read("/agents/home/settings?tab=profile"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=nope&page=nope"), agent);
  assert.deepEqual(agentSettingsLocation(agent), { tab: "profile", page: "" });
  assert.deepEqual(
    agentSettingsLocation({ ...agent, agentPage: "telegram-connection" }),
    {
      tab: "telegram",
      page: "telegram-connection",
    },
  );
});

test("a team link from the chat focuses that team in the Work tab only", () => {
  const focused = agentTeamRoute("home", "team-1");
  assert.equal(routePath(focused), "/agents/home/settings?tab=work&team=team-1");
  assert.deepEqual(read(routePath(focused)), focused);
  // Elsewhere, on a subpage or with an invalid id, the focus is dropped.
  assert.deepEqual(read("/agents/home/settings?team=team-1"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=work&page=actions&team=team-1"), {
    ...agent,
    agentTab: "work",
    agentPage: "actions",
  });
  assert.deepEqual(read("/agents/home/settings?tab=work&team=..%2Fx"), {
    ...agent,
    agentTab: "work",
  });
  assert.equal(
    routePath({ ...agent, agentTab: "profile", agentTeam: "team-1" }),
    "/agents/home/settings",
  );
});

test("accounts subpages keep section and item and old links keep working", () => {
  const item = { view: "accounts", section: "models", item: "conn-1" };
  assert.deepEqual(read("/accounts?section=models&item=conn-1"), item);
  assert.equal(routePath(item), "/accounts?section=models&item=conn-1");
  assert.deepEqual(read("/accounts?section=cli&item=new"), {
    view: "accounts",
    section: "cli",
    item: "new",
  });
  const chatgpt = `openclaw:${"a".repeat(64)}`;
  const linked = read(`/accounts?section=models&item=${encodeURIComponent(chatgpt)}`);
  assert.equal(linked.item, chatgpt);
  assert.deepEqual(read(routePath(linked)), linked);
  assert.deepEqual(read("/accounts?item=conn-1"), { view: "accounts" });
  assert.deepEqual(read("/accounts?section=cli&item=..%2Fx"), {
    view: "accounts",
    section: "cli",
  });
  const oauth = read("/accounts?section=mcp-servers&oauth=connected&server=s1");
  assert.deepEqual(oauth, {
    view: "accounts",
    section: "mcp-servers",
    mcpOAuth: { result: "connected", serverId: "s1" },
  });
  assert.equal(routePath(oauth), "/accounts?section=mcp-servers");
});

test("the extensions default tab has one definition", () => {
  assert.ok(extensionTabs.includes(defaultExtensionTab));
  assert.equal(read("/extensions/p1").extensionTab, defaultExtensionTab);
  assert.equal(read("/extensions/p1?tab=bogus").extensionTab, defaultExtensionTab);
  assert.equal(
    routePath({ view: "extensions", profileId: "p1", extensionTab: defaultExtensionTab }),
    "/extensions/p1",
  );
});

test("a settings section change carries the tab of its section", () => {
  const stale = read("/settings?tab=access");
  const moved = { ...stale, settingsSection: "diagnostics", settingsTab: "operations" };
  assert.equal(routePath(moved), "/settings/diagnostics");
  assert.equal(
    routePath({ ...stale, settingsSection: "mcp", settingsTab: settingsTabOf("mcp") }),
    "/settings/mcp",
  );
});
