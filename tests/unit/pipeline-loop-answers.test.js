import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  claimAnswersNudge,
  filterAnswers,
  missingAnswers,
  recordResponses,
  repairRound,
  reviewContext,
} from "../../server/features/pipelines/loop-rounds.js";
import { parseVerdict } from "../../server/features/pipelines/stage-verdict.js";
import { recordRound } from "../../server/features/pipelines/loop-rounds.js";
import { loopRun, repairing, round, turn } from "../helpers/pipeline-rounds.js";

const review = (run, node) => reviewContext(run, node).join("\n\n");

test("only a turn of the loop target started after the round repairs it", () => {
  const run = loopRun();
  const before = turn(run, "build");
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  const repair = turn(run, "build");
  assert.equal(repairRound(run, build, repair), run.loopRounds[0]);
  assert.equal(repairRound(run, build, before), null);
  assert.equal(repairRound(run, run.nodes[1], turn(run, "test")), null);
  // A stage whose loop context points at another edge repairs nothing here.
  assert.equal(repairRound(run, { ...build, loop: { edge: "x->build" } }, repair), null);
});

test("the next review round gets the repair turn's answers and the unanswered findings", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  // Answers belong to the round only once the repair turn delivers a verdict.
  assert.deepEqual(reviewContext(run, run.nodes[2]), []);
  const repair = turn(run, "build");
  recordResponses(run, build, repair, {
    responses: [{ finding: "R1-1", status: "not-fixed", reason: "Out of scope" }],
  });
  assert.equal(run.loopRounds[0].repairAttemptId, repair.attemptId);
  const text = review(run, run.nodes[2]);
  assert.match(text, /untrusted/);
  assert.match(text, /Missing validation/);
  assert.match(text, /Out of scope/);
  assert.match(text, /"unanswered":\[\{"finding":"R1-2","title":"Slow test"\}\]/);
  // Stages that passed in the round see the answers too; unrelated stages do not.
  assert.notDeepEqual(reviewContext(run, run.nodes[1]), []);
  assert.deepEqual(reviewContext(run, build), []);
});

test("a repair that answers nothing still shows the review what went unanswered", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  recordResponses(run, repairing(run, 1), turn(run, "build"), { result: "pass" });
  assert.equal(run.loopRounds[0].responses, undefined);
  assert.match(review(run, run.nodes[2]), /"unanswered":\[\{"finding":"R1-1"/);
});

test("answers stop reaching a stage once it has reviewed them", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const repair = turn(run, "build");
  recordResponses(run, repairing(run, 1), repair, {
    responses: [{ finding: "R1-1", status: "fixed" }],
  });
  const reviewer = run.nodes[2];
  reviewer.attemptId = "review-next";
  turn(run, "review", { result: "pass", summary: "ok" }, { attemptId: "review-next" });
  // A follow-up turn of the same reviewing attempt still sees them.
  assert.notDeepEqual(reviewContext(run, reviewer), []);
  // A later attempt of the reviewer, e.g. after a loop from another edge, does not.
  reviewer.attemptId = "review-later";
  assert.deepEqual(reviewContext(run, reviewer), []);
});

test("answers merge across turns of the repair and ignore turns outside it", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  const repair = turn(run, "build");
  recordResponses(run, build, repair, {
    responses: [{ finding: "R1-1", status: "not-fixed", reason: "Later" }],
  });
  recordResponses(run, build, turn(run, "build"), {
    responses: [
      { finding: "R1-1", status: "fixed" },
      { finding: "R1-2", status: "disputed", reason: "Fast enough" },
    ],
  });
  assert.deepEqual(run.loopRounds[0].responses, [
    { finding: "R1-1", status: "fixed" },
    { finding: "R1-2", status: "disputed", reason: "Fast enough" },
  ]);
  // A stage without a loop context, or a turn that predates the round, records nothing.
  recordResponses(run, run.nodes[1], turn(run, "test"), {
    responses: [{ finding: "R1-1", status: "not-fixed", reason: "x" }],
  });
  recordResponses(run, build, run.executionLog[0], {
    responses: [{ finding: "R1-1", status: "not-fixed", reason: "x" }],
  });
  assert.equal(run.loopRounds[0].responses[0].status, "fixed");
});

