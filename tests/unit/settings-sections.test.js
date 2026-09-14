import test from "node:test";
import assert from "node:assert/strict";
import { appDocumentPath } from "../../server/http/security.js";
import { sections } from "../../web/features/operations/routes.js";

test("every settings section is a document path the server serves on a deep link", () => {
  assert.ok(sections.has("remote"));
  for (const section of sections)
    assert.equal(appDocumentPath.test(`/settings/${section}`), true, section);
  assert.equal(appDocumentPath.test("/settings"), true);
  assert.equal(appDocumentPath.test("/settings/unknown"), false);
});
