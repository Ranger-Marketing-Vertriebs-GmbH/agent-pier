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
  assert.equal(routePath(tabRoot("access")), "/settings?tab=access");
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
    mergeSettingsRoute(read("/settings/mcp"), { settingsSection: "audit" }).settingsTab,
    "operations",
  );
  assert.equal(
    mergeSettingsRoute(read("/settings/mcp"), { settingsSection: "general" }).settingsTab,
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
});
