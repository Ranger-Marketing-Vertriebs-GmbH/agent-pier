import test from "node:test";
import assert from "node:assert/strict";
import { auditSummary } from "../../web/features/operations/audit-actor.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("a browser upload says what it did, not only assistant.updated", (t) => {
  // AGENTPIER-445: upload entries in the activity log were generic.
  t.after(() => setLanguage("de"));
  setLanguage("en");
  const upload = (browserUpload, extra = {}) => ({
    action: "assistant.updated",
    details: { kind: "browser-upload", browserUpload, filePath: "README.md", ...extra },
  });
  assert.equal(
    auditSummary(upload("uploaded", { declaredSite: "w3schools.com" })),
    "Browser upload: file uploaded · README.md · to w3schools.com",
  );
  assert.equal(auditSummary(upload("failed")), "Browser upload: failed · README.md");
  assert.equal(auditSummary({ action: "assistant.updated", details: {} }), "");
  setLanguage("de");
  assert.equal(
    auditSummary(upload("staged")),
    "Browser-Upload: Datei bereitgestellt · README.md",
  );
});
