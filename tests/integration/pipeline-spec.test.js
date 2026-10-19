import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SPEC, met, started } from "../helpers/pipeline-spec.js";

test("the spec reaches every later stage by path and its criteria bind the implementer", async (t) => {
  const { f, current, turn, writeSpec } = await started(t);
  const file = await writeSpec();
  const spec = current().spec;
  assert.equal(spec.path, file);
  assert.equal(spec.nodeId, "spec");
  assert.equal(spec.source, "stage");
  assert.equal(spec.frozen, true);
  assert.deepEqual(
    spec.criteria.map((c) => [c.id, c.text, c.verify]),
    [
      ["AC1", "Empty input is rejected.", "npm test -- validation"],
      ["AC2", "Valid input is stored.", "open the list"],
    ],
  );
  assert.deepEqual(
    spec.assumptions.map((a) => [a.id, a.productDecision]),
    [
      ["A1", true],
      ["A2", false],
    ],
  );
  // The implementer is told the path and asked for every criterion.
  const build = f.launches.at(-1);
  assert.equal(build.nodeId, "build");
  assert.ok(build.prompt.includes(`Spec: ${file} is the contract of this run`));
  assert.match(build.prompt, /"id":"AC2","criterion":"Valid input is stored\."/);
  assert.match(build.prompt, /report every acceptance criterion in "criteria"/);
  // Criteria it leaves out are asked for once; an unknown id is dropped.
  await f.end({
    result: "pass",
    summary: "Built",
    criteria: [met("AC1"), met("AC7")],
  });
  assert.equal(turn().kind, "verdict-nudge");
  assert.match(
    f.launches.at(-1).prompt,
    /does not report these acceptance criteria.*AC2/,
  );
  await f.end({ result: "pass", summary: "Built", criteria: [met("AC1"), met("AC2")] });
  const built = current().executionLog.findLast((a) => a.nodeId === "build");
  assert.deepEqual(
    built.verdict.criteria.map((c) => c.criterion),
    ["AC1", "AC2"],
  );
  // The reviewer gets the same contract and references criteria by number.
  const review = f.launches.at(-1);
  assert.equal(review.nodeId, "review");
  assert.ok(review.prompt.includes(`Spec: ${file}`));
  assert.match(review.prompt, /each acceptance criterion you implemented or checked/);
  await f.end({
    result: "pass",
    summary: "Reviewed",
    findings: [{ severity: "low", title: "Naming", criterion: "ac-2" }],
    criteria: [{ criterion: "2", status: "not-met", evidence: "list empty" }],
  });
  const reviewed = current().nodes.find((n) => n.id === "review").verdict;
  assert.equal(reviewed.findings[0].criterion, "AC2");
  assert.deepEqual(reviewed.criteria, [
    { criterion: "AC2", status: "not-met", evidence: "list empty" },
  ]);
  assert.equal(current().status, "completed");
});

