import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/assistant-settings.js";
import * as en from "../../web/lib/i18n/en/assistant-settings.js";

test("agent settings name the seven tabs and the create action in both languages", () => {
  assert.deepEqual(Object.values(de.assistantSettingsCopy.tabs), [
    "Überblick",
    "Identität",
    "Fähigkeiten",
    "Zugriffe",
    "Team",
    "Automatisierung",
    "Kanäle",
  ]);
  assert.deepEqual(Object.values(en.assistantSettingsCopy.tabs), [
    "Overview",
    "Identity",
    "Capabilities",
    "Access",
    "Team",
    "Automation",
    "Channels",
  ]);
  assert.equal(de.assistantSettingsCopy.createAgent, "Agent anlegen");
  assert.equal(en.assistantSettingsCopy.createAgent, "Create agent");
});

test("counted agent settings texts take their numbers", () => {
  assert.equal(
    de.assistantSettingsCopy.pendingApprovals(2),
    "Wartet auf deine Freigabe · 2",
  );
  assert.equal(en.assistantSettingsCopy.activityAttention(1), "1 needs your decision");
  assert.equal(en.assistantSettingsCopy.activityAttention(3), "3 need your decision");
  assert.equal(de.assistantSettingsCopy.backTo("Zugriffe"), "Zurück zu Zugriffe");
  assert.equal(
    en.assistantSettingsCopy.access.countOf("SSH/SFTP", 2, 12),
    "SSH/SFTP · 2 of 12",
  );
  assert.equal(de.assistantSettingsCopy.access.more(10), "10 weitere");
  assert.equal(
    en.assistantSettingsCopy.searchProvider("Brave Search"),
    "Search provider · Brave Search",
  );
});
