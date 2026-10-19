import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  ROUNDS_PER_EDGE,
  ROUND_PROMPT_LIMIT,
  recordResponses,
  recordRound,
  repairContext,
  reviewContext,
} from "../../server/features/pipelines/loop-rounds.js";
import { parseVerdict } from "../../server/features/pipelines/stage-verdict.js";

// build -> test -> review, a review failure loops back to build.
const edge = { from: "review", to: "build", condition: "fail", maxIterations: 3 };
function loopRun() {
  return {
    nodes: ["build", "test", "review"].map((id) => ({ id, status: "passed" })),
    edges: [
      { from: "build", to: "test", condition: "default" },
      { from: "test", to: "review", condition: "default" },
      edge,
    ],
    loopState: {},
    executionLog: [],
  };
}
function turn(run, nodeId, verdict, extra = {}) {
  const n = run.executionLog.length + 1;
  const entry = {
    id: `turn-${n}`,
    nodeId,
    attemptId: `attempt-${n}`,
    kind: "kickoff",
    reportDir: `.pipeline/reports/${nodeId}/attempt-${n}`,
    startedAt: `2026-10-19T10:${String(n).padStart(2, "0")}:00Z`,
    finishedAt: `2026-10-19T10:${String(n).padStart(2, "0")}:30Z`,
    ...(verdict ? { verdict } : {}),
    ...extra,
  };
  run.executionLog.push(entry);
  return entry;
}
const failing = (title, artifacts = []) => ({
  result: "fail",
  summary: `Review: ${title}`,
  findings: [{ severity: "high", title, detail: `Fix ${title}` }],
  artifacts,
});
// One full round: build, test passes with a note, review fails.
function round(run, title, iteration) {
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  turn(run, "test", {
    result: "pass",
    summary: `Tests green ${iteration}`,
    findings: [{ severity: "low", title: "Slow test" }],
    artifacts: [],
  });
  const report = `.pipeline/reports/review/attempt-${run.executionLog.length + 1}/REVIEW.md`;
  const verdict = failing(title, [{ path: report }, { path: "app.js" }]);
  turn(run, "review", verdict);
  return recordRound(run, run.nodes[2], edge, verdict, { iteration });
}

test("a round records the failing stage and the stages that passed since the repair", () => {
  const run = loopRun();
  // Turns before the loop target's latest kickoff belong to no round.
  turn(run, "test", { result: "pass", summary: "stale", findings: [], artifacts: [] });
  const first = round(run, "Missing validation", 1);
  assert.deepEqual(run.loopRounds, [first]);
  assert.equal(first.edge, "review->build");
  assert.equal(first.round, 1);
  assert.equal(first.fromNodeId, "review");
  assert.equal(first.toNodeId, "build");
  assert.deepEqual(
    first.stages.map((s) => [s.nodeId, s.result, s.summary]),
    [
      ["test", "pass", "Tests green 1"],
      ["review", "fail", "Review: Missing validation"],
    ],
  );
  // Every finding of the round gets an id the repair turn answers to.
  assert.deepEqual(
    first.stages.flatMap((s) => s.findings.map((f) => [f.id, f.title])),
    [
      ["R1-1", "Slow test"],
      ["R1-2", "Missing validation"],
    ],
  );
  // Report paths come from the stage's private report area only.
  assert.deepEqual(first.stages[1].reports, [
    `.pipeline/reports/review/attempt-4/REVIEW.md`,
  ]);
  assert.equal(first.stages[1].attemptId, "attempt-4");
  assert.equal(typeof first.at, "string");
});

test("an operator note and a parallel join shape fit the same round record", () => {
  const run = loopRun();
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  const verdict = { result: "fail", summary: "Operator requested another round." };
  const recorded = recordRound(run, run.nodes[2], edge, verdict, {
    iteration: 1,
    operatorNote: "Please also check the docs",
  });
  assert.equal(recorded.operatorNote, "Please also check the docs");
  assert.deepEqual(recorded.stages, [
    {
      nodeId: "review",
      result: "fail",
      summary: "Operator requested another round.",
      findings: [],
      reports: [],
    },
  ]);
});

test("the history per loop edge stays bounded, oldest rounds go first", () => {
  const run = loopRun();
  for (let i = 1; i <= ROUNDS_PER_EDGE + 3; i++) round(run, `Finding ${i}`, i);
  assert.equal(run.loopRounds.length, ROUNDS_PER_EDGE);
  assert.equal(run.loopRounds[0].round, 4);
  assert.equal(run.loopRounds.at(-1).round, ROUNDS_PER_EDGE + 3);
});

test("the repair prompt lists the current round first and earlier rounds compactly", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = run.nodes[0];
  build.loop = {
    edge: "review->build",
    fromNodeId: "review",
    iteration: 1,
    maxIterations: 3,
  };
  recordResponses(run, build, turn(run, "build"), {
    responses: [{ finding: "R1-2", status: "disputed", reason: "Validated upstream" }],
  });
  round(run, "Broken error message", 2);
  build.loop.iteration = 2;
  const text = repairContext(run, build).join("\n\n");
  const current = text.indexOf("Broken error message");
  const earlier = text.indexOf("Missing validation");
  assert.ok(current > 0 && earlier > current, "current round comes first");
  assert.match(text, /untrusted task evidence/);
  assert.match(text, /round 2 of 3/);
  assert.match(text, /"responses"/);
  assert.match(text, /R2-2/);
  // Earlier rounds carry their answers but not the full finding details.
  assert.match(text, /Validated upstream/);
  assert.doesNotMatch(text, /Fix Missing validation/);
  assert.match(text, /Fix Broken error message/);
});

