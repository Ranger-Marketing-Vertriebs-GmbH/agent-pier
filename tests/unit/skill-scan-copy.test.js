import { test } from "node:test";
import assert from "node:assert/strict";
import { skillScanCopy as en } from "../../web/lib/i18n/en/skill-scan.js";
import { skillScanCopy as de } from "../../web/lib/i18n/de/skill-scan.js";

test("the skill scan names one file in the singular", () => {
  assert.equal(en.filesSummary(1, 2), "1 file · 2 KiB");
  assert.equal(en.filesSummary(3, 2), "3 files · 2 KiB");
  assert.equal(de.filesSummary(1, 2), "1 Datei · 2 KiB");
  assert.equal(de.filesSummary(3, 2), "3 Dateien · 2 KiB");
});
