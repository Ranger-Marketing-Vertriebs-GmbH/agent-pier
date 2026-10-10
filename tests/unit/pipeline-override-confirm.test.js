import test from "node:test";
import assert from "node:assert/strict";
import { confirmDescription } from "../../web/features/pipelines/run-action-request.js";
import { overridePath } from "../../server/features/pipelines/pipeline-actions.js";
import { pipelineCopy } from "../../web/lib/i18n/messages/pipelines.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

const run = (node) => ({ currentNodeId: "s", nodes: [{ id: "s", ...node }] });
const cases = [
  [
    { status: "failed", failReason: "session-error" },
    "checks-follow",
    "overrideFailedTurn",
  ],
  [
    { status: "failed", failReason: "turn-timeout" },
    "checks-follow",
    "overrideFailedTurn",
  ],
  [
    { status: "awaiting-gate", failReason: "verify-failed" },
    "skips-checks",
    "overrideVerification",
  ],
  [
    { status: "awaiting-gate", failReason: "verdict-missing" },
    "gate-decision",
    "overrideGate",
  ],
  [
    { status: "awaiting-gate", failReason: "verdict-fail" },
    "gate-decision",
    "overrideGate",
  ],
];

test("the override confirmation describes the path the engine takes", (t) => {
  t.after(() => setLanguage("en"));
  for (const language of ["en", "de"]) {
    setLanguage(language);
    for (const [node, path, key] of cases) {
      assert.equal(overridePath(node), path);
      assert.equal(confirmDescription("override", run(node)), pipelineCopy[key]);
    }
    assert.notEqual(pipelineCopy.overrideFailedTurn, pipelineCopy.overrideVerification);
    assert.notEqual(pipelineCopy.overrideGate, pipelineCopy.overrideVerification);
  }
});
