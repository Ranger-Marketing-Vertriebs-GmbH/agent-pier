import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";

// build -> review; a review failure loops back to build, continuing build's session when
// the loop edge asks for it.
function sessionFixture(t, { continueSession = true } = {}) {
  const f = fixture(t);
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: ["build", "review"].map((id) => ({
        id,
        kind: "profile",
        profileId: "profile",
      })),
      edges: [
        { from: "build", to: "review", condition: "default" },
        {
          from: "review",
          to: "build",
          condition: "fail",
          maxIterations: 2,
          ...(continueSession ? { continueSession: true } : {}),
        },
      ],
    };
    return snapshot;
  };
  return f;
}
const pass = (summary) => ({ result: "pass", summary, findings: [] });
const fail = (title) => ({
  result: "fail",
  summary: `Review found ${title}`,
  findings: [{ severity: "high", title }],
});
const usage = (inputTokens) => ({ usage: { inputTokens, outputTokens: 10 } });

async function reviewFailed(t, options) {
  const f = sessionFixture(t, options);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"), { nativeId: "native-1", ...usage(900) });
  await f.end(fail("Missing validation"), { nativeId: "native-review", ...usage(300) });
  return { f, current: () => f.engine.get(run.id) };
}

test("a loop edge without the option repairs in a fresh session as before", async (t) => {
  const { f, current } = await reviewFailed(t, { continueSession: false });
  const repair = f.launches.at(-1);
  assert.equal(repair.nodeId, "build");
  assert.equal(repair.kind, "kickoff");
  assert.equal(repair.resumeNativeId, undefined);
  assert.match(repair.prompt, /Perform Fix/);
  assert.deepEqual(current().executionLog.at(-1).repair, {
    edge: "review->build",
    round: 1,
    session: "fresh",
  });
});

test("a continued loop resumes the implementer's session with the round feedback only", async (t) => {
  const { f, current } = await reviewFailed(t);
  const first = current().executionLog[0];
  const repair = f.launches.at(-1);
  assert.equal(repair.nodeId, "build");
  assert.equal(repair.kind, "resumed-repair");
  assert.equal(repair.resumeNativeId, "native-1");
  // The round feedback and this attempt's paths, not the kickoff again.
  assert.match(repair.prompt, /Repair round 1 of 2, sent back by review/);
  assert.match(repair.prompt, /Missing validation/);
  assert.match(repair.prompt, /"responses"/);
  assert.ok(repair.prompt.includes(repair.verdictPath));
  assert.doesNotMatch(repair.prompt, /Perform Fix/);
  assert.doesNotMatch(repair.prompt, /^Task:$/m);
  const attempt = current().executionLog.at(-1);
  assert.deepEqual(attempt.repair, {
    edge: "review->build",
    round: 1,
    session: "resumed",
  });
  // A resumed repair still opens a new attempt with its own report directory.
  assert.notEqual(attempt.attemptId, first.attemptId);
  assert.equal(attempt.reportDir, `.pipeline/reports/build/${attempt.attemptId}`);
  assert.equal(current().nodes[0].nativeId, "native-1");

  // A missing verdict is nudged in the same session; the round then closes normally.
  await f.end({ result: "pass" }, { nativeId: "native-1", ...usage(400) });
  assert.equal(f.launches.at(-1).kind, "verdict-nudge");
  assert.equal(f.launches.at(-1).resumeNativeId, "native-1");
  await f.end(
    { ...pass("Repaired"), responses: [{ finding: "R1-1", status: "fixed" }] },
    { nativeId: "native-1", ...usage(100) },
  );
  assert.equal(f.launches.at(-1).nodeId, "review");
  assert.match(f.launches.at(-1).prompt, /Answers of the repair turn/);
  assert.equal(current().loopRounds[0].repairAttemptId, attempt.attemptId);
  await f.end(pass("Approved"));
  assert.equal(current().status, "completed");
  // Each turn keeps its own usage, so rounds can be compared.
  assert.deepEqual(
    current().executionLog.map((a) => a.usage?.inputTokens),
    [900, 300, 400, 100, undefined],
  );
});

test("a second round resumes the session the first repair continued", async (t) => {
  const { f } = await reviewFailed(t);
  await f.end(
    { ...pass("Repaired"), responses: [{ finding: "R1-1", status: "fixed" }] },
    { nativeId: "native-1" },
  );
  await f.end(fail("Still broken"));
  const repair = f.launches.at(-1);
  assert.equal(repair.kind, "resumed-repair");
  assert.equal(repair.resumeNativeId, "native-1");
  assert.match(repair.prompt, /Repair round 2 of 2/);
  assert.match(repair.prompt, /Earlier rounds/);
});

