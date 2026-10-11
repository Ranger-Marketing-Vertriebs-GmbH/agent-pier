import test from "node:test";
import assert from "node:assert/strict";
import * as deApp from "../../web/lib/i18n/de/app.js";
import * as enApp from "../../web/lib/i18n/en/app.js";
import * as deAgents from "../../web/lib/i18n/de/assistants.js";
import * as enAgents from "../../web/lib/i18n/en/assistants.js";

test("sidebar menu copy exists in both languages", () => {
  assert.equal(deApp.sidebarCopy.menu, "Menü");
  assert.equal(enApp.sidebarCopy.menu, "Menu");
  assert.equal(deApp.sidebarCopy.closeMenu, "Menü schließen");
  assert.equal(enApp.sidebarCopy.closeMenu, "Close menu");
  assert.equal(deAgents.assistantCopy.agentsGroup, "Agenten");
  assert.equal(enAgents.assistantCopy.agentsGroup, "Agents");
  assert.equal(deApp.sidebarCopy.sidebarCaption, undefined);
  assert.equal(enApp.sidebarCopy.sidebarCaption, undefined);
});
