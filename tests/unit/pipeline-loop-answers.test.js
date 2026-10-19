import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  checkAnswers,
  missingAnswers,
  recordResponses,
  repairRound,
  reviewContext,
} from "../../server/features/pipelines/loop-rounds.js";
import { parseVerdict } from "../../server/features/pipelines/stage-verdict.js";
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

  const verdict = { result: "pass", summary: "x", responses: [] };
  const found = (responses) => ({ present: true, verdict: { ...verdict, responses } });
  const ok = found([{ finding: "R1-1", status: "fixed" }]);
  assert.equal(checkAnswers(run, build, repair, ok), ok);
  assert.deepEqual(
    checkAnswers(run, build, repair, found([{ finding: "R9-9", status: "fixed" }])),
    {
      present: false,
      invalid: true,
      reason: serverMessages.pipelines.verdictResponseUnknown("R9-9"),
    },
  );
  // Answers on a turn that repairs nothing stay optional and unchecked.
  const other = found([{ finding: "R9-9", status: "fixed" }]);
  assert.equal(checkAnswers(run, run.nodes[1], turn(run, "test"), other), other);
  assert.deepEqual(checkAnswers(run, build, repair, { present: false }), {
    present: false,
  });
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
  reject(
    [
      { finding: "R1-1", status: "fixed" },
      { finding: " R1-1", status: "disputed", reason: "x" },
    ],
    m.verdictResponseDuplicate("R1-1"),
  );
});
