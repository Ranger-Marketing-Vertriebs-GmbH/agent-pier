import test from "node:test";
import assert from "node:assert/strict";
import { folderCounts } from "../../web/features/assistants/member-grants.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("a member's folder summary names the live levels in English", () => {
  setLanguage("en");
  assert.equal(
    folderCounts({ a: "write", b: "read", c: "read" }),
    "1 read and write, 2 read",
  );
  assert.equal(folderCounts({ a: "read" }), "1 read");
  assert.equal(folderCounts({}), "None");
  assert.equal(folderCounts(undefined), "None");
});
