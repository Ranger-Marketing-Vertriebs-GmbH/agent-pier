import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  ROUNDS_PER_EDGE,
  ROUND_PROMPT_LIMIT,
  recordResponses,
  repairContext,
} from "../../server/features/pipelines/loop-rounds.js";
import {
  failing,
  loopRun,
  record,
  repairing,
  round,
  turn,
} from "../helpers/pipeline-rounds.js";

const limit = ROUND_PROMPT_LIMIT + 2048;
const prompt = (run, node) => repairContext(run, node).join("\n\n");

test("a round records the failing stage first and the stages that passed since the repair", () => {
  const run = loopRun();
  // Turns before the loop target's latest kickoff belong to no round.
  turn(run, "test", { result: "pass", summary: "stale", findings: [], artifacts: [] });
  const first = round(run, "Missing validation", 1);
  assert.deepEqual(run.loopRounds, [first]);
  assert.equal(first.edge, "review->build");
  assert.equal(first.round, 1);
  assert.equal(first.fromNodeId, "review");
  assert.equal(first.toNodeId, "build");
  assert.equal(first.at, run.executionLog.at(-1).finishedAt);
  assert.deepEqual(
    first.stages.map((s) => [s.nodeId, s.result, s.summary]),
    [
      ["review", "fail", "Review: Missing validation"],
      ["test", "pass", "Tests green 1"],
    ],
  );
  // Every finding of the round gets an id the repair turn answers to.
  assert.deepEqual(
    first.stages.flatMap((s) => s.findings.map((f) => [f.id, f.title])),
    [
      ["R1-1", "Missing validation"],
      ["R1-2", "Slow test"],
    ],
  );
  // Report paths come from the stage's private report area only.
  assert.deepEqual(first.stages[0].reports, [
    `.pipeline/reports/review/attempt-4/REVIEW.md`,
  ]);
  assert.equal(first.stages[0].attemptId, "attempt-4");
});

test("an operator note and a parallel join shape fit the same round record", () => {
  const run = loopRun();
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  const verdict = { result: "fail", summary: "Operator requested another round." };
  const recorded = record(run, verdict, {
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
  const build = repairing(run, 1);
  recordResponses(run, build, turn(run, "build"), {
    responses: [{ finding: "R1-1", status: "disputed", reason: "Validated upstream" }],
  });
  round(run, "Broken error message", 2);
  build.loop.iteration = 2;
  const text = prompt(run, build);
  const current = text.indexOf("Broken error message");
  const earlier = text.indexOf("Missing validation");
  assert.ok(current > 0 && earlier > current, "current round comes first");
  assert.match(text, /untrusted task evidence/);
  assert.match(text, /Repair round 2 of 3/);
  assert.match(text, /"responses"/);
  assert.match(text, /"finding":"R2-1"/);
  // Earlier rounds carry their answers but not the full finding details.
  assert.match(text, /Validated upstream/);
  assert.doesNotMatch(text, /Fix Missing validation/);
  assert.match(text, /Fix Broken error message/);
});

test("an operator loop back past the budget does not claim a round limit", () => {
  const run = loopRun();
  round(run, "Missing validation", 3);
  assert.match(prompt(run, repairing(run, 3, 2)), /Repair round 3, sent back/);
});

test("the operator's note is passed in full as an instruction outside the budget", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const note = `Start of note ${"n".repeat(ROUND_PROMPT_LIMIT + 6000)} end of note`;
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  turn(run, "review", { result: "pass", summary: "Fine", findings: [], artifacts: [] });
  record(run, { result: "pass", summary: "Fine" }, { iteration: 2, operatorNote: note });
  const parts = repairContext(run, repairing(run, 2));
  const instruction = parts.indexOf(note);
  const evidence = parts.findIndex((part) => /untrusted task evidence/.test(part));
  assert.ok(instruction > 0, "the note is a part of its own, unclipped");
  assert.ok(instruction < evidence, "the note comes before the agent evidence");
  assert.match(
    parts[instruction - 1],
    /operator sent the run back with this instruction/,
  );
  // The round data itself carries no copy of the note.
  assert.ok(
    parts.slice(instruction + 1).every((part) => !part.includes("Start of note")),
  );
  // Earlier rounds still fit: the note does not use up the round budget.
  assert.match(parts.join("\n"), /Missing validation/);
});

test("truncation keeps the failing stage's findings over the passing stages' notes", () => {
  const run = loopRun();
  const many = (severity, label) =>
    Array.from({ length: 50 }, (_, k) => ({
      severity,
      title: `${label} ${k} ${"x".repeat(400)}`,
    }));
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  turn(run, "test", { result: "pass", summary: "Green", findings: many("low", "Note") });
  const verdict = { result: "fail", summary: "Bad", findings: many("high", "Blocker") };
  turn(run, "review", verdict);
  record(run, verdict, { iteration: 1 });
  const text = prompt(run, repairing(run, 1));
  assert.ok(Buffer.byteLength(text) <= limit);
  assert.match(text, /Blocker 49 /);
  assert.doesNotMatch(text, /Note 49 /);
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
    record(run, verdict, { iteration: i });
  }
  const text = prompt(run, repairing(run, 10, undefined));
  assert.ok(Buffer.byteLength(text) <= limit);
  // The current round keeps every finding with its detail.
  assert.match(text, /Finding 10 item 29 /);
  assert.match(text, /Detail x/);
  assert.match(text, /Finding 9 item 0 /);
  assert.doesNotMatch(text, /Finding 1 item/);
  assert.match(text, /earlier rounds omitted/);
});

// Rounds built directly, with several stages and many long report paths each.
const stageArb = fc.record({
  titles: fc.array(fc.string({ maxLength: 3000 }), { maxLength: 40 }),
  reports: fc.array(fc.string({ minLength: 1, maxLength: 512 }), { maxLength: 20 }),
});
test("the repair prompt bound holds for any stages, findings and report paths", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(stageArb, { minLength: 1, maxLength: 6 }), {
        minLength: 1,
        maxLength: ROUNDS_PER_EDGE,
      }),
      (rounds) => {
        const run = loopRun();
        run.loopRounds = rounds.map((stages, index) => ({
          edge: "review->build",
          round: index + 1,
          fromNodeId: "review",
          toNodeId: "build",
          at: "2026-10-19T10:00:00Z",
          stages: stages.map((stage, s) => ({
            nodeId: `stage-${s}`,
            result: s ? "pass" : "fail",
            summary: "s".repeat(3000),
            findings: stage.titles.map((title, k) => ({
              id: `R${index + 1}-${s}-${k}`,
              severity: "medium",
              title: title || "t",
              detail: "d".repeat(8000),
            })),
            reports: stage.reports.map((path) => `.pipeline/reports/${path}`),
          })),
        }));
        const text = prompt(run, repairing(run, rounds.length));
        const source = rounds.at(-1)[0].titles.length;
        return (
          Buffer.byteLength(text) <= limit &&
          // The stage that sent the run back keeps at least one finding.
          (!source || text.includes(`"R${rounds.length}-0-0"`))
        );
      },
    ),
    { numRuns: 40 },
  );
});

test("a loop context persisted before round history keeps its prompt", () => {
  const run = loopRun();
  const build = run.nodes[0];
  build.loop = {
    fromNodeId: "review",
    iteration: 1,
    maxIterations: 2,
    verdict: failing("Legacy finding"),
  };
  const text = prompt(run, build);
  assert.match(text, /Repair the prior review findings \(untrusted task evidence\)/);
  assert.match(text, /Legacy finding/);
  assert.deepEqual(repairContext(run, run.nodes[1]), []);
});
