import test from "node:test";
import assert from "node:assert/strict";
import { groupFixture, pass, fail } from "../helpers/pipeline-group.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const node = (run, id) => run.nodes.find((n) => n.id === id);
const launchesOf = (f, id) => f.launches.filter((l) => l.nodeId === id);
const ports = (free) => ({
  portRange: { start: 20100, end: 20199 },
  portProbe: async () => free(),
});

test("members that never started this round offer no turn of an earlier round", async (t) => {
  let free = true;
  const { f, finish, start } = groupFixture(t, { options: ports(() => free) });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("code", pass("Round one is fine"));
  await finish("security", fail("Hole"));
  free = false;
  await finish("build", {
    ...pass("Fixed"),
    responses: [{ finding: "R1-1", status: "fixed" }],
  });
  const parked = current();
  assert.equal(node(parked, "review").failReason, "members-blocked");
  assert.deepEqual(parked.memberActions, { security: ["retry"], code: ["retry"] });
  // Round one's verdicts never count for round two.
  await assert.rejects(f.engine.gate(run.id, { action: "reconcile", nodeId: "code" }), {
    status: 409,
  });
  assert.equal(f.engine.verdictStatus(run.id, "code").present, false);
  free = true;
  await f.engine.gate(run.id, { action: "retry", nodeId: "code" });
  await f.engine.gate(run.id, { action: "retry", nodeId: "security" });
  assert.equal(launchesOf(f, "code").length, 2);
  await finish("code", pass("Round two"));
  await finish("security", pass("Round two"));
  assert.equal(current().status, "completed");
});

test("a group override in round one accepts members without a turn and is audited", async (t) => {
  const events = [];
  let free = true;
  const { f, finish, start } = groupFixture(t, {
    options: { ...ports(() => free), audit: { append: (e) => events.push(e) } },
  });
  const run = await start();
  free = false;
  await finish("build", pass("Built"));
  const blocked = f.engine.get(run.id);
  assert.equal(node(blocked, "review").failReason, "members-blocked");
  assert.deepEqual(blocked.memberActions, { security: ["retry"], code: ["retry"] });
  // The override may name the group itself; it must not need a member turn.
  await f.engine.gate(run.id, { action: "override", nodeId: "review" });
  assert.equal(f.engine.get(run.id).status, "completed");
  const audit = events.find(
    (e) => e.action === "pipeline.overridden" && e.details.stageId === "review",
  );
  assert.deepEqual(audit.details.members, ["security", "code"]);
  assert.equal(audit.details.path, "members-pass");
});

test("a retry after a failed starting checkpoint records it and still guards the join", async (t) => {
  let head = 0,
    failStart = true;
  const { f, finish, start } = groupFixture(t);
  f.workspace.checkpoint = async ({ node: at, attempt }) => {
    if (at?.kind === "parallel" && !attempt && failStart) {
      failStart = false;
      throw Object.assign(Error("index.lock exists"), { status: 409 });
    }
    return { sha: `sha-${head}` };
  };
  const run = await start();
  await finish("build", pass("Built"));
  assert.equal(node(f.engine.get(run.id), "review").failReason, "session-error");
  await f.engine.retry(run.id);
  const attempt = f.engine.get(run.id).executionLog.find((a) => a.kind === "group");
  assert.equal(attempt.baseSha, "sha-0");
  await finish("security", pass());
  head = 1; // a member changed files
  await finish("code", pass());
  assert.equal(node(f.engine.get(run.id), "review").failReason, "group-changed-files");
});

test("a join without its starting commit stops for the owner", async (t) => {
  const { f, finish, start } = groupFixture(t);
  f.workspace.checkpoint = async () => ({ sha: "same" });
  const run = await start();
  await finish("build", pass("Built"));
  const stored = f.engine.store.get(run.id);
  delete stored.executionLog.find((a) => a.kind === "group").baseSha;
  f.engine.store.save(stored);
  await finish("security", pass());
  await finish("code", pass());
  const review = node(f.engine.get(run.id), "review");
  assert.equal(review.failReason, "group-changed-files");
  assert.equal(review.failDetail, serverMessages.pipelines.groupReadOnlyUnproven);
});

test("a launch interrupted during its starting checkpoint keeps one group attempt", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  await finish("build", pass("Built"));
  // As if the engine stopped after opening the group attempt, before any member.
  const stored = f.engine.store.get(run.id);
  stored.executionLog = stored.executionLog.filter((a) => !a.groupAttemptId);
  stored.activeTurns = {};
  for (const id of ["security", "code"]) node(stored, id).status = "pending";
  stored.pendingTurn = { nodeId: "review", kind: "kickoff" };
  f.engine.store.save(stored);
  await f.restart();
  const log = f.engine.get(run.id).executionLog;
  assert.equal(log.filter((a) => a.kind === "group").length, 1);
  assert.equal(log.find((a) => a.kind === "group").status, "running");
});

