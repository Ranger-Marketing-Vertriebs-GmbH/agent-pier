import assert from "node:assert/strict";
import test from "node:test";

import { completionRun } from "../../server/features/assistants/completion-runs.js";

const page = (provenance, entryRunId) => [
  { role: "user", content: "Start it", __openclaw: { runId: "owner" } },
  {
    role: "user",
    content: "Exec completed (briny-wh, code 0) :: RENDERED",
    provenance,
    __openclaw: entryRunId ? { runId: entryRunId } : {},
  },
  { role: "assistant", content: "Rendered.", __openclaw: { runId: "follow" } },
];
const exec = { kind: "internal_system", sourceTool: "exec" };

test("an exec completion run is read from the entry before its first record", () => {
  // 2026.11.3's provenance, and 2026.11.6's with the run that started the command.
  assert.equal(completionRun(page(exec), "follow"), true);
  assert.equal(completionRun(page({ ...exec, runId: "owner" }), "follow"), true);
  // Another source, another field, an entry of another run, or no such entry.
  assert.equal(completionRun(page({ ...exec, sourceTool: "cron" }), "follow"), false);
  assert.equal(completionRun(page({ ...exec, origin: "x" }), "follow"), false);
  assert.equal(completionRun(page({ ...exec, runId: 7 }), "follow"), false);
  assert.equal(completionRun(page(exec, "other"), "follow"), false);
  assert.equal(completionRun(page(null), "follow"), false);
  assert.equal(completionRun(page(exec), "owner"), false);
  assert.equal(completionRun(page(exec), "missing"), false);
});