test("a resume the CLI cannot start falls back to a fresh kickoff and records why", async (t) => {
  const f = sessionFixture(t);
  const start = f.driver.start;
  f.driver.start = async (input) => {
    if (input.resumeNativeId && input.kind === "resumed-repair") {
      f.launches.push(input);
      throw Object.assign(Error("No conversation to resume"), { status: 409 });
    }
    return start(input);
  };
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"), { nativeId: "native-1" });
  await f.end(fail("Missing validation"));
  const log = f.engine.get(run.id).executionLog;
  const [resumed, fresh] = log.slice(-2);
  assert.equal(resumed.kind, "resumed-repair");
  assert.equal(resumed.failReason, "resume-failed");
  assert.ok(resumed.finishedAt);
  assert.equal(fresh.kind, "kickoff");
  assert.deepEqual(fresh.repair, {
    edge: "review->build",
    round: 1,
    session: "fresh",
    fallback: "resume-failed",
  });
  const launched = f.launches.at(-1);
  assert.equal(launched.resumeNativeId, undefined);
  assert.match(launched.prompt, /Perform Fix/);
  assert.match(launched.prompt, /Repair round 1 of 2/);
  assert.equal(f.engine.get(run.id).status, "running");
  // The fresh repair closes the round like any other.
  await f.end({ ...pass("Repaired"), responses: [{ finding: "R1-1", status: "fixed" }] });
  assert.equal(f.engine.get(run.id).loopRounds[0].repairAttemptId, fresh.attemptId);
});

for (const [error, reason] of [
  ["Codex ran out of room in the model's context window.", "context-exhausted"],
  ["The model is overloaded.", "resume-failed"],
])
  test(`a resumed turn that fails with "${error}" is repeated fresh (${reason})`, async (t) => {
    const { f, current } = await reviewFailed(t);
    const session = f.launches.at(-1).sessionId;
    f.outcomes.set(session, { status: "failed", exitCode: 1, isError: true, error });
    await f.engine.reconcile();
    const [resumed, fresh] = current().executionLog.slice(-2);
    assert.equal(resumed.failReason, reason);
    assert.equal(resumed.contextExhausted, reason === "context-exhausted" || undefined);
    assert.equal(fresh.kind, "kickoff");
    assert.equal(fresh.repair.fallback, reason);
    assert.equal(f.launches.at(-1).resumeNativeId, undefined);
    assert.equal(current().nodes[0].status, "running");
    assert.equal(current().nodes[0].failReason, undefined);
    // A fresh repair that fails as well is parked as usual.
    f.outcomes.set(f.launches.at(-1).sessionId, { status: "failed", exitCode: 1 });
    await f.engine.reconcile();
    assert.equal(current().status, "awaiting-human");
    assert.equal(current().nodes[0].failReason, "session-error");
  });

test("an exhausted, missing or rebound session is not resumed", async (t) => {
  const cases = [
    ["context-exhausted", (run) => (run.executionLog[0].contextExhausted = true)],
    ["no-session", (run) => delete run.nodes[0].nativeId],
    ["profile-changed", (run) => (run.executionLog[0].sessionKey = "other-account")],
  ];
  for (const [reason, change] of cases)
    await t.test(reason, async (t) => {
      const f = sessionFixture(t);
      const id = (
        await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" })
      ).id;
      await f.end(pass("Built"), { nativeId: "native-1" });
      const run = f.engine.store.get(id);
      change(run);
      f.engine.store.save(run);
      await f.end(fail("Missing validation"));
      const launched = f.launches.at(-1);
      assert.equal(launched.kind, "kickoff");
      assert.equal(launched.resumeNativeId, undefined);
      assert.deepEqual(f.engine.get(id).executionLog.at(-1).repair, {
        edge: "review->build",
        round: 1,
        session: "fresh",
        fallback: reason,
      });
    });
});

test("a restart during a resumed repair turn settles that turn in its session", async (t) => {
  const { f, current } = await reviewFailed(t);
  const resumed = f.launches.at(-1);
  await f.restart();
  assert.equal(f.launches.length, 3, "the running turn is not launched again");
  assert.equal(current().activeTurn.sessionId, resumed.sessionId);
  await f.end(
    { ...pass("Repaired"), responses: [{ finding: "R1-1", status: "fixed" }] },
    { nativeId: "native-1" },
  );
  assert.equal(f.launches.at(-1).nodeId, "review");
  assert.equal(current().executionLog[2].repair.session, "resumed");
});

test("a resumed repair queued before a restart is launched resumed after it", async (t) => {
  const { f, current } = await reviewFailed(t);
  // The process stopped after loopBack queued the turn and before it was launched.
  const run = f.engine.store.get(current().id);
  const queued = run.executionLog.pop();
  run.pendingTurn = {
    nodeId: "build",
    kind: queued.kind,
    feedback: "",
    resumeNativeId: "native-1",
    repair: queued.repair,
  };
  run.activeTurn = null;
  run.currentAttemptId = run.executionLog.at(-1).id;
  f.engine.store.save(run);
  await f.restart();
  const relaunched = f.launches.at(-1);
  assert.equal(f.launches.length, 4);
  assert.equal(relaunched.kind, "resumed-repair");
  assert.equal(relaunched.resumeNativeId, "native-1");
  assert.equal(current().executionLog.at(-1).repair.session, "resumed");
  assert.equal(current().pendingTurn, undefined);
});