test("the frozen spec survives loop-back and a rewrite by a later stage is reverted", async (t) => {
  const { f, current, write, read, writeSpec } = await started(t);
  const file = await writeSpec();
  write(file, "# Spec\n\n## Acceptance criteria\n1. Anything goes.\n");
  await f.end({ result: "pass", summary: "Built", criteria: [met("AC1"), met("AC2")] });
  // The builder's rewrite is reverted when its turn ends and recorded against it.
  assert.equal(read(file), SPEC);
  const build = current().executionLog.findLast((a) => a.nodeId === "build");
  assert.equal(build.specChanged, "restored");
  const [change] = current().spec.changes;
  assert.deepEqual(
    [change.source, change.nodeId, change.attemptId, change.restored],
    ["turn", "build", build.attemptId, true],
  );
  assert.match(change.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(change.sha256, current().spec.sha256);
  // A spec the builder declares after the freeze changes nothing.
  await f.end({
    result: "fail",
    summary: "Review failed",
    findings: [{ severity: "high", title: "AC1 not covered", criterion: "AC1" }],
  });
  const repair = f.launches.at(-1);
  assert.equal(repair.nodeId, "build");
  assert.ok(repair.prompt.includes(`Spec: ${file}`));
  assert.match(repair.prompt, /"criterion":"AC1"/);
  const round = current().loopRounds.at(-1);
  assert.equal(round.stages[0].findings[0].criterion, "AC1");
  // A file deleted between turns is restored before the next turn reads it.
  fs.rmSync(path.join(current().workingDir, file));
  const other = `${current().executionLog.at(-1).reportDir}/spec.md`;
  write(other, "# Spec\n\n## Acceptance criteria\n1. Other.\n");
  await f.end({
    result: "pass",
    summary: "Repaired",
    criteria: [met("AC1"), met("AC2")],
    responses: [{ finding: "R1-1", status: "fixed" }],
    artifacts: [{ path: other, role: "spec" }],
  });
  assert.equal(read(file), SPEC);
  const repaired = current().executionLog.findLast((a) => a.nodeId === "build");
  assert.equal(repaired.specIgnored, true);
  assert.equal(current().spec.path, file);
  assert.equal(current().spec.revisions.length, 1);
});

test("a resumed repair turn is handed the spec too", async (t) => {
  const { f, writeSpec } = await started(t, { continueSession: true });
  const file = await writeSpec();
  await f.end(
    { result: "pass", summary: "Built", criteria: [met("AC1"), met("AC2")] },
    { nativeId: "native-build" },
  );
  await f.end({ result: "fail", summary: "No", findings: [{ title: "Broken" }] });
  const repair = f.launches.at(-1);
  assert.equal(repair.kind, "resumed-repair");
  assert.ok(repair.prompt.includes(`Spec: ${file}`));
  assert.match(repair.prompt, /report every acceptance criterion/);
});

test("an unusable spec asks the spec stage again", async (t) => {
  const { f, current, turn, write, writeSpec } = await started(t);
  await writeSpec("# Spec\n\n## Requirements\n- Something\n");
  assert.equal(turn().kind, "verdict-nudge");
  assert.equal(current().spec, undefined);
  assert.match(f.launches.at(-1).prompt, /Acceptance criteria/);
  // A spec outside the stage's report area does not count either.
  write("spec.md", SPEC);
  await f.end({
    result: "pass",
    summary: "Spec",
    artifacts: [{ path: "spec.md", role: "spec" }],
  });
  assert.equal(turn().kind, "verdict-nudge");
  await writeSpec();
  assert.equal(current().spec.criteria.length, 2);
  assert.equal(turn().nodeId, "build");
});

test("the spec gate shows the spec and the owner's decision can replace it", async (t) => {
  const { f, run, current, turn, read, writeSpec } = await started(t, { gate: true });
  const file = await writeSpec(SPEC, { nativeId: "native-spec" });
  assert.equal(current().status, "awaiting-human");
  assert.equal(current().spec.frozen, false);
  assert.ok(current().actions.includes("replace-spec"));
  // Feedback at the gate lets the spec stage rewrite its draft.
  await f.engine.gate(run.id, { action: "feedback", feedback: "Add a criterion" });
  const rewritten = `${turn().reportDir}/spec.md`;
  fs.writeFileSync(
    path.join(current().workingDir, rewritten),
    `${SPEC.replace("2. Valid", "2. Saved input is listed.\n3. Valid")}`,
  );
  await f.end({
    result: "pass",
    summary: "Spec rewritten",
    artifacts: [{ path: rewritten, role: "spec" }],
  });
  assert.equal(current().spec.path, rewritten);
  assert.equal(current().spec.criteria.length, 3);
  // The owner replaces the text directly; the gate keeps waiting.
  await assert.rejects(
    f.engine.gate(run.id, { action: "replace-spec", spec: "no criteria" }),
    { status: 400 },
  );
  const owned = "# Spec\n\n## Acceptance criteria\n1. Owner criterion. Verify: run it\n";
  await f.engine.gate(run.id, { action: "replace-spec", spec: owned });
  assert.equal(current().status, "awaiting-human");
  // The owner's text is a revision of its own; the stage's reports stay untouched.
  const owner = current().spec.revisions.at(-1);
  assert.equal(owner.path, ".pipeline/spec/owner-3/spec.md");
  assert.equal(current().spec.path, owner.path);
  assert.equal(read(owner.path), owned);
  assert.notEqual(read(rewritten), owned);
  assert.equal(current().spec.source, "owner");
  assert.deepEqual(
    current().spec.criteria.map((c) => c.id),
    ["AC1"],
  );
  assert.deepEqual(
    current().spec.revisions.map((r) => [r.n, r.source, r.path]),
    [
      [1, "stage", file],
      [2, "stage", rewritten],
      [3, "owner", owner.path],
    ],
  );
  assert.equal(read(file), SPEC);
  // Every revision stays readable with the text it had.
  assert.equal(f.engine.specRevision(run.id, 1).text, SPEC);
  assert.equal(f.engine.specRevision(run.id, 3).text, owned);
  assert.throws(() => f.engine.specRevision(run.id, 9), { status: 404 });
  await f.engine.gate(run.id, { action: "accept" });
  const build = f.launches.at(-1);
  assert.equal(build.nodeId, "build");
  assert.ok(build.prompt.includes(`Spec: ${owner.path}`));
  assert.match(build.prompt, /replaced by the owner/);
  assert.match(build.prompt, /Owner criterion/);
  assert.equal(current().spec.frozen, true);
});
