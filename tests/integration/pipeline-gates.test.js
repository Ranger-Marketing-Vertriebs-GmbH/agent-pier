import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
function verifier() {
  const jobs = new Map(),
    plans = [];
  return {
    jobs,
    plans,
    async start(input) {
      plans.push(input);
      jobs.set(input.id, { status: "running" });
      return { id: input.id };
    },
    async inspect(job) {
      return jobs.get(job.id);
    },
    async cancel(job) {
      jobs.set(job.id, { status: "unavailable" });
    },
  };
}
async function start(f) {
  return f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
}
test("verification plan is frozen; pass reaches human gate without duplicate verification after restart", async (t) => {
  const verify = verifier(),
    f = fixture(t, { gate: true, verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  await f.end(undefined, { nativeId: "native" });
  f.definitions.getVerification = () => ({
    steps: [{ name: "changed", command: "false", timeoutMs: 1000, blocking: true }],
  });
  assert.equal(verify.plans[0].steps[0].name, "check");
  assert.equal(f.engine.get(r.id).status, "running");
  await f.restart();
  assert.equal(verify.plans.length, 1);
  verify.jobs.set(verify.plans[0].id, {
    status: "pass",
    steps: [{ name: "check", exitCode: 0 }],
  });
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
  await f.engine.gate(r.id, { action: "accept" });
  assert.equal(f.engine.get(r.id).status, "completed");
});
test("verification repair stops at three failed checks, preserves evidence, and allows explicit override", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "false", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  for (let i = 0; i < 3; i++) {
    await f.end(undefined, { nativeId: "native" });
    verify.jobs.set(verify.plans.at(-1).id, {
      status: i === 0 ? "timed-out" : "fail",
      steps: [{ name: "check", exitCode: 1, logTail: "failure" }],
    });
    await f.engine.reconcile();
  }
  const run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].failReason, "verify-failed");
  assert.equal(run.nodes[0].verifyAttempts, 3);
  assert.equal(f.launches.length, 3);
  assert.ok(!run.actions.includes("retry"));
  assert.equal(f.engine.verifyLogs(r.id, "build", 0).log, "failure");
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(f.engine.get(r.id).nodes[0].overridden, true);
});
test("PR failure retries publishing without rerunning the native agent and cannot retry after cancellation", async (t) => {
  const f = fixture(t);
  const snap = f.definitions.snapshot();
  snap.pipeline.graph.nodes.push({ id: "pr", kind: "createPr" });
  snap.pipeline.graph.edges.push({ from: "build", to: "pr", condition: "default" });
  let tries = 0;
  f.workspace.createPr = async () => {
    if (++tries === 1) throw Error("private upstream error");
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  const r = await start(f);
  await f.end();
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "pr-failed");
  await f.engine.retry(r.id);
  assert.equal(f.launches.length, 1);
  assert.equal(f.engine.get(r.id).status, "completed");
  await assert.rejects(f.engine.retry(r.id), { status: 409 });
});
test("native usage limit resumes only its parked run at the persisted reset instant", async (t) => {
  let now = Date.now();
  const f = fixture(t, { clock: { now: () => now } });
  const r = await start(f);
  await f.end(undefined, {
    status: "failed",
    exitCode: 1,
    usageLimit: { resetAt: Math.floor(now / 1000) + 10 },
  });
  const parked = f.engine.get(r.id);
  assert.equal(parked.nodes[0].failReason, "usage-limit-exceeded");
  assert.ok(parked.actions.includes("resume-now"));
  await f.restart();
  assert.equal(f.launches.length, 1);
  now = Date.parse(parked.usageResumeAt) + 1;
  await f.engine.reconcile();
  assert.equal(f.launches.length, 2);
  assert.equal(f.engine.get(r.id).status, "running");
});

test("a later verification attempt reads new operator settings without rewriting prior results", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "first", command: "false", timeoutMs: 1000, blocking: true }],
  });
  await start(f);
  await f.end(undefined, { nativeId: "native" });
  verify.jobs.set(verify.plans[0].id, {
    status: "fail",
    steps: [{ name: "first", exitCode: 1 }],
  });
  await f.engine.reconcile();
  f.definitions.getVerification = () => ({
    steps: [{ name: "next", command: "true", timeoutMs: 1000, blocking: true }],
  });
  await f.end(undefined, { nativeId: "native" });
  assert.equal(verify.plans[1].steps[0].name, "next");
  assert.equal(verify.plans[0].steps[0].name, "first");
});