test("missing and unknown answers are found against the repaired round", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  const repair = turn(run, "build");
  assert.deepEqual(missingAnswers(run, build, repair, { result: "pass" }), [
    "R1-1",
    "R1-2",
  ]);
  const partial = { responses: [{ finding: "R1-2", status: "fixed" }] };
  assert.deepEqual(missingAnswers(run, build, repair, partial), ["R1-1"]);
  // Answers recorded by an earlier turn of the repair count.
  recordResponses(run, build, repair, partial);
  assert.deepEqual(missingAnswers(run, build, turn(run, "build"), { result: "pass" }), [
    "R1-1",
  ]);
  // Outside a repair nothing is missing.
  assert.deepEqual(missingAnswers(run, run.nodes[1], turn(run, "test"), {}), []);
});

test("answers outside the repaired round are dropped, unknown ones with a note", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  recordResponses(run, build, turn(run, "build"), {
    responses: [{ finding: "R1-1", status: "fixed" }],
  });
  round(run, "Broken error message", 2);
  build.loop.iteration = 2;
  const repair = turn(run, "build");
  const found = (responses) => ({
    present: true,
    verdict: { result: "pass", summary: "x", responses },
  });
  const ok = found([{ finding: "R2-1", status: "fixed" }]);
  assert.equal(filterAnswers(run, build, repair, ok), ok);
  // Confirming an earlier round's fix is harmless; an id no round has is noted.
  assert.deepEqual(
    filterAnswers(
      run,
      build,
      repair,
      found([
        { finding: "R2-1", status: "fixed" },
        { finding: "R1-1", status: "fixed" },
        { finding: "R9-9", status: "fixed" },
      ]),
    ),
    {
      present: true,
      verdict: {
        result: "pass",
        summary: "x",
        responses: [{ finding: "R2-1", status: "fixed" }],
        ignoredAnswers: ["R9-9"],
      },
    },
  );
  assert.deepEqual(
    filterAnswers(run, build, repair, found([{ finding: "R1-1", status: "fixed" }])),
    { present: true, verdict: { result: "pass", summary: "x" } },
  );
  // Answers on a turn that repairs nothing stay optional and unchecked.
  const other = found([{ finding: "R9-9", status: "fixed" }]);
  assert.equal(filterAnswers(run, run.nodes[1], turn(run, "test"), other), other);
  assert.deepEqual(filterAnswers(run, build, repair, { present: false }), {
    present: false,
  });
});

test("ids count rounds per loop target, also for rounds saved before that", () => {
  const run = loopRun();
  // A round saved by an earlier build carries no seq; its round number stands in.
  run.loopRounds = [{ edge: "review->build", round: 2, toNodeId: "build", stages: [] }];
  const next = round(run, "Missing validation", 3);
  assert.equal(next.seq, 3);
  assert.equal(next.stages[0].findings[0].id, "R3-1");
  // Another edge into the same stage continues the count.
  run.edges.push({ from: "test", to: "build", condition: "fail", maxIterations: 2 });
  turn(run, "build", { result: "pass", summary: "b", findings: [], artifacts: [] });
  const verdict = { result: "fail", summary: "t", findings: [{ title: "Flaky" }] };
  turn(run, "test", verdict);
  const other = recordRound(run, run.nodes[1], run.edges.at(-1), verdict, {
    iteration: 1,
    at: run.executionLog.at(-1).finishedAt,
  });
  assert.deepEqual(
    [other.round, other.seq, other.stages[0].findings[0].id],
    [1, 4, "R4-1"],
  );
});

test("a round asks for missing answers once and keeps them pending until accepted", () => {
  const run = loopRun();
  round(run, "Missing validation", 1);
  const build = repairing(run, 1);
  const first = turn(run, "build");
  assert.equal(claimAnswersNudge(run, build, first), true);
  // A retried repair is a new attempt of the same round: no second nudge.
  assert.equal(claimAnswersNudge(run, build, turn(run, "build")), false);
  assert.equal(claimAnswersNudge(run, run.nodes[1], turn(run, "test")), false);
  recordResponses(
    run,
    build,
    first,
    { responses: [{ finding: "R1-1", status: "fixed" }] },
    { accepted: false },
  );
  assert.equal(run.loopRounds[0].responses.length, 1);
  assert.equal(run.loopRounds[0].repairAttemptId, undefined);
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
  // Ids are normalised and a finding answered twice keeps its last answer.
  assert.deepEqual(
    parseVerdict(
      JSON.stringify({
        ...base,
        responses: [
          { finding: "r1-1", status: "fixed" },
          { finding: "R1-2", status: "fixed" },
          { finding: " #R1\u20131", status: "disputed", reason: "x" },
        ],
      }),
    ).responses,
    [
      { finding: "R1-2", status: "fixed" },
      { finding: "R1-1", status: "disputed", reason: "x" },
    ],
  );
});
