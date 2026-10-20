import test from "node:test";
import assert from "node:assert/strict";
import { groupFixture, pass, fail } from "../helpers/pipeline-group.js";

const node = (run, id) => run.nodes.find((n) => n.id === id);
const launchesOf = (f, id) => f.launches.filter((l) => l.nodeId === id);

test("members start together and the group passes once every member passed", async (t) => {
  const { f, finish, start } = groupFixture(t, {
    options: { portRange: { start: 20100, end: 20199 }, portProbe: async () => true },
  });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"), { usage: { inputTokens: 10, outputTokens: 5 } });
  assert.equal(current().currentNodeId, "review");
  assert.deepEqual(Object.keys(current().activeTurns).sort(), ["code", "security"]);
  // Each member turn leases its own port block and report directory.
  const [security, code] = ["security", "code"].map((id) => launchesOf(f, id)[0]);
  assert.notEqual(security.ports.base, code.ports.base);
  const log = current().executionLog;
  const turns = ["security", "code"].map((id) => log.find((a) => a.nodeId === id));
  assert.notEqual(turns[0].reportDir, turns[1].reportDir);
  assert.match(turns[0].reportDir, /^\.pipeline\/reports\/security\//);
  const group = log.find((a) => a.kind === "group");
  assert.equal(current().currentAttemptId, group.id);
  assert.equal(turns[0].groupAttemptId, group.id);

  await finish("security", pass("No issues"), {
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  assert.equal(current().status, "running");
  assert.equal(node(current(), "security").status, "reported");
  assert.deepEqual(Object.keys(current().activeTurns), ["code"]);
  await finish("code", pass("Clean", [{ severity: "low", title: "Naming" }]));
  const done = current();
  assert.equal(done.status, "completed");
  assert.equal(node(done, "review").status, "passed");
  assert.equal(node(done, "review").verdict.result, "pass");
  assert.deepEqual(node(done, "review").verdict.findings, [
    { severity: "low", title: "Naming", member: "code", profile: "Code" },
  ]);
  assert.deepEqual(done.activeTurns, {});
  assert.equal(done.usage.totalTokens, 17);
});

test("one failing member sends the run back once with every member's findings", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("code", pass("Looks fine", [{ severity: "low", title: "Typo" }]));
  await finish("security", fail("Injection"));
  const looped = current();
  assert.equal(looped.executionLog.at(-1).nodeId, "build");
  assert.equal(looped.loopRounds.length, 1);
  const round = looped.loopRounds[0];
  assert.equal(round.fromNodeId, "review");
  // One round, the failing member first; ids number across the whole group.
  assert.deepEqual(
    round.stages.map((s) => [s.nodeId, s.result, s.findings.map((x) => x.id)]),
    [
      ["security", "fail", ["R1-1"]],
      ["code", "pass", ["R1-2"]],
    ],
  );
  // The loop reset the group and its members; the repair prompt names both lenses.
  for (const id of ["review", "security", "code"])
    assert.equal(node(looped, id).status, "pending");
  assert.match(f.launches.at(-1).prompt, /Injection/);
  assert.match(f.launches.at(-1).prompt, /Typo/);
  await finish("build", {
    ...pass("Repaired"),
    responses: [
      { finding: "R1-1", status: "fixed" },
      { finding: "R1-2", status: "fixed" },
    ],
  });
  // Both members review again, each with the answers to its own round findings.
  assert.equal(launchesOf(f, "security").length, 2);
  assert.match(launchesOf(f, "security").at(-1).prompt, /Answers of the repair turn/);
  assert.match(launchesOf(f, "code").at(-1).prompt, /Answers of the repair turn/);
  await finish("security", pass("Fixed"));
  await finish("code", pass("Fine"));
  assert.equal(current().status, "completed");
});

test("low-only findings pass per member, but not because of another member's", async (t) => {
  const { f, finish, start } = groupFixture(t, { loop: false });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("security", { result: "fail", summary: "Nothing to show", findings: [] });
  await finish("code", pass("Fine", [{ severity: "low", title: "Nit" }]));
  // Without a loop a failing member escalates the group at its gate.
  const parked = current();
  assert.equal(parked.status, "awaiting-human");
  assert.equal(node(parked, "review").failReason, "verdict-fail");
  assert.equal(node(parked, "review").verdict.result, "fail");
  assert.ok(parked.actions.includes("override"));
});

test("a member without a verdict blocks the group until the owner overrides it", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("security");
  await finish("security");
  // Two nudges, then the member waits for a decision; its sibling keeps going.
  assert.equal(launchesOf(f, "security").length, 3);
  assert.equal(launchesOf(f, "security")[1].kind, "verdict-nudge");
  await finish("security");
  assert.equal(node(current(), "security").failReason, "verdict-missing");
  assert.equal(current().status, "running");
  assert.deepEqual(current().memberActions, { security: ["override"] });
  await finish("code", pass("Fine"));
  const parked = current();
  assert.equal(parked.status, "awaiting-human");
  assert.equal(node(parked, "review").failReason, "members-blocked");
  assert.ok(parked.actions.includes("retry"));
  await f.engine.gate(run.id, { action: "override", nodeId: "security" });
  const done = current();
  assert.equal(done.status, "completed");
  assert.equal(node(done, "security").overridden, true);
  assert.equal(node(done, "security").gateDecision, "overridden");
  assert.deepEqual(
    node(done, "review").verdict.members.map((m) => [m.nodeId, m.passes]),
    [
      ["security", true],
      ["code", true],
    ],
  );
});

test("a crashed member is retried on its own and the others keep their verdicts", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("code", pass("Fine"));
  await finish("security", null, { status: "failed", exitCode: 1, isError: true });
  const parked = current();
  assert.equal(node(parked, "security").failReason, "session-error");
  assert.equal(node(parked, "review").failReason, "members-blocked");
  assert.ok(parked.memberActions.security.includes("retry"));
  assert.ok(parked.memberActions.security.includes("override"));
  await assert.rejects(
    f.engine.gate(run.id, { action: "feedback", nodeId: "security", feedback: "x" }),
    { status: 409 },
  );
  await f.engine.gate(run.id, { action: "retry", nodeId: "security" });
  assert.equal(current().status, "running");
  assert.equal(launchesOf(f, "security").length, 2);
  assert.equal(launchesOf(f, "code").length, 1, "a reported member is not run again");
  await finish("security", pass("Fine now"));
  assert.equal(current().status, "completed");
});

