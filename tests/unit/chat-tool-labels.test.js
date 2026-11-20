import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  shellStreamLabel,
  toolDisplayName,
} from "../../web/features/chat/presentation.js";
import { toolSummary } from "../../web/components/activity-group.js";

test("tool rows the server names read in the owner's language", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(toolDisplayName("Command"), "Befehl");
  assert.equal(toolDisplayName("File change"), "Dateiänderung");
  assert.equal(toolDisplayName("Web search"), "Websuche");
  assert.equal(toolDisplayName(""), "Tool-Aktivität");
  // A CLI's own tool names stay as the CLI wrote them.
  assert.equal(toolDisplayName("Bash"), "Bash");
  assert.equal(
    toolDisplayName("mcp__agentpier__memory_read"),
    "mcp__agentpier__memory_read",
  );
  assert.equal(toolDisplayName("toString"), "toString");
  assert.equal(
    toolSummary(["File change", "Command"].map(toolDisplayName)),
    "Dateiänderung 1 · Befehl 1",
  );
  setLanguage("en", { persist: false });
  assert.equal(toolDisplayName("File change"), "File change");
});

test("shell output streams are labelled in the owner's language", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(shellStreamLabel("output"), "Ausgabe");
  assert.equal(shellStreamLabel("stderr"), "Fehlerausgabe");
  assert.equal(shellStreamLabel("command"), "command");
  assert.equal(shellStreamLabel("constructor"), "constructor");
  setLanguage("en", { persist: false });
  assert.equal(shellStreamLabel("stdout"), "Standard output");
});
