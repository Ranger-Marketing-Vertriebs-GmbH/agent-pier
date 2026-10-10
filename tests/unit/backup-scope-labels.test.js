import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { assistantOmissions } from "../../server/features/operations/assistant-backup.js";
import { backupCopy as de } from "../../web/lib/i18n/de/operations.js";
import { backupCopy as en } from "../../web/lib/i18n/en/operations.js";

// The backup scope lists server identifiers; each must reach the user as a translated
// label, never as a raw key or as English text in the German UI.
test("every backup scope entry has a German and an English label", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-backup-scope-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const backup = new Backup({ dataDir });
  const keys = new Set(assistantOmissions);
  for (const withCredentials of [false, true]) {
    const plan = backup.plan({ includeHistory: true, withCredentials });
    for (const key of [...plan.components, ...plan.omissions, plan.consistency])
      keys.add(key);
  }
  const englishKeys = new Set(
    [...keys].filter((key) => /^[A-Z]/.test(key) && key.includes(" ")),
  );
  for (const key of keys) {
    assert.equal(typeof en.descriptions[key], "string", `EN label for ${key}`);
    assert.equal(typeof de.descriptions[key], "string", `DE label for ${key}`);
    if (englishKeys.has(key))
      assert.notEqual(de.descriptions[key], key, `German label for ${key}`);
  }
});
