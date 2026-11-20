import test from "node:test";
import assert from "node:assert/strict";
import { agentWizardCopy as de } from "../../web/lib/i18n/de/agent-wizard.js";
import { agentWizardCopy as en } from "../../web/lib/i18n/en/agent-wizard.js";
import { heartbeatRuns } from "../../web/features/assistants/heartbeat.js";

// AGENTPIER-440 B5: the runtime choice says what each runtime offers today. Hermes
// has routines and memory (no "later"), and Mixture of Agents is Hermes's alone.
test("the runtime choice names what each runtime offers", () => {
  assert.doesNotMatch(en.start.hermesSub, /later/);
  assert.doesNotMatch(de.start.hermesSub, /folgen/);
  for (const copy of [en, de]) {
    assert.match(copy.start.hermesSub, /Mixture of Agents/);
    assert.doesNotMatch(copy.start.openclawSub, /Mixture of Agents/);
    assert.match(copy.start.hermesSub, /[Rr]outine/);
  }
  assert.doesNotMatch(en.start.openclawSub, /Every capability/);
  assert.doesNotMatch(de.start.openclawSub, /Alle Fähigkeiten/);
});

// AGENTPIER-440 U7: the review names what the default check-ins cost.
test("the review names the check-ins' runs a day", () => {
  const runs = heartbeatRuns({ interval: "30m", start: 9, end: 18 });
  assert.equal(runs, 18);
  assert.equal(en.review.checkIns(runs), "Check-ins (about 18 runs a day)");
  assert.equal(de.review.checkIns(runs), "Meldet sich von selbst (etwa 18 Läufe am Tag)");
});