test("the group retry starts every blocked member again", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  await finish("build", pass("Built"));
  await finish("code", null, { status: "failed", exitCode: 1, isError: true });
  await finish("security", null, { status: "failed", exitCode: 1, isError: true });
  assert.equal(f.engine.get(run.id).status, "awaiting-human");
  await f.engine.retry(run.id);
  assert.equal(launchesOf(f, "code").length, 2);
  assert.equal(launchesOf(f, "security").length, 2);
  await finish("code", pass());
  await finish("security", pass());
  assert.equal(f.engine.get(run.id).status, "completed");
});

test("a restart mid-group settles every running member without launching again", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  await finish("build", pass("Built"));
  await finish("code", pass("Fine"));
  const launched = f.launches.length;
  await f.restart();
  assert.equal(f.launches.length, launched);
  assert.deepEqual(Object.keys(f.engine.get(run.id).activeTurns), ["security"]);
  await finish("security", pass("Fine"));
  assert.equal(f.engine.get(run.id).status, "completed");
});

test("a member launch interrupted by a restart starts after it", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  await finish("build", pass("Built"));
  // As if the engine stopped after queuing a member's verdict nudge.
  const stored = f.engine.store.get(run.id);
  node(stored, "security").queuedTurn = { kind: "kickoff", feedback: "" };
  delete stored.activeTurns.security;
  f.engine.store.save(stored);
  await f.restart();
  assert.equal(launchesOf(f, "security").length, 2);
  await finish("security", pass());
  await finish("code", pass());
  assert.equal(f.engine.get(run.id).status, "completed");
});

