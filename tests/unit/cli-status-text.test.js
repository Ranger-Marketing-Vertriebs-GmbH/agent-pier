import test from "node:test";
import assert from "node:assert/strict";
import { bindingLine } from "../../web/features/mcp-servers/cli-status-text.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("a managed tool's binding error names the CLI and the problem", () => {
  setLanguage("en");
  assert.equal(
    bindingLine({ cli: "claude", status: "name-taken" }),
    "Claude Code: the name is already used by another entry in the CLI",
  );
  assert.equal(
    bindingLine({ cli: "claude", status: "error", reason: "package" }),
    "Claude Code: could not write: its package is not installed yet or is missing",
  );
  assert.equal(bindingLine(null), "");
  setLanguage("de");
  assert.match(bindingLine({ cli: "claude", status: "conflict" }), /^Claude Code: /);
});
