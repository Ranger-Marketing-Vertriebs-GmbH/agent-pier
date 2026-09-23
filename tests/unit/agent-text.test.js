import test from "node:test";
import assert from "node:assert/strict";
import { agentText } from "../../server/lib/i18n/agent-text.js";
import { germanServerMessages as german } from "../../server/lib/i18n/catalog-de.js";
import { englishServerMessages as english } from "../../server/lib/i18n/catalog-en.js";

test("agent text resolves catalog messages in English and keeps free text", () => {
  assert.equal(agentText(german.pipelines.runNotFound), english.pipelines.runNotFound);
  // Interpolated German text traces back to its key and arguments.
  assert.equal(
    agentText(german.tools.downloadHttpFailed("503")),
    english.tools.downloadHttpFailed("503"),
  );
  // An explicit key wins; unknown keys fall back to the text.
  assert.equal(agentText("egal", "memory.invalidTitle"), english.memory.invalidTitle);
  assert.equal(
    agentText(german.memory.invalidTitle, "memory.missing"),
    english.memory.invalidTitle,
  );
  // English literals, native CLI output and non-strings stay unchanged.
  assert.equal(agentText("Unknown MCP tool."), "Unknown MCP tool.");
  assert.equal(agentText("fatal: not a git repository"), "fatal: not a git repository");
  assert.equal(agentText(undefined), undefined);
});