test("cancelling stops every member's turn", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const cancelled = [];
  const cancel = f.driver.cancel;
  f.driver.cancel = async (input) => {
    cancelled.push(input.nodeId);
    return cancel(input);
  };
  const run = await start();
  await finish("build", pass("Built"));
  await f.engine.cancel(run.id);
  const done = f.engine.get(run.id);
  assert.deepEqual(cancelled.sort(), ["code", "security"]);
  assert.equal(done.status, "cancelled");
  assert.deepEqual(done.activeTurns, {});
  for (const id of ["review", "security", "code"])
    assert.equal(node(done, id).status, "cancelled");
  for (const entry of done.executionLog.filter((a) => a.nodeId !== "build"))
    assert.equal(entry.status, "cancelled");
});

test("the concurrency cap starts members one after another", async (t) => {
  const { f, finish, start } = groupFixture(t, {
    concurrency: 1,
    members: ["security", "code", "ux"],
  });
  const run = await start();
  await finish("build", pass("Built"));
  assert.deepEqual(Object.keys(f.engine.get(run.id).activeTurns), ["security"]);
  await finish("security", pass());
  assert.deepEqual(Object.keys(f.engine.get(run.id).activeTurns), ["code"]);
  await finish("code", pass());
  await finish("ux", pass());
  assert.equal(f.engine.get(run.id).status, "completed");
});

test("a usage limit parks the whole group and resuming starts only that member", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("security", null, {
    status: "failed",
    exitCode: 1,
    isError: true,
    usageLimit: { resetAt: 4102444800 },
  });
  assert.equal(current().status, "running", "the sibling keeps working");
  await finish("code", pass());
  const parked = current();
  assert.equal(node(parked, "review").failReason, "usage-limit-exceeded");
  assert.equal(parked.usageResumeAt, new Date(4102444800 * 1000 + 60000).toISOString());
  assert.ok(parked.actions.includes("resume-now"));
  await f.engine.gate(run.id, { action: "resume-now" });
  assert.equal(launchesOf(f, "security").length, 2);
  assert.equal(launchesOf(f, "code").length, 1);
  await finish("security", pass());
  assert.equal(current().status, "completed");
});

test("a member that changed the worktree stops the group for the owner", async (t) => {
  let head = 0;
  const { f, finish, start } = groupFixture(t);
  f.workspace.checkpoint = async () => ({ sha: `sha-${head}` });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("security", pass());
  head = 1; // a member committed or left changes
  await finish("code", fail("Bug"));
  const parked = current();
  assert.equal(node(parked, "review").failReason, "group-changed-files");
  assert.equal(node(parked, "review").status, "awaiting-gate");
  // Accepting the changes concludes with the joined verdict: a failure still loops.
  await f.engine.gate(run.id, { action: "override" });
  assert.equal(current().executionLog.at(-1).nodeId, "build");
  assert.equal(current().loopRounds.length, 1);
});

test("a member's late verdict is reconciled on its own", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("code", pass());
  // The member's process exited cleanly but was not yet proven stopped.
  await finish("security", pass("Late but fine"), { status: "failed", isError: true });
  assert.ok(current().memberActions.security.includes("reconcile"));
  assert.equal(f.engine.verdictStatus(run.id, "security").present, true);
  assert.throws(() => f.engine.verdictStatus(run.id, "build"), { status: 404 });
  const launch = launchesOf(f, "security").at(-1);
  f.outcomes.set(launch.sessionId, { status: "completed", exitCode: 0, quiesced: true });
  await f.engine.gate(run.id, { action: "reconcile", nodeId: "security" });
  assert.equal(current().status, "completed");
  assert.equal(node(current(), "security").verdict.summary, "Late but fine");
});

test("the risk check runs once when the group concludes, never per member", async (t) => {
  const { f, finish, start } = groupFixture(t);
  let checks = 0;
  f.workspace.checkpoint = async () => ({ sha: "head" });
  f.workspace.changes = async () => {
    checks++;
    return { changes: [] };
  };
  f.workspace.fileAt = async () => null;
  const run = await start();
  await finish("build", pass("Built"));
  assert.equal(checks, 1);
  await finish("security", pass());
  assert.equal(checks, 1);
  await finish("code", pass());
  assert.equal(checks, 2);
  assert.equal(f.engine.get(run.id).status, "completed");
});