test("the repair prompt stays bounded and truncates the oldest rounds first", () => {
  const run = loopRun();
  const long = "x".repeat(150);
  for (let i = 1; i <= ROUNDS_PER_EDGE; i++) {
    turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
    const verdict = {
      result: "fail",
      summary: `Round ${i}`,
      findings: Array.from({ length: 30 }, (_, k) => ({
        severity: "medium",
        title: `Finding ${i} item ${k} ${long}`,
        detail: `Detail ${long}`,
      })),
    };
    turn(run, "review", verdict);
    recordRound(run, run.nodes[2], edge, verdict, { iteration: i });
  }
  const build = run.nodes[0];
  build.loop = { edge: "review->build", fromNodeId: "review", iteration: 10 };
  const text = repairContext(run, build).join("\n\n");
  assert.ok(Buffer.byteLength(text) <= ROUND_PROMPT_LIMIT + 2048);
  // The current round keeps every finding with its detail.
  assert.match(text, /Finding 10 item 29 /);
  assert.match(text, /Detail x/);
  assert.match(text, /Finding 9 item 0 /);
  assert.doesNotMatch(text, /Finding 1 item/);
  assert.match(text, /earlier rounds omitted/);
});

test("the repair prompt bound holds for any number and size of findings", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(fc.string({ maxLength: 3000 }), { maxLength: 40 }), {
        minLength: 1,
        maxLength: ROUNDS_PER_EDGE,
      }),
      (rounds) => {
        const run = loopRun();
        rounds.forEach((titles, index) => {
          turn(run, "build", {
            result: "pass",
            summary: "b",
            findings: [],
            artifacts: [],
          });
          const verdict = {
            result: "fail",
            summary: "s".repeat(3000),
            findings: titles.map((title) => ({
              severity: "medium",
              title: title || "t",
              detail: "d".repeat(8000),
            })),
          };
          turn(run, "review", verdict);
          recordRound(run, run.nodes[2], edge, verdict, { iteration: index + 1 });
        });
        const build = run.nodes[0];
        build.loop = { edge: "review->build", iteration: rounds.length };
        const text = repairContext(run, build).join("\n\n");
        return Buffer.byteLength(text) <= ROUND_PROMPT_LIMIT + 2048;
      },
    ),
    { numRuns: 30 },
  );
});

test("a loop context persisted before round history keeps its prompt", () => {
  const run = loopRun();
  const build = run.nodes[0];
  build.loop = {
    fromNodeId: "review",
    iteration: 1,
    maxIterations: 2,
    verdict: { result: "fail", summary: "Legacy finding" },
  };
  const text = repairContext(run, build).join("\n\n");
  assert.match(text, /Repair the prior review findings \(untrusted task evidence\)/);
  assert.match(text, /Legacy finding/);
  assert.deepEqual(repairContext(run, run.nodes[1]), []);
});

test("the next review round gets the repair turn's answers", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = run.nodes[0];
  build.loop = { edge: "review->build", fromNodeId: "review", iteration: 1 };
  // Answers belong to the round only once the repair turn delivers them.
  assert.deepEqual(reviewContext(run, run.nodes[2]), []);
  const repair = turn(run, "build");
  recordResponses(run, build, repair, { result: "pass", summary: "Repaired" });
  assert.equal(run.loopRounds[0].responses, undefined);
  recordResponses(run, build, repair, {
    responses: [
      { finding: "R1-2", status: "fixed" },
      { finding: "R1-1", status: "not-fixed", reason: "Out of scope" },
    ],
  });
  assert.equal(run.loopRounds[0].repairAttemptId, repair.attemptId);
  const text = reviewContext(run, run.nodes[2]).join("\n\n");
  assert.match(text, /untrusted/);
  assert.match(text, /"R1-2"/);
  assert.match(text, /Missing validation/);
  assert.match(text, /Out of scope/);
  // Stages that passed in the round see the answers too; unrelated stages do not.
  assert.notDeepEqual(reviewContext(run, run.nodes[1]), []);
  assert.deepEqual(reviewContext(run, build), []);
  // A stage without a loop context records nothing.
  recordResponses(run, run.nodes[1], turn(run, "test"), {
    responses: [{ finding: "R1-1", status: "fixed" }],
  });
  assert.equal(run.loopRounds[0].responses.length, 2);
});

test("verdict responses are validated and stay optional", () => {
  const base = { result: "pass", summary: "Done" };
  assert.equal(parseVerdict(JSON.stringify(base)).responses, undefined);
  assert.deepEqual(
    parseVerdict(
      JSON.stringify({
        ...base,
        responses: [
          { finding: " R1-1 ", status: "Fixed" },
          { finding: "R1-2", status: "not fixed", reason: "Needs a migration" },
          { finding: "R1-3", status: "disputed", reason: "Intended behaviour" },
        ],
      }),
    ).responses,
    [
      { finding: "R1-1", status: "fixed" },
      { finding: "R1-2", status: "not-fixed", reason: "Needs a migration" },
      { finding: "R1-3", status: "disputed", reason: "Intended behaviour" },
    ],
  );
  const reject = (responses, message) =>
    assert.throws(() => parseVerdict(JSON.stringify({ ...base, responses })), {
      status: 400,
      message,
    });
  const m = serverMessages.pipelines;
  reject({}, m.verdictResponsesArray);
  reject(["R1-1"], m.verdictResponseFinding);
  reject([{ status: "fixed" }], m.verdictResponseFinding);
  reject([{ finding: "R1-1", status: "maybe" }], m.verdictResponseStatus);
  reject([{ finding: "R1-1", status: "not-fixed" }], m.verdictResponseReason);
  reject([{ finding: "R1-1", status: "disputed", reason: " " }], m.verdictResponseReason);
});
