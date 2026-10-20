import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
import { groupFixture, pass } from "../helpers/pipeline-group.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const node = (run, id) => run.nodes.find((n) => n.id === id);
const launchesOf = (f, id) => f.launches.filter((l) => l.nodeId === id);
const tokens = (n) => ({ usage: { inputTokens: n - 1, outputTokens: 1 } });

// build -> review with the definition's token budget; `audit` collects audit entries as
// the audit log stores them.
function budgetFixture(t, budget) {
  const audit = [];
  const f = fixture(t, {
    loop: true,
    options: { audit: { append: (entry) => audit.push(auditEvent(entry)) } },
  });
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    if (budget !== undefined) snapshot.pipeline.tokenBudget = budget;
    return snapshot;
  };
  const start = (input = {}) =>
    f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Build", ...input });
  return { f, audit, start };
}

test("the turn that crosses the budget finishes and the next turn waits", async (t) => {
  const { f, audit, start } = budgetFixture(t, 100);
  const run = await start();
  assert.equal(run.tokenBudget, 100);
  await f.end(pass("Built"), tokens(150));
  const parked = f.engine.get(run.id);
  // The build stage concluded; review would start next and waits for the owner.
  assert.equal(node(parked, "build").status, "passed");
  assert.equal(launchesOf(f, "review").length, 0);
  assert.equal(parked.status, "awaiting-human");
  assert.equal(parked.currentNodeId, "review");
  assert.equal(node(parked, "review").status, "awaiting-gate");
  assert.equal(node(parked, "review").failReason, "budget-exceeded");
  assert.deepEqual(parked.actions, ["abort", "raise-budget"]);
  assert.deepEqual(parked.activeTurns, {});
  // Reconciling does not start the held turn on its own.
  await f.engine.reconcile();
  assert.equal(launchesOf(f, "review").length, 0);

  // The new budget must lie above the tokens reported so far.
  for (const tokenBudget of [undefined, 150, 0, 1.5, "1000", 1_000_000_001])
    await assert.rejects(f.engine.gate(run.id, { action: "raise-budget", tokenBudget }), {
      status: 400,
    });
  assert.equal(f.engine.get(run.id).tokenBudget, 100);

  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 1000 });
  const resumed = f.engine.get(run.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.tokenBudget, 1000);
  assert.equal(launchesOf(f, "review").length, 1);
  assert.equal(launchesOf(f, "review")[0].kind, "kickoff");
  assert.equal(node(resumed, "review").failReason, undefined);
  assert.deepEqual(
    resumed.budgetRaises.map(({ from, to, used }) => ({ from, to, used })),
    [{ from: 100, to: 1000, used: 150 }],
  );
  assert.deepEqual(audit.at(-1).details, {
    kind: "budget",
    stageId: "review",
    from: 100,
    to: 1000,
    usedTokens: 150,
  });
  assert.equal(audit.at(-1).action, "pipeline.updated");
  await f.end(pass("Reviewed"), tokens(10));
  assert.equal(f.engine.get(run.id).status, "completed");
});

test("usage that only reaches the budget keeps the run going", async (t) => {
  const { f, start } = budgetFixture(t, 100);
  const run = await start();
  await f.end(pass("Built"), tokens(100));
  assert.equal(f.engine.get(run.id).status, "running");
  assert.equal(launchesOf(f, "review").length, 1);
});

test("a run without a budget, or whose turns report no usage, never waits", async (t) => {
  const { f, start } = budgetFixture(t);
  const run = await start();
  assert.equal(run.tokenBudget, null);
  await f.end(pass("Built"), tokens(10_000_000));
  assert.equal(launchesOf(f, "review").length, 1);

  const other = budgetFixture(t, 10);
  const unreported = await other.start();
  await other.f.end(pass("Built"));
  assert.equal(other.f.engine.get(unreported.id).usage, null);
  assert.equal(launchesOf(other.f, "review").length, 1);
});

test("a budget given at the start replaces the definition's and is validated", async (t) => {
  const { f, start } = budgetFixture(t, 100);
  const run = await start({ tokenBudget: 5000 });
  assert.equal(run.tokenBudget, 5000);
  await f.end(pass("Built"), tokens(150));
  assert.equal(launchesOf(f, "review").length, 1);
  for (const tokenBudget of [0, -1, 2.5, "100", 1_000_000_001])
    await assert.rejects(start({ tokenBudget }), { status: 400 });
});

test("a verdict nudge after the crossing turn waits and continues in its session", async (t) => {
  const { f, start } = budgetFixture(t, 100);
  const run = await start();
  // The turn ends without a verdict: its nudge would be a new turn.
  f.outcomes.set(f.launches[0].sessionId, {
    status: "completed",
    exitCode: 0,
    nativeId: "native-1",
    ...tokens(150),
  });
  await f.engine.reconcile();
  const parked = f.engine.get(run.id);
  assert.equal(f.launches.length, 1);
  assert.equal(parked.currentNodeId, "build");
  assert.equal(node(parked, "build").failReason, "budget-exceeded");
  // The finished turn keeps its own record; only the next turn is held.
  assert.equal(parked.executionLog[0].failReason, undefined);
  assert.deepEqual(parked.executionLog[0].usage, tokens(150).usage);
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 300 });
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1].kind, "verdict-nudge");
  assert.equal(f.launches[1].resumeNativeId, "native-1");
});