test("each stage records its own immutable checkpoint boundaries for later diff inspection", async (t) => {
  const f = fixture(t, { loop: true });
  let head = "initial",
    number = 0;
  f.workspace.inspect = async () => ({ headSha: head });
  f.workspace.checkpoint = async () => ({ sha: (head = "commit" + ++number) });
  let compared;
  f.workspace.diff = async (input) => {
    compared = input;
    return { diff: "changed", truncated: false };
  };
  const r = await start(f);
  await f.end();
  await f.end();
  const run = f.engine.get(r.id);
  assert.equal(run.executionLog[0].baseSha, "initial");
  assert.equal(run.executionLog[0].endSha, "commit1");
  assert.equal(run.executionLog[1].baseSha, "commit1");
  assert.equal(run.executionLog[1].endSha, "commit2");
  await f.engine.diff(r.id, "build");
  assert.equal(compared.from, "initial");
  assert.equal(compared.to, "commit1");
});

test("unreadable verification receipts park the run without launching another native turn", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  await f.end(undefined, { nativeId: "native" });
  verify.inspect = async () => {
    throw new SyntaxError("private broken receipt");
  };
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "verify-failed");
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
  assert.equal(f.launches.length, 1);
});

test("usage totals derive from native input and output when no total is reported", async (t) => {
  const f = fixture(t),
    r = await start(f);
  await f.end(undefined, { usage: { inputTokens: 40, outputTokens: 2 } });
  assert.deepEqual(f.engine.get(r.id).usage, {
    inputTokens: 40,
    outputTokens: 2,
    totalTokens: 42,
  });
});

test("a passing verdict requiring human review cannot complete automatically", async (t) => {
  const f = fixture(t),
    r = await start(f);
  await f.end({ result: "pass", summary: "Review needed", requiresHuman: true });
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
});

test("unselected side-effect branches cannot publish a pull request", async (t) => {
  const f = fixture(t),
    snap = f.definitions.snapshot();
  snap.pipeline.graph.nodes.push(
    { id: "other", kind: "profile", profileId: "profile" },
    { id: "pr", kind: "createPr" },
  );
  snap.pipeline.graph.edges.push(
    { from: "build", to: "other", condition: "pass" },
    { from: "build", to: "pr", condition: "default" },
  );
  let published = 0;
  f.workspace.createPr = async () => {
    published++;
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  const r = await start(f);
  await f.end();
  assert.equal(f.engine.get(r.id).currentNodeId, "other");
  assert.equal(published, 0);
});

test("reconcile cannot promote a failed native turn using its valid pass verdict", async (t) => {
  const f = fixture(t),
    r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 7 });
  await assert.rejects(f.engine.gate(r.id, { action: "reconcile" }), { status: 409 });
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
});

