import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../helpers/pipeline-engine.js";

// build -> test -> review; a review failure loops back to build up to twice.
function roundsFixture(t, { gate = false } = {}) {
  const f = fixture(t);
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: ["build", "test", "review", ...(gate ? ["gate"] : [])].map((id) => ({
        id,
        kind: id === "gate" ? "gate" : "profile",
        profileId: "profile",
      })),
      edges: [
        { from: "build", to: "test", condition: "default" },
        { from: "test", to: "review", condition: "default" },
        gate
          ? { from: "review", to: "gate", condition: "pass" }
          : { from: "review", to: "build", condition: "fail", maxIterations: 2 },
        ...(gate
          ? [{ from: "review", to: "build", condition: "fail", maxIterations: 2 }]
          : []),
      ],
    };
    return snapshot;
  };
  return f;
}
const pass = (summary, findings = []) => ({ result: "pass", summary, findings });
const fail = (title, artifacts = []) => ({
  result: "fail",
  summary: `Review found ${title}`,
  findings: [{ severity: "high", title, detail: `Detail of ${title}` }],
  artifacts,
});

test("the second repair prompt carries round 1 and round 2 and the review gets the answers", async (t) => {
  const f = roundsFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  const current = () => f.engine.get(run.id);
  const turn = () => current().executionLog.at(-1);
  const prompt = () => f.launches.at(-1).prompt;

  await f.end(pass("Built"));
  await f.end(pass("Tests green", [{ severity: "low", title: "Slow suite" }]));
  const report = `${turn().reportDir}/REVIEW.md`;
  fs.writeFileSync(path.join(current().workingDir, report), "round 1");
  await f.end(fail("Missing validation", [report]));

  // Round 1: the review's findings first, the passing test stage's note beside them.
  assert.equal(turn().nodeId, "build");
  const first = prompt();
  assert.match(first, /Repair round 1 of 2, sent back by review/);
  assert.match(first, /Missing validation/);
  assert.match(first, /Detail of Missing validation/);
  assert.match(first, /Tests green/);
  assert.match(first, /Slow suite/);
  assert.ok(first.includes(report));
  assert.match(first, /"responses"/);
  assert.equal(current().nodes[0].loop.edge, "review->build");
  assert.equal(current().nodes[0].loop.verdict, undefined);
  const ids = current().loopRounds[0].stages.flatMap((s) => s.findings.map((x) => x.id));
  assert.deepEqual(ids, ["R1-1", "R1-2"]);

  // The repair turn answers per finding; a broken answer list is a broken verdict.
  await f.end({
    ...pass("Repaired"),
    responses: [{ finding: "R1-2", status: "not-fixed" }],
  });
  assert.equal(turn().kind, "verdict-nudge");
  await f.end({
    ...pass("Repaired"),
    responses: [
      { finding: "R1-2", status: "fixed" },
      { finding: "R1-1", status: "disputed", reason: "Suite speed is out of scope" },
    ],
  });
  assert.equal(current().loopRounds[0].responses.length, 2);

  // The next review round sees the answers; the test stage does too.
  assert.equal(turn().nodeId, "test");
  assert.match(prompt(), /Answers of the repair turn/);
  await f.end(pass("Tests green again"));
  assert.equal(turn().nodeId, "review");
  assert.match(prompt(), /Answers of the repair turn/);
  assert.match(prompt(), /Suite speed is out of scope/);
  await f.end(fail("Broken error message"));

  // Round 2: current findings first, round 1 compactly after them with its answers.
  assert.equal(turn().nodeId, "build");
  const second = prompt();
  assert.match(second, /Repair round 2 of 2/);
  const now = second.indexOf("Broken error message");
  const before = second.indexOf("Missing validation");
  assert.ok(now > 0 && before > now, "the current round comes first");
  assert.match(second, /Earlier rounds, oldest first/);
  assert.match(second, /Suite speed is out of scope/);
  assert.match(second, /"finding":"R2-1"/);
  assert.equal(current().loopRounds.length, 2);
  assert.deepEqual(
    current().loopRounds.map((r) => [r.round, r.fromNodeId, r.toNodeId]),
    [
      [1, "review", "build"],
      [2, "review", "build"],
    ],
  );
});

test("an operator loop-back records a round with the operator's note", async (t) => {
  const f = roundsFixture(t, { gate: true });
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  const current = () => f.engine.get(run.id);
  await f.end(pass("Built"));
  await f.end(pass("Tests green"));
  await f.end(pass("Looks fine"));
  assert.equal(current().status, "awaiting-human");
  await f.engine.gate(run.id, { action: "loop-back", feedback: "Also cover the docs" });
  const round = current().loopRounds.at(-1);
  assert.equal(round.operatorNote, "Also cover the docs");
  assert.deepEqual(
    round.stages.map((s) => [s.nodeId, s.result]),
    [
      ["test", "pass"],
      ["review", "pass"],
    ],
  );
  assert.match(f.launches.at(-1).prompt, /Also cover the docs/);
  // No findings, so nothing to answer.
  assert.doesNotMatch(f.launches.at(-1).prompt, /"responses"/);
});

test("a run persisted with the earlier loop context still loads and loops", async (t) => {
  const f = roundsFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"));
  await f.end(pass("Tests green"));
  await f.end(fail("Missing validation"));
  // Rewrite the stored run into the shape earlier builds persisted.
  const stored = f.engine.store.get(run.id);
  delete stored.loopRounds;
  stored.nodes[0].loop = {
    fromNodeId: "review",
    iteration: 1,
    maxIterations: 2,
    verdict: fail("Legacy finding"),
  };
  f.engine.store.save(stored);
  await f.restart();
  await f.end(pass("Repaired"));
  await f.end(pass("Tests green"));
  await f.end(fail("Second finding"));
  const current = f.engine.get(run.id);
  assert.equal(current.executionLog.at(-1).nodeId, "build");
  assert.deepEqual(
    current.loopRounds.map((r) => r.round),
    [2],
  );
  assert.match(f.launches.at(-1).prompt, /Repair round 2 of 2/);
});

test("an earlier loop context without round history keeps its repair prompt", async (t) => {
  const f = roundsFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"));
  await f.end(pass("Tests green"));
  await f.end(fail("Missing validation"));
  const stored = f.engine.store.get(run.id);
  delete stored.loopRounds;
  stored.nodes[0].loop = {
    fromNodeId: "review",
    iteration: 1,
    maxIterations: 2,
    verdict: fail("Legacy finding"),
  };
  f.engine.store.save(stored);
  await f.restart();
  // A follow-up turn of the loop target renders the stored context as before.
  f.outcomes.set(f.launches.at(-1).sessionId, { status: "completed", exitCode: 0 });
  await f.engine.reconcile();
  assert.equal(f.engine.get(run.id).executionLog.at(-1).kind, "verdict-nudge");
  assert.match(f.launches.at(-1).prompt, /Repair the prior review findings/);
  assert.match(f.launches.at(-1).prompt, /Legacy finding/);
});
