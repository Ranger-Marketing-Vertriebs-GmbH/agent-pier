import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";

// The repair and feedback paths above a run's token budget: each new turn waits at the
// budget gate with exactly the options it would have started with.
const node = (run, id) => run.nodes.find((n) => n.id === id);
const tokens = (n, extra = {}) => ({
  usage: { inputTokens: n, outputTokens: 0 },
  ...extra,
});
const pass = (summary) => ({ result: "pass", summary, findings: [] });
const fail = (title) => ({
  result: "fail",
  summary: `Found ${title}`,
  findings: [{ severity: "high", title }],
});
function withBudget(f, budget, graph) {
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.tokenBudget = budget;
    if (graph) snapshot.pipeline.graph = graph;
    return snapshot;
  };
  return f;
}
const start = (f) =>
  f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });

for (const continueSession of [false, true])
  test(`a loop back above the budget waits, survives a restart and repairs once (continueSession: ${continueSession})`, async (t) => {
    const f = withBudget(fixture(t), 120, {
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
    });
    const run = await start(f);
    await f.end(pass("Built"), tokens(50, { nativeId: "native-build" }));
    await f.end(fail("Bug"), tokens(100, { nativeId: "native-review" }));
    const held = f.engine.get(run.id);
    assert.equal(f.launches.length, 2);
    assert.equal(held.currentNodeId, "build");
    assert.equal(node(held, "build").failReason, "budget-exceeded");
    // The round is recorded and counted once, before the repair turn waits.
    assert.equal(held.loopState["review->build"].iterations, 1);
    assert.equal(held.loopRounds.length, 1);
    assert.equal(node(held, "build").loop.iteration, 1);

    await f.restart();
    await f.engine.reconcile();
    assert.equal(f.launches.length, 2, "a restart starts nothing while held");

    await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 1000 });
    const repair = f.launches.at(-1);
    assert.equal(f.launches.length, 3);
    assert.equal(repair.nodeId, "build");
    if (continueSession) {
      assert.equal(repair.kind, "resumed-repair");
      assert.equal(repair.resumeNativeId, "native-build");
    } else {
      assert.equal(repair.kind, "kickoff");
      assert.equal(repair.resumeNativeId, undefined);
    }
    const resumed = f.engine.get(run.id);
    assert.equal(resumed.executionLog.at(-1).repair.round, 1);
    assert.equal(resumed.loopState["review->build"].iterations, 1);
    // A second click finds no budget gate any more.
    await assert.rejects(
      f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 2000 }),
      { status: 409 },
    );
    assert.equal(f.launches.length, 3);
  });

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

test("verification still runs above the budget and its repair turn waits", async (t) => {
  const verify = verifier();
  const f = withBudget(fixture(t, { verification: true, verify }), 100);
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "false", timeoutMs: 1000, blocking: true }],
  });
  const run = await start(f);
  await f.end(pass("Built"), tokens(150, { nativeId: "native-build" }));
  assert.equal(verify.plans.length, 1, "verification spends no tokens and runs");
  verify.jobs.set(verify.plans[0].id, {
    status: "fail",
    steps: [{ name: "check", exitCode: 1 }],
  });
  await f.engine.reconcile();
  const held = f.engine.get(run.id);
  assert.equal(f.launches.length, 1);
  assert.equal(node(held, "build").failReason, "budget-exceeded");
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 1000 });
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].kind, "verify-feedback");
  assert.equal(f.launches[1].resumeNativeId, "native-build");
  assert.match(f.launches[1].prompt, /check/);
});

test("gate feedback above the budget waits and is sent after raising", async (t) => {
  const f = withBudget(fixture(t, { gate: true }), 100);
  const run = await start(f);
  await f.end(pass("Built"), tokens(150, { nativeId: "native-build" }));
  const gate = f.engine.get(run.id);
  // A human gate is no turn: the run waits there as usual.
  assert.equal(node(gate, "build").status, "awaiting-gate");
  assert.ok(gate.actions.includes("feedback"));
  await f.engine.gate(run.id, { action: "feedback", feedback: "Rename the helper" });
  const held = f.engine.get(run.id);
  assert.equal(f.launches.length, 1);
  assert.equal(node(held, "build").failReason, "budget-exceeded");
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 500 });
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].kind, "gate-feedback");
  assert.equal(f.launches[1].resumeNativeId, "native-build");
  assert.match(f.launches[1].prompt, /Rename the helper/);
});

test("an invalid stored pipeline budget counts as none and never blocks a start", async (t) => {
  const f = withBudget(fixture(t), 0);
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const run = await start(f);
  assert.equal(run.tokenBudget, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid token budget/);
});
