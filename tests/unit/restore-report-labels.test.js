import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  needsLoginLabel,
  reportValue,
} from "../../web/features/operations/restore-report.js";

test("a restore report names MCP servers that need their values in both languages", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(needsLoginLabel("mcp:docs"), "MCP server docs (enter values again)");
  assert.equal(
    needsLoginLabel("mcp-address:docs"),
    "MCP server docs (enter the token in its address again)",
  );
  assert.equal(needsLoginLabel("provider:p1"), "provider:p1");
  assert.equal(needsLoginLabel("assistants"), "assistants");
  setLanguage("de");
  assert.equal(needsLoginLabel("mcp:docs"), "MCP-Server docs (Werte neu eingeben)");
  assert.equal(
    needsLoginLabel("mcp-address:docs"),
    "MCP-Server docs (Token in der Adresse neu eingeben)",
  );
});

test("a restore report names users who need a new password in both languages", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(needsLoginLabel("user:Anna K"), "User Anna K (set a new password)");
  assert.equal(
    reportValue("credentialsNeedingLogin", ["user:Anna K", "mcp:docs"]),
    "User Anna K (set a new password), MCP server docs (enter values again)",
  );
  setLanguage("de");
  assert.equal(
    needsLoginLabel("user:Anna K"),
    "Benutzer Anna K (neues Passwort vergeben)",
  );
});

test("a restore report shows yes or no instead of raw booleans", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(reportValue("credentialsRestored", true), "Yes");
  assert.equal(reportValue("credentialsRestored", false), "No");
  assert.equal(reportValue("importedRuns", 2), "2");
  assert.equal(
    reportValue("credentialsNeedingLogin", ["mcp:docs", "p1"]),
    "MCP server docs (enter values again), p1",
  );
  assert.equal(reportValue("changedFilesLeftOut", ["a", "b"]), "a, b");
  setLanguage("de");
  assert.equal(reportValue("credentialsRestored", true), "Ja");
  assert.equal(reportValue("credentialsRestored", false), "Nein");
});