test("an unattended resume after a usage limit waits above the budget", async (t) => {
  let now = Date.now();
  const f = fixture(t, { clock: { now: () => now } });
  f.definitions.snapshot = ((original) => () => ({
    ...original(),
    pipeline: { ...original().pipeline, tokenBudget: 100 },
  }))(f.definitions.snapshot);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "T" });
  await f.end(undefined, {
    status: "failed",
    exitCode: 1,
    usageLimit: { resetAt: Math.floor(now / 1000) + 10 },
    ...tokens(150),
  });
  const limited = f.engine.get(run.id);
  assert.equal(node(limited, "build").failReason, "usage-limit-exceeded");
  // The provider's reset passes: resuming unattended would spend above the budget.
  now = Date.parse(limited.usageResumeAt) + 1;
  await f.engine.reconcile();
  assert.equal(f.launches.length, 1);
  const held = f.engine.get(run.id);
  assert.equal(node(held, "build").failReason, "budget-exceeded");
  assert.equal(held.usageResumeAt, null);
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 500 });
  assert.equal(f.launches.length, 2);
  assert.equal(f.engine.get(run.id).status, "running");
});

// build -> review (security, code) with a budget of 100 tokens.
function budgetGroup(t) {
  const group = groupFixture(t);
  const original = group.f.definitions.snapshot;
  group.f.definitions.snapshot = () => ({
    ...original(),
    pipeline: { ...original().pipeline, tokenBudget: 100 },
  });
  return group;
}

test("a member's verdict nudge above the budget waits with the group", async (t) => {
  const { f, finish, start } = budgetGroup(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"), tokens(10));
  await finish("security", null, { ...tokens(200), nativeId: "native-security" });
  assert.equal(node(current(), "security").status, "pending");
  assert.equal(launchesOf(f, "security").length, 1);
  await finish("code", pass(), tokens(5));
  assert.equal(node(current(), "review").failReason, "budget-exceeded");
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 1000 });
  const nudge = launchesOf(f, "security").at(-1);
  assert.equal(nudge.kind, "verdict-nudge");
  assert.equal(nudge.resumeNativeId, "native-security");
  await finish("security", pass());
  assert.equal(current().status, "completed");
});

test("resuming a group after a usage limit above the budget restarts only that member", async (t) => {
  const { f, finish, start } = budgetGroup(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"), tokens(10));
  await finish("security", null, {
    status: "failed",
    exitCode: 1,
    isError: true,
    usageLimit: { resetAt: 4102444800 },
    ...tokens(200),
  });
  await finish("code", null, { status: "failed", exitCode: 1, isError: true });
  assert.equal(node(current(), "review").failReason, "usage-limit-exceeded");
  await f.engine.gate(run.id, { action: "resume-now" });
  assert.equal(node(current(), "review").failReason, "budget-exceeded");
  assert.equal(launchesOf(f, "security").length, 1);
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 1000 });
  // Code failed for another reason and keeps waiting for its own decision.
  assert.equal(launchesOf(f, "security").length, 2);
  assert.equal(launchesOf(f, "code").length, 1);
  assert.equal(node(current(), "code").failReason, "session-error");
});

test("in a parallel group running members finish, no new member starts", async (t) => {
  const { f, finish } = groupFixture(t, {
    concurrency: 2,
    members: ["security", "code", "ux"],
  });
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => ({
    ...original(),
    pipeline: { ...original().pipeline, tokenBudget: 100 },
  });
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "T" });
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"), tokens(10));
  assert.deepEqual(Object.keys(current().activeTurns).sort(), ["code", "security"]);
  // Security crosses the budget; code keeps working and ux does not start.
  await finish("security", pass(), tokens(200));
  assert.equal(current().status, "running");
  assert.deepEqual(Object.keys(current().activeTurns), ["code"]);
  assert.equal(launchesOf(f, "ux").length, 0);
  await finish("code", pass(), tokens(5));
  const parked = current();
  assert.equal(parked.status, "awaiting-human");
  assert.equal(parked.currentNodeId, "review");
  assert.equal(node(parked, "review").failReason, "budget-exceeded");
  assert.equal(node(parked, "ux").status, "pending");
  assert.deepEqual(parked.actions, ["abort", "raise-budget"]);
  assert.deepEqual(parked.memberActions, {});
  await f.engine.gate(run.id, { action: "raise-budget", tokenBudget: 10_000 });
  assert.equal(launchesOf(f, "ux").length, 1);
  assert.equal(launchesOf(f, "security").length, 1);
  await finish("ux", pass(), tokens(5));
  const done = current();
  assert.equal(done.status, "completed");
  assert.equal(node(done, "review").verdict.result, "pass");
  assert.equal(done.usage.totalTokens, 220);
});

test("a group whose last member crosses the budget still joins", async (t) => {
  const { f, finish } = groupFixture(t);
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => ({
    ...original(),
    pipeline: { ...original().pipeline, tokenBudget: 100 },
  });
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "T" });
  await finish("build", pass("Built"), tokens(10));
  await finish("security", pass(), tokens(10));
  await finish("code", pass(), tokens(200));
  // No turn was left to start: the group joined and the run completed.
  assert.equal(f.engine.get(run.id).status, "completed");
});
