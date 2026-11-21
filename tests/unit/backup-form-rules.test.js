// Backups and restore (W8 B6, B7): no empty report rows, unmapped projects stay
// historical, and passphrase problems are explained in the dialog.
import test from "node:test";
import assert from "node:assert/strict";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";
import {
  filledProjectMap,
  passphraseProblem,
  restoreGap,
} from "../../web/features/operations/backup-form-rules.js";
import { reportRows } from "../../web/features/operations/restore-report.js";

const inspection = (requiresPassphrase = false) => ({
  requiresPassphrase,
  projects: [
    { id: "a", name: "Alpha", cwd: "/old/a" },
    { id: "b", name: "Beta", cwd: "/old/b" },
  ],
});

test("a restore report leaves out an empty sign-in list and missing values", () => {
  assert.deepEqual(
    reportRows({
      credentialsRestored: true,
      credentialsNeedingLogin: [],
      importedSessions: 3,
      importedRuns: null,
    }),
    [
      ["credentialsRestored", true],
      ["importedSessions", 3],
    ],
  );
  assert.deepEqual(reportRows({ credentialsNeedingLogin: ["user:Anna"] }), [
    ["credentialsNeedingLogin", ["user:Anna"]],
  ]);
  assert.deepEqual(reportRows(undefined), []);
});

test("a restore needs a target and a passphrase, but no folder for every project", () => {
  assert.equal(
    restoreGap({ inspection: inspection(), targetDataDir: " ", passphrase: "" }).field,
    "target",
  );
  assert.equal(
    restoreGap({ inspection: inspection(), targetDataDir: "/new", passphrase: "" }),
    null,
  );
  assert.equal(
    restoreGap({ inspection: inspection(true), targetDataDir: "/new", passphrase: "" })
      .field,
    "passphrase",
  );
  // Only projects given a folder are mapped; the others stay historical.
  assert.deepEqual(filledProjectMap({ a: " /new/a ", b: "  " }), { a: "/new/a" });
  assert.deepEqual(filledProjectMap({}), {});
});

test("a short backup passphrase is explained in both languages", (t) => {
  const previous = getLanguage();
  t.after(() => setLanguage(previous));
  setLanguage("en");
  assert.equal(passphraseProblem(""), "Enter a passphrase.");
  assert.equal(
    passphraseProblem("short"),
    "The passphrase needs at least 12 characters.",
  );
  assert.equal(passphraseProblem("long enough phrase"), "");
  setLanguage("de");
  assert.equal(
    passphraseProblem("short"),
    "Die Passphrase braucht mindestens 12 Zeichen.",
  );
});
