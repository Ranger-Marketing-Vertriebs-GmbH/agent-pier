import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { projectsHubCopy } from "../../web/lib/i18n/messages/projects.js";

test("the projects hub names its tabs, add menu and counts in both languages", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(projectsHubCopy.tabKnowledge, "Wissen");
  assert.equal(projectsHubCopy.addMenu, "Projekt hinzufügen");
  assert.equal(projectsHubCopy.projectsCount(1), "1 Projekt");
  assert.equal(projectsHubCopy.projectsCount(4), "4 Projekte");
  setLanguage("en", { persist: false });
  assert.equal(projectsHubCopy.tabKnowledge, "Knowledge");
  assert.equal(projectsHubCopy.addMenu, "Add project");
  assert.equal(projectsHubCopy.projectsCount(1), "1 project");
  assert.equal(projectsHubCopy.projectsCount(0), "0 projects");
});
