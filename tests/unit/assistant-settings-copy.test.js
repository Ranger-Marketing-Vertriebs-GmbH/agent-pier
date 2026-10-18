import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/assistant-settings.js";
import * as en from "../../web/lib/i18n/en/assistant-settings.js";

test("agent settings name the five tabs and the create action in both languages", () => {
  assert.deepEqual(Object.values(de.assistantSettingsCopy.tabs), [
    "Profil",
    "Fähigkeiten",
    "Arbeit",
    "Routinen & Check-ins",
    "Telegram",
  ]);
  assert.deepEqual(Object.values(en.assistantSettingsCopy.tabs), [
    "Profile",
    "Capabilities",
    "Work",
    "Routines & check-ins",
    "Telegram",
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
  assert.equal(de.assistantSettingsCopy.backTo("Arbeit"), "Zurück zu Arbeit");
  assert.equal(
    en.assistantSettingsCopy.searchProvider("Brave Search"),
    "Search provider · Brave Search",
  );
});