test("resuming after a usage limit starts only the members that hit it", async (t) => {
  const { f, finish, start } = groupFixture(t, { members: ["security", "code", "ux"] });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish("security", null, {
    status: "failed",
    exitCode: 1,
    isError: true,
    usageLimit: { resetAt: 4102444800 },
  });
  for (let i = 0; i < 3; i++) await finish("code");
  assert.equal(node(current(), "code").failReason, "verdict-missing");
  await finish("ux", pass());
  assert.equal(node(current(), "review").failReason, "usage-limit-exceeded");
  await f.engine.gate(run.id, { action: "resume-now" });
  assert.equal(launchesOf(f, "security").length, 2);
  assert.equal(launchesOf(f, "code").length, 3, "the member awaiting a decision waits");
  await finish("security", pass());
  assert.equal(node(current(), "review").failReason, "members-blocked");
  assert.deepEqual(current().memberActions, { code: ["override"] });
});

test("each member reviews the answers to the findings of its own lens", async (t) => {
  const { f, finish, start } = groupFixture(t);
  const run = await start();
  await finish("build", pass("Built"));
  await finish("security", fail("Injection"));
  await finish("code", fail("UXBUG"));
  const round = f.engine.get(run.id).loopRounds[0];
  const id = (title) =>
    round.stages.flatMap((s) => s.findings).find((x) => x.title === title).id;
  await finish("build", {
    ...pass("Repaired"),
    responses: [
      { finding: id("Injection"), status: "fixed" },
      { finding: id("UXBUG"), status: "disputed", reason: "Intended" },
    ],
  });
  const security = launchesOf(f, "security").at(-1).prompt;
  const code = launchesOf(f, "code").at(-1).prompt;
  assert.match(security, /"title":"Injection"/);
  assert.doesNotMatch(security, /UXBUG/);
  assert.match(security, /"otherMembers":\{"findings":1,"answered":1\}/);
  assert.match(code, /"title":"UXBUG"/);
  assert.match(code, /"reason":"Intended"/);
  assert.doesNotMatch(code, /Injection/);
});

test("a member's question is answered with feedback in its own session", async (t) => {
  const { f, finish, start } = groupFixture(t, { loop: false });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish(
    "security",
    { ...pass("Ask"), requiresHuman: true, question: "Is the token rotation intended?" },
    { nativeId: "native-security" },
  );
  await finish("code", pass());
  const parked = current();
  assert.equal(node(parked, "review").failReason, "verdict-fail");
  assert.equal(
    node(parked, "review").verdict.question,
    "Is the token rotation intended?",
  );
  assert.deepEqual(parked.memberActions, { security: ["feedback"] });
  await f.engine.gate(run.id, {
    action: "feedback",
    nodeId: "security",
    feedback: "Yes, it is intended.",
  });
  const turn = launchesOf(f, "security").at(-1);
  assert.equal(turn.kind, "gate-feedback");
  assert.equal(turn.resumeNativeId, "native-security");
  await finish("security", pass("Fine then"));
  assert.equal(current().status, "completed");
});

test("accepted member changes do not stop the group again after feedback", async (t) => {
  let head = 0;
  const { f, finish, start } = groupFixture(t, { loop: false });
  f.workspace.checkpoint = async () => ({ sha: `sha-${head}` });
  const run = await start();
  const current = () => f.engine.get(run.id);
  await finish("build", pass("Built"));
  await finish(
    "security",
    { ...pass("Ask"), requiresHuman: true, question: "Keep the new config?" },
    { nativeId: "native-security" },
  );
  head = 1; // a member changed files
  await finish("code", pass());
  assert.equal(node(current(), "review").failReason, "group-changed-files");
  await f.engine.gate(run.id, { action: "override" });
  assert.equal(node(current(), "review").failReason, "verdict-fail");
  await f.engine.gate(run.id, {
    action: "feedback",
    nodeId: "security",
    feedback: "Keep it.",
  });
  await finish("security", pass("Fine then"));
  assert.equal(current().status, "completed");
  // The accepted commit is where the group starts now; later changes still stop it.
  assert.equal(current().executionLog.find((a) => a.kind === "group").baseSha, "sha-1");
});
