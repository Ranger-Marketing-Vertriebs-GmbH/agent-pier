import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { commonCopy } from "../../web/lib/i18n/messages/common.js";

test("shared settings copy counts and names the tab in both languages", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(commonCopy.agentsCount(1), "1 Agent");
  assert.equal(commonCopy.agentsCount(3), "3 Agenten");
  assert.equal(commonCopy.ofCount(2, 5), "2 von 5");
  assert.equal(
    commonCopy.unsavedBody("Profil", 1),
    "Im Tab Profil ist 1 Änderung noch nicht gespeichert.",
  );
  assert.equal(
    commonCopy.unsavedBody("Profil", 3),
    "Im Tab Profil sind 3 Änderungen noch nicht gespeichert.",
  );
  assert.equal(commonCopy.partiallySaved("Profil"), "Teilweise gespeichert: Profil.");
  setLanguage("en", { persist: false });
  assert.equal(commonCopy.agentsCount(1), "1 agent");
  assert.equal(commonCopy.agentsCount(2), "2 agents");
  assert.equal(
    commonCopy.unsavedBody("Profile", 1),
    "1 change in Profile is not saved yet.",
  );
  assert.equal(
    commonCopy.unsavedBody("Profile", 2),
    "2 changes in Profile are not saved yet.",
  );
  assert.equal(commonCopy.language, "Language");
});

test("the language selector takes its label from the catalog", () => {
  const source = fs.readFileSync(
    new URL("../../web/components/LanguageSelect.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /"Sprache"|"Language"/);
  assert.match(source, /commonCopy\.language/);
});
