// Activity log (W8): actions read in words in both languages, and the filter offers the
// actions that occur.
import test from "node:test";
import assert from "node:assert/strict";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";
import {
  actionOptions,
  auditActionLabel,
} from "../../web/features/operations/audit-action-label.js";
import { resources, verbs } from "../../server/features/audit/audit-vocabulary.js";
import * as de from "../../web/lib/i18n/de/audit-actions.js";
import * as en from "../../web/lib/i18n/en/audit-actions.js";

test("every resource and verb of the vocabulary has a German and an English word", () => {
  for (const catalog of [de.auditActionCopy, en.auditActionCopy]) {
    assert.deepEqual(Object.keys(catalog.resources).sort(), [...resources].sort());
    assert.deepEqual(Object.keys(catalog.verbs).sort(), [...verbs].sort());
  }
});

test("an action reads in words; anything else stays as it is", (t) => {
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.equal(auditActionLabel("backup.created"), "Backup created");
  assert.equal(auditActionLabel("assistant.hook-blocked"), "Agent blocked by a hook");
  assert.equal(auditActionLabel("ssh.key.exported"), "SSH key exported");
  assert.equal(auditActionLabel("weird.thing"), "weird.thing");
  setLanguage("de");
  assert.equal(auditActionLabel("backup.created"), "Sicherung erstellt");
});

test("the filter offers All, the logged actions and a linked action not in the list", (t) => {
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.deepEqual(actionOptions(["backup.created"], ""), [
    { value: "", label: "All" },
    { value: "backup.created", label: "Backup created (backup.created)" },
  ]);
  assert.deepEqual(
    actionOptions(["backup.created"], "secret.updated").map((option) => option.value),
    ["", "secret.updated", "backup.created"],
  );
});
