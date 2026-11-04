import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  returnBlockText,
  stageOptions,
} from "../../web/features/pipelines/return-to-stage-state.js";
import { pipelineCopy } from "../../web/lib/i18n/messages/pipelines.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

const kebab = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

test("every reason the server blocks a return with has its own sentence", (t) => {
  t.after(() => setLanguage("en"));
  const reasons = Object.keys(serverMessages.pipelines.returnBlocked).map(kebab);
  assert.ok(reasons.includes("sequence-watching"));
  for (const language of ["en", "de"]) {
    setLanguage(language);
    for (const reason of reasons) {
      const text = returnBlockText(reason);
      assert.equal(typeof text, "string", `${language} ${reason}`);
      assert.notEqual(text, pipelineCopy.returnToStage.blockedOther, reason);
    }
  }
});

test("an unknown or missing reason falls back to the general sentence", () => {
  setLanguage("en");
  const other = pipelineCopy.returnToStage.blockedOther;
  assert.equal(returnBlockText("something-new"), other);
  assert.equal(returnBlockText(undefined), other);
  assert.equal(returnBlockText(null), other);
  assert.equal(returnBlockText("pr-merged"), pipelineCopy.returnToStage.blocked.prMerged);
});

test("stage options carry the stage id only where two stages share a name", () => {
  assert.deepEqual(
    stageOptions([
      { id: "build", name: "Builder" },
      { id: "review", name: "Reviewer" },
      { id: "fix", name: "Builder" },
      { id: "plain", name: "" },
    ]),
    [
      { value: "build", label: "Builder · build" },
      { value: "review", label: "Reviewer" },
      { value: "fix", label: "Builder · fix" },
      { value: "plain", label: "plain" },
    ],
  );
  assert.deepEqual(stageOptions([]), []);
});
