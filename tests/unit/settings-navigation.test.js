import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import {
  mergeSettingsRoute,
  settingsLocation,
  staysOn,
  subpage,
  tabRoot,
} from "../../web/features/settings/settings-navigation.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));

test("tab roots and subpages have stable addresses", () => {
  assert.equal(routePath(tabRoot("workspace")), "/settings");
  // The Access tab moved to Zugänge.
  assert.equal(routePath(tabRoot("access")), "/connections");
  assert.equal(routePath(tabRoot("operations")), "/settings?tab=operations");
  assert.equal(routePath(tabRoot("bogus")), "/settings");
  assert.equal(routePath(subpage("diagnostics")), "/settings/diagnostics");
  assert.equal(subpage("assistants").settingsTab, "workspace");
  assert.equal(subpage("github").settingsTab, "access");
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
    tab: "workspace",
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
    "access",
  );
});

test("a draft stays on screen only for its own section and tab", () => {
  const workspace = staysOn("general", "workspace");
  assert.equal(workspace({ next: tabRoot("workspace") }), true);
  assert.equal(workspace({ next: { view: "settings" } }), true);
  assert.equal(workspace({ next: tabRoot("access") }), false);
  assert.equal(workspace({ next: subpage("assistants") }), false);
  assert.equal(workspace({ next: { view: "projects" } }), false);
  assert.equal(workspace({}), false);
  const updates = staysOn("updates");
  assert.equal(updates({ next: { ...subpage("updates"), operationId: "job-1" } }), true);
  assert.equal(updates({ next: tabRoot("operations") }), false);
  // Moved sections compare their new addresses as the same settings page.
  const ssh = staysOn("ssh");
  assert.equal(ssh({ next: read("/connections?section=ssh") }), true);
  assert.equal(ssh({ next: subpage("ssh") }), true);
  assert.equal(ssh({ next: read("/connections?section=github") }), false);
  assert.equal(staysOn("assistants")({ next: read("/agents?tab=runtime") }), true);
  assert.equal(staysOn("mcp")({ next: read("/coding/clis?tab=mcp&page=2") }), true);
});
