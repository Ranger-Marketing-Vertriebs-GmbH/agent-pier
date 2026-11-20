import test from "node:test";
import assert from "node:assert/strict";
import { cliDefinition, codingCliIds } from "../../server/features/clis/catalog.js";
import { profileModeName } from "../../web/features/sessions/launch-mode-copy.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

// The task profile's permission mode reads as words in the new session dialog, not as
// the CLI's raw value such as "auto" (AGENTPIER-406).
test("every pipeline permission mode has a name in both languages", (t) => {
  t.after(() => setLanguage("de"));
  for (const language of ["en", "de"]) {
    setLanguage(language);
    for (const tool of codingCliIds())
      for (const mode of cliDefinition(tool).pipeline.permissionModes) {
        const name = profileModeName(tool, mode);
        assert.equal(typeof name, "string", `${language} ${tool}:${mode}`);
        assert.notEqual(name, mode, `${language} ${tool}:${mode}`);
      }
  }
  setLanguage("en");
  assert.equal(profileModeName("claude", "auto"), "Auto · with safety checks");
  assert.equal(profileModeName("claude", "future-mode"), "future-mode");
});
