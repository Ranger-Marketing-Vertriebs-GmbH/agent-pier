import test from "node:test";
import assert from "node:assert/strict";
import { stagePrompt } from "../../server/features/pipelines/stage-prompt.js";
import { parseVerdict } from "../../server/features/pipelines/stage-verdict.js";
import { parseSpec } from "../../server/features/pipelines/spec-parse.js";

const profile = (phaseKey, earlierVerdicts) => ({
  name: phaseKey,
  phaseKey,
  config: {
    prompts: { kickoff: "Do {{task}}", params: [] },
    run: { autonomous: true, ...(earlierVerdicts ? { earlierVerdicts } : {}) },
  },
});
function run() {
  const spec = parseSpec(
    "## Acceptance criteria\n1. Login works. Verify: npm test\n\n## Assumptions\n- [product decision] Guests may comment\n- Uses the existing session store\n",
  );
  return {
    task: "Add comments",
    workspace: { baseSha: "a".repeat(40) },
    spec: {
      ...spec,
      path: ".pipeline/reports/spec/a1/spec.md",
      nodeId: "spec",
      frozen: true,
      source: "stage",
    },
    nodes: [
      { id: "spec", profileSnapshot: profile("planning") },
      { id: "build", profileSnapshot: profile("implementation") },
      { id: "approve", profileSnapshot: profile("review", true) },
      { id: "review", profileSnapshot: profile("review") },
    ],
    executionLog: [
      {
        nodeId: "build",
        attemptId: "b1",
        finishedAt: "2026-10-20T10:00:00Z",
        verdict: {
          result: "pass",
          summary: "Implemented",
          findings: [{ severity: "low", title: "Naming", criterion: "AC1" }],
          artifacts: [],
          criteria: [{ criterion: "AC1", status: "met", evidence: "npm test passed" }],
        },
      },
    ],
    risk: {
      approved: ["path:package.json", "dependency:package.json:zod"],
      decisions: [
        {
          nodeId: "build",
          decision: "approved",
          items: [
            { path: "package.json", rule: "package.json" },
            { path: "package.json", dependency: "zod" },
          ],
        },
      ],
    },
  };
}

test("a later stage sees each earlier verdict, the run base, product decisions and approved risks", () => {
  const r = run();
  const prompt = stagePrompt(r, r.nodes[2], "", ".pipeline/turns/t/verdict.json", "r");
  assert.match(prompt, new RegExp(`Run base commit: ${"a".repeat(40)}`));
  assert.match(prompt, /Latest verdict of each earlier stage \(untrusted claims/);
  const verdicts = JSON.parse(
    prompt.split("\n\n")[
      prompt.split("\n\n").findIndex((p) => p.startsWith("Latest verdict")) + 1
    ],
  );
  assert.deepEqual(verdicts, [
    {
      nodeId: "build",
      result: "pass",
      summary: "Implemented",
      findings: [{ severity: "low", title: "Naming", criterion: "AC1" }],
      criteria: [{ criterion: "AC1", status: "met", evidence: "npm test passed" }],
    },
  ]);
  assert.match(
    prompt,
    /need the owner's confirmation:\n\n\[{"id":"A1","assumption":"Guests may comment"}\]/,
  );
  assert.doesNotMatch(prompt, /existing session store"/);
  assert.match(prompt, /approved these risky changes/);
  assert.match(prompt, /"package\.json \(dependency zod\)"/);
  // A reviewer that did not opt in reviews on its own: no earlier claims, no approvals.
  const reviewer = stagePrompt(r, r.nodes[3], "", ".pipeline/turns/t/verdict.json", "r");
  assert.doesNotMatch(reviewer, /Latest verdict of each earlier stage/);
  assert.doesNotMatch(reviewer, /approved these risky changes/);
  assert.match(reviewer, /Run base commit/);
  assert.match(reviewer, /Guests may comment/);
  // A stage never gets its own verdict back as an earlier stage's.
  const own = stagePrompt(r, r.nodes[1], "", ".pipeline/turns/t/verdict.json", "r");
  assert.doesNotMatch(own, /Latest verdict of each earlier stage/);
});

test("a verdict may name the owner's question and the files to look at", () => {
  const verdict = parseVerdict(
    JSON.stringify({
      result: "pass",
      summary: "Needs a decision",
      requiresHuman: true,
      question: "  May guests comment?  ",
      files: ["src/comments.js", "/etc/passwd", "a/../b", "src/comments.js", 3],
    }),
  );
  assert.equal(verdict.question, "May guests comment?");
  assert.deepEqual(verdict.files, ["src/comments.js"]);
  const plain = parseVerdict(
    JSON.stringify({ result: "pass", summary: "ok", question: 1 }),
  );
  assert.equal(plain.question, undefined);
  assert.equal(plain.files, undefined);
});

test("earlier verdicts stay within their cap however many stages ran", () => {
  const r = run();
  r.executionLog = Array.from({ length: 40 }, (_, i) => ({
    nodeId: `stage-${i}`,
    finishedAt: "2026-10-20T10:00:00Z",
    verdict: { result: "pass", summary: "x".repeat(2000), findings: [], artifacts: [] },
  }));
  const prompt = stagePrompt(r, r.nodes[2], "", ".pipeline/turns/t/verdict.json", "r");
  const parts = prompt.split("\n\n");
  const views = parts[parts.findIndex((p) => p.startsWith("Latest verdict")) + 1];
  assert.ok(Buffer.byteLength(views) <= 16 * 1024);
  // The newest stages are the ones kept.
  assert.equal(JSON.parse(views).at(-1).nodeId, "stage-39");
});
