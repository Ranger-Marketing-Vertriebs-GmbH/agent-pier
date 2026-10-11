import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/assistants.js";
import * as en from "../../web/lib/i18n/en/assistants.js";

const strings = ["stopShort", "showApprovals", "options", "optionsClose", "backToChat"];
test("agent chat redesign copy exists in both languages", () => {
  for (const copy of [de.assistantCopy, en.assistantCopy]) {
    for (const key of strings) assert.equal(typeof copy[key], "string", key);
    assert.equal(typeof copy.team.allowedChip, "string");
  }
  assert.equal(de.assistantCopy.memberCount(1), "1 Mitglied");
  assert.equal(de.assistantCopy.memberCount(3), "3 Mitglieder");
  assert.equal(en.assistantCopy.memberCount(1), "1 member");
  assert.equal(en.assistantCopy.memberCount(3), "3 members");
});
