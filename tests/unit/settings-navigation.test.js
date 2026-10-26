import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import {
  isTabSection,
  mergeSettingsRoute,
  settingsLocation,
  staysOn,
  subpage,
  tabRoot,
} from "../../web/features/settings/settings-navigation.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));

test("tab roots and subpages have stable addresses", () => {
  assert.equal(routePath(tabRoot("general")), "/settings");
  // The former Arbeitsbereich tab is Allgemein; the Access tab moved to Zugänge and
  // has no settings tab any more.
  assert.equal(routePath(tabRoot("workspace")), "/settings");
  assert.equal(routePath(tabRoot("access")), "/settings");
  assert.equal(routePath(tabRoot("operations")), "/settings?tab=operations");
  assert.equal(routePath(tabRoot("bogus")), "/settings");
  // App, Benutzer and Fernzugriff are one section each, at its own address.
  assert.equal(routePath(tabRoot("app")), "/settings/notifications");
  assert.equal(routePath(tabRoot("users")), "/settings/users");
  assert.equal(routePath(tabRoot("remote")), "/settings/remote");
  assert.equal(routePath(subpage("diagnostics")), "/settings/diagnostics");
  assert.equal(subpage("assistants").settingsTab, "general");
  assert.equal(subpage("github").settingsTab, "general");
  assert.equal(subpage("notifications").settingsTab, "app");
  assert.equal(subpage("users").settingsTab, "users");
  assert.equal(subpage("remote").settingsTab, "remote");
  assert.equal(isTabSection("users"), true);
  assert.equal(isTabSection("updates"), false);
  assert.deepEqual(settingsLocation(read("/settings?tab=operations")), {
    section: "general",
    tab: "operations",
  });
  assert.deepEqual(settingsLocation(read("/settings/updates")), {
    section: "updates",
    tab: "operations",
  });
  assert.deepEqual(settingsLocation({ view: "settings" }), {
    section: "general",
    tab: "general",
  });
  assert.deepEqual(settingsLocation(read("/settings?tab=users")), {
    section: "users",
    tab: "users",
  });
});

test("subpage navigation keeps the tab of the resulting section", () => {
  const updates = { ...read("/settings/updates"), operationId: "job-1" };
  assert.deepEqual(mergeSettingsRoute(updates, { operationId: "job-2" }), {
    ...updates,
    operationId: "job-2",
  });
  assert.equal(
    mergeSettingsRoute(subpage("mcp"), { settingsSection: "audit" }).settingsTab,
    "operations",
  );
  assert.equal(
    mergeSettingsRoute(subpage("mcp"), { settingsSection: "general" }).settingsTab,
    "general",
  );
});

test("a draft stays on screen only for its own section and tab", () => {
  const workspace = staysOn("general", "general");
  assert.equal(workspace({ next: tabRoot("general") }), true);
  assert.equal(workspace({ next: { view: "settings" } }), true);
  assert.equal(workspace({ next: tabRoot("operations") }), false);
  assert.equal(workspace({ next: tabRoot("users") }), false);
  assert.equal(workspace({ next: read("/settings?tab=access") }), false);
  assert.equal(workspace({ next: subpage("assistants") }), false);
  assert.equal(workspace({ next: { view: "projects" } }), false);
  assert.equal(workspace({}), false);
  const updates = staysOn("updates");
  assert.equal(updates({ next: { ...subpage("updates"), operationId: "job-1" } }), true);
  assert.equal(updates({ next: tabRoot("operations") }), false);
  // Moved sections compare their new addresses as the same settings page; SSH,
  // secrets and GitHub are Zugänge's own page, MCP access Coding's, and no settings
  // page any more.
  const ssh = staysOn("ssh");
  assert.equal(ssh({ next: read("/connections?section=ssh") }), false);
  assert.equal(ssh({ next: subpage("ssh") }), false);
  // Agenten › Laufzeit is the hub's own page with its own draft.
  assert.equal(staysOn("assistants")({ next: read("/agents?tab=runtime") }), false);
  assert.equal(staysOn("mcp")({ next: read("/coding/clis?tab=mcp&page=2") }), false);
});
