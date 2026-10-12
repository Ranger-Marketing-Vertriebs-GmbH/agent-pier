import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { needsLoginLabel } from "../../web/features/operations/restore-report.js";

test("a restore report names MCP servers that need their values in both languages", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(needsLoginLabel("mcp:docs"), "MCP server docs (enter values again)");
  assert.equal(needsLoginLabel("provider:p1"), "provider:p1");
  assert.equal(needsLoginLabel("assistants"), "assistants");
  setLanguage("de");
  assert.equal(needsLoginLabel("mcp:docs"), "MCP-Server docs (Werte neu eingeben)");
});