test("a selected terminal gate does not fall through to the default profile branch", async (t) => {
  const f = fixture(t),
    snap = f.definitions.snapshot();
  snap.pipeline.graph.nodes.push(
    { id: "other", kind: "profile", profileId: "profile" },
    { id: "gate", kind: "gate" },
  );
  snap.pipeline.graph.edges.push(
    { from: "build", to: "other", condition: "default" },
    { from: "build", to: "gate", condition: "pass" },
  );
  const r = await start(f);
  await f.end();
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
  await f.engine.gate(r.id, { action: "accept" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(f.launches.length, 1);
});

test("explicit override checkpoints a stage without a valid verdict before completing", async (t) => {
  const f = fixture(t),
    r = await start(f);
  let checkpoints = 0;
  f.workspace.checkpoint = async () => ({ sha: "override" + ++checkpoints });
  for (let i = 0; i < 3; i++) await f.end({}, { nativeId: "native" });
  assert.equal(checkpoints, 0);
  await f.engine.gate(r.id, { action: "override" });
  const run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.executionLog.at(-1).endSha, "override1");
});

test("later stages refresh an existing pull request summary without duplicate native work", async (t) => {
  const f = fixture(t, { loop: true }),
    snap = f.definitions.snapshot();
  snap.pipeline.graph.nodes.push({ id: "pr", kind: "createPr" });
  snap.pipeline.graph.edges.find((e) => e.from === "build").to = "pr";
  snap.pipeline.graph.edges.push({ from: "pr", to: "review", condition: "default" });
  const summaries = [];
  f.workspace.createPr = async ({ run }) => {
    summaries.push(run.executionLog.filter((a) => a.verdict).length);
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  f.workspace.push = async () => {};
  await start(f);
  await f.end();
  await f.end();
  assert.deepEqual(summaries, [1, 2]);
  assert.equal(f.launches.length, 2);
});

test("failed verification repair does not reuse a passing verdict from the previous turn", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "tests", command: "false", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  await f.end(
    { result: "pass", summary: "Original implementation" },
    { nativeId: "native" },
  );
  verify.jobs.set(verify.plans[0].id, {
    status: "timed-out",
    steps: [{ name: "tests", timedOut: true, exitCode: null }],
  });
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).nodes[0].verdict, undefined);
  f.outcomes.set(f.launches.at(-1).sessionId, { status: "failed", exitCode: 1 });
  await f.engine.reconcile();
  const run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "session-error");
  assert.equal(run.nodes[0].verdict, undefined);
  assert.equal(run.executionLog[0].verdict.summary, "Original implementation");
  assert.equal(run.executionLog[0].verdict.result, "pass");
});

test("explicit override advances a failed repair while preserving failed verification evidence", async (t) => {
  const f = fixture(t, { loop: true }),
    r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  const parked = f.engine.store.get(r.id);
  parked.nodes[0].verifyResult = { status: "fail", steps: [{ exitCode: 1 }] };
  f.engine.store.save(parked);
  let checkpoints = 0;
  f.workspace.checkpoint = async () => ({ sha: "override" + ++checkpoints });
  assert.ok(f.engine.get(r.id).actions.includes("override"));
  await f.engine.gate(r.id, { action: "override" });
  const run = f.engine.get(r.id);
  assert.equal(run.currentNodeId, "review");
  assert.equal(run.status, "running");
  assert.equal(run.nodes[0].overridden, true);
  assert.equal(run.nodes[0].gateDecision, "overridden");
  assert.ok(run.nodes[0].gateDecidedAt);
  assert.equal(run.nodes[0].verdict, undefined);
  assert.equal(run.nodes[0].verifyResult.status, "fail");
  assert.equal(run.executionLog[0].failReason, "session-error");
  assert.equal(run.executionLog[0].endSha, "override1");
  assert.equal(f.launches.length, 2);
});

test("failed-stage override checks live quiescence before changing the run", async (t) => {
  const f = fixture(t),
    r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  const parked = f.engine.get(r.id);
  for (const outcome of [
    { status: "running", quiesced: true },
    { status: "failed", quiesced: false },
    { status: "missing", quiesced: true },
  ]) {
    f.outcomes.set(f.launches[0].sessionId, outcome);
    await assert.rejects(f.engine.gate(r.id, { action: "override" }), { status: 409 });
    assert.deepEqual(f.engine.get(r.id), parked);
  }
});

test("failed-stage override retains selected forward PR effects", async (t) => {
  const f = fixture(t),
    snap = f.definitions.snapshot();
  snap.pipeline.graph.nodes.push({ id: "pr", kind: "createPr" });
  snap.pipeline.graph.edges.push({ from: "build", to: "pr", condition: "pass" });
  let published = 0;
  f.workspace.createPr = async () => {
    published++;
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(published, 1);
});

test("a failed launch offers retry without unusable native outcome decisions", async (t) => {
  const f = fixture(t);
  f.driver.start = async () => {
    throw Error("CLI version probe failed");
  };
  const r = await start(f);
  const run = f.engine.get(r.id);
  assert.equal(run.executionLog[0].status, "launching");
  assert.equal(run.status, "awaiting-human");
  assert.deepEqual(run.actions, ["abort", "retry"]);
  f.driver.start = async (input) => ({ sessionId: input.sessionId });
  await f.engine.retry(r.id);
  assert.equal(f.engine.get(r.id).status, "running");
  assert.equal(f.engine.get(r.id).executionLog.length, 2);
});
