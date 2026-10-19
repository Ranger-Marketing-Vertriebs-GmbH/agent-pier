import test from "node:test";
import assert from "node:assert/strict";
import { parseRawDiff } from "../../server/features/pipelines/workspace-changes.js";
import { assumptionItems, riskKey } from "../../server/features/pipelines/risk-gate.js";

const raw = (entries) => entries.flat().join("\0") + "\0";
const head = (code, oldMode = "100644", newMode = "100644") =>
  `:${oldMode} ${newMode} ${"a".repeat(40)} ${"b".repeat(40)} ${code}`;

test("only the run area leaves the risk diff; renames out of it keep their other side", () => {
  const changes = parseRawDiff(
    raw([
      [head("R090"), ".env.example", "scripts/deploy.sh"],
      [head("R100"), "src/a.js", ".pipeline/reports/a.js"],
      [head("R100"), ".pipeline/x", ".pipeline/y"],
      [head("A"), ".env"],
      [head("A"), "keys/server.pem"],
      [head("M"), ".pipeline/turns/t/verdict.json"],
      [head("A"), ".agentpier-worktrees/x"],
      [head("M", "160000", "160000"), "vendor/lib"],
    ]),
  );
  assert.deepEqual(changes, [
    { status: "R", from: ".env.example", path: "scripts/deploy.sh" },
    { status: "D", path: "src/a.js" },
    { status: "A", path: ".env" },
    { status: "A", path: "keys/server.pem" },
    { status: "M", path: "vendor/lib", submodule: "b".repeat(40) },
  ]);
});

test("product decisions of the spec are risk items keyed by their text", () => {
  const run = {
    spec: {
      assumptions: [
        { id: "A1", text: "Guests may comment", productDecision: true },
        { id: "A2", text: "Uses the session store", productDecision: false },
      ],
    },
  };
  const items = assumptionItems(run);
  assert.deepEqual(items, [{ assumption: "A1", text: "Guests may comment" }]);
  // A revised spec that renumbers the same decision is not asked again.
  assert.equal(
    riskKey(items[0]),
    riskKey({ assumption: "A3", text: "Guests may comment" }),
  );
  assert.equal(assumptionItems({}).length, 0);
});
