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

// A cancelled or failed member result never reads as an answer that arrived
// (AGENTPIER-284): the chat names how it ended instead.
test("a member result that ended without a result has a neutral line", async () => {
  const { internalTurnText } =
    await import("../../web/features/assistants/internal-turn-text.js");
  const outcomes = ["deadline", "owner", "lead", "stopped", "cancelled", "failed"];
  for (const catalog of [en, de]) {
    assert.deepEqual(Object.keys(catalog.memberOutcomes).sort(), [...outcomes].sort());
    for (const outcome of outcomes) {
      const line = catalog.memberOutcomes[outcome];
      assert.equal(typeof line, "string");
      assert.notEqual(line, catalog.internalTurns["member-result"]);
      assert.doesNotMatch(line, /Konto|Sitzung|eingegangen|arrived/);
    }
  }
  assert.equal(en.memberOutcomes.deadline, "A member's result: cancelled (time limit)");
  assert.equal(
    de.memberOutcomes.deadline,
    "Ergebnis eines Mitglieds: abgebrochen (Zeitlimit)",
  );
  const copy = { team: en };
  assert.equal(
    internalTurnText(copy, "member-result"),
    en.internalTurns["member-result"],
  );
  assert.equal(
    internalTurnText(copy, "member-result", "deadline"),
    en.memberOutcomes.deadline,
  );
  assert.equal(
    internalTurnText(copy, "member-result", "unknown"),
    en.memberOutcomes.failed,
  );
  assert.equal(
    internalTurnText(copy, "peer-result", "deadline"),
    en.internalTurns["peer-result"],
  );
});
