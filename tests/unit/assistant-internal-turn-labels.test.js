import test from "node:test";
import assert from "node:assert/strict";
import { internalKinds } from "../../server/features/assistants/conversations.js";
import { assistantTeamCopy as en } from "../../web/lib/i18n/en/assistant-team.js";
import { assistantTeamCopy as de } from "../../web/lib/i18n/de/assistant-team.js";

// The chat names an internal turn by its kind (AssistantChat latest.internal).
test("every internal turn the server hides has a label in both catalogs", () => {
  assert.ok(internalKinds.has("peer-result"));
  for (const kind of internalKinds) {
    assert.equal(typeof en.internalTurns[kind], "string", `en ${kind}`);
    assert.equal(typeof de.internalTurns[kind], "string", `de ${kind}`);
  }
});
