import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { SPEC, met, started } from "../helpers/pipeline-spec.js";

const OWNED = "# Spec\n\n## Acceptance criteria\n1. Owner criterion.\n2. Second.\n";
const both = [met("AC1"), met("AC2")];

test("an owner replacement is audited as a spec revision, not as a gate decision", async (t) => {
  const events = [];
  const { f, run, writeSpec } = await started(t, {
    gate: true,
    options: { audit: { append: (event) => events.push(event) } },
  });
  await writeSpec();
  await f.engine.gate(run.id, { action: "replace-spec", spec: OWNED });
  const spec = f.engine.get(run.id).spec;
  assert.deepEqual(events, [
    {
      action: "pipeline.updated",
      resourceType: "pipeline",
      resourceId: run.id,
      source: "user",
      outcome: "success",
      details: { kind: "spec", stageId: "spec", revision: 2, sha256: spec.sha256 },
    },
  ]);
  await f.engine.gate(run.id, { action: "accept" });
  assert.equal(events.length, 1);
  // The audit schema keeps the revision with the stage and the hash.
  assert.deepEqual(auditEvent(events[0]).details, events[0].details);
});

test("an imported history-only run shows its current spec, not earlier revisions", async (t) => {
  const { f, run, writeSpec } = await started(t, { gate: true });
  await writeSpec();
  await f.engine.gate(run.id, { action: "replace-spec", spec: OWNED });
  const stored = f.engine.store.get(run.id);
  stored.imported = { historyOnly: true };
  // The imported worktree path does not exist on this host.
  stored.workingDir = path.join(f.dir, "gone");
  f.engine.store.save(stored);
  assert.equal(f.engine.specRevision(run.id, 2).text, OWNED);
  assert.throws(() => f.engine.specRevision(run.id, 1), {
    status: 404,
    message: serverMessages.pipelines.specRevisionImported,
  });
});

test("the spec stage starts from the owner's replacement when it is asked again", async (t) => {
  const { f, run, current, turn, writeSpec } = await started(t, { gate: true });
  await writeSpec(SPEC, { nativeId: "native-spec" });
  await f.engine.gate(run.id, { action: "replace-spec", spec: OWNED });
  const owner = current().spec.path;
  await f.engine.gate(run.id, { action: "feedback", feedback: "Also cover X" });
  const prompt = f.launches.at(-1).prompt;
  assert.equal(turn().kind, "gate-feedback");
  assert.ok(prompt.includes(`Your current draft spec is ${owner}`));
  assert.match(prompt, /the owner replaced your earlier draft with it/);
  assert.match(prompt, /declare it with "role":"spec"/);
});

test("a draft edited in place must be declared again before it counts", async (t) => {
  const { f, run, current, turn, write, read, writeSpec } = await started(t, {
    gate: true,
  });
  const file = await writeSpec(SPEC, { nativeId: "native-spec" });
  await f.engine.gate(run.id, { action: "feedback", feedback: "Add a criterion" });
  write(file, `${SPEC}\n`.replace("2. Valid", "2. New.\n3. Valid"));
  await f.end({ result: "pass", summary: "Edited in place" });
  // The undeclared edit is not adopted silently; the stage is asked to declare it.
  assert.equal(turn().kind, "verdict-nudge");
  assert.ok(f.launches.at(-1).prompt.includes(serverMessages.pipelines.specRedeclare));
  const declared = `${turn().reportDir}/spec.md`;
  write(declared, read(file));
  await f.end({
    result: "pass",
    summary: "Declared",
    artifacts: [{ path: declared, role: "spec" }],
  });
  assert.equal(current().spec.criteria.length, 3);
  await f.engine.gate(run.id, { action: "accept" });
  // The freeze finds nothing to revert.
  assert.equal(current().spec.frozen, true);
  assert.equal(current().spec.changes, undefined);
});

test("after a rejected spec the owner can supply one at the stage's gate", async (t) => {
  const { f, run, current, turn, write } = await started(t);
  const bad = "# Spec\n\n## Requirements\n- none\n";
  for (let i = 0; i < 3; i++) {
    const file = `${turn().reportDir}/spec.md`;
    write(file, bad);
    await f.end({
      result: "pass",
      summary: "Spec",
      artifacts: [{ path: file, role: "spec" }],
    });
  }
  const node = current().nodes.find((n) => n.id === "spec");
  assert.equal(node.failReason, "verdict-invalid");
  assert.equal(current().spec, undefined);
  assert.ok(current().actions.includes("replace-spec"));
  await f.engine.gate(run.id, { action: "replace-spec", spec: OWNED });
  assert.equal(current().spec.nodeId, "spec");
  assert.equal(current().spec.source, "owner");
  await f.engine.gate(run.id, { action: "override" });
  const build = f.launches.at(-1);
  assert.equal(build.nodeId, "build");
  assert.ok(build.prompt.includes(`Spec: ${current().spec.path}`));
  assert.match(build.prompt, /Owner criterion/);
});

test("a spec changed by verification or by hand is restored and recorded with its source", async (t) => {
  const jobs = new Map();
  let edit = () => {};
  const verify = {
    async start(input) {
      jobs.set(input.id, { status: "running" });
      return { id: input.id };
    },
    async inspect() {
      edit();
      edit = () => {};
      return { status: "pass", steps: [{ name: "check", exitCode: 0 }] };
    },
    async cancel(job) {
      jobs.set(job.id, { status: "unavailable" });
    },
  };
  const { f, run, current, write, read, writeSpec } = await started(t, {
    verify,
    reviewGate: true,
  });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
  });
  const file = await writeSpec();
  edit = () => write(file, "changed by a check");
  await f.end({ result: "pass", summary: "Built", criteria: both });
  await f.engine.reconcile();
  assert.equal(read(file), SPEC);
  assert.deepEqual(
    current().spec.changes.map((c) => [c.source, c.nodeId, c.restored]),
    [["verification", undefined, true]],
  );
  // At the review's gate the owner edits the file by hand, then sends the run back.
  assert.equal(current().nodes.find((n) => n.id === "review").status, "running");
  await f.end({ result: "pass", summary: "Reviewed" });
  assert.equal(current().status, "awaiting-human");
  write(file, "edited by hand");
  await f.engine.gate(run.id, { action: "loop-back", feedback: "Again" });
  assert.equal(read(file), SPEC);
  assert.deepEqual(
    current().spec.changes.map((c) => c.source),
    ["verification", "manual"],
  );
});

test("a restore that cannot write records the failure", async (t) => {
  const { f, current, writeSpec } = await started(t);
  const file = await writeSpec();
  // The builder replaces the spec's directory with a link to elsewhere.
  const directory = path.join(current().workingDir, path.dirname(file));
  const elsewhere = path.join(f.dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.rmSync(directory, { recursive: true });
  fs.symlinkSync(elsewhere, directory);
  await f.end({ result: "pass", summary: "Built", criteria: both });
  const build = current().executionLog.findLast((a) => a.nodeId === "build");
  assert.equal(build.specChanged, "failed");
  assert.deepEqual(
    current().spec.changes.map((c) => [c.source, c.restored, c.sha256]),
    [["turn", false, null]],
  );
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  // The same obstacle on the next check is not recorded again.
  await f.end({ result: "fail", summary: "Review", findings: [{ title: "Broken" }] });
  assert.equal(current().spec.changes.length, 1);
  // Once the link is gone, the next check restores the spec.
  fs.rmSync(directory);
  await f.end({
    result: "pass",
    summary: "Repaired",
    criteria: both,
    responses: [{ finding: "R1-1", status: "fixed" }],
  });
  assert.equal(fs.readFileSync(path.join(current().workingDir, file), "utf8"), SPEC);
  assert.deepEqual(
    current().spec.changes.map((c) => [c.source, c.restored]),
    [
      ["turn", false],
      ["turn", true],
    ],
  );
});

test("a spec replaced by a link or a hard link is restored without writing through it", async (t) => {
  const { f, current, read, writeSpec } = await started(t);
  const file = await writeSpec();
  const target = path.join(current().workingDir, file);
  const outside = path.join(f.dir, "outside.md");
  fs.writeFileSync(outside, "outside");
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  await f.end({ result: "pass", summary: "Built", criteria: both });
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(read(file), SPEC);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  // A hard link to the spec would let a later write reach another file.
  const linked = path.join(f.dir, "linked.md");
  fs.linkSync(target, linked);
  fs.writeFileSync(linked, "through the link");
  await f.end({ result: "fail", summary: "Review", findings: [{ title: "Broken" }] });
  assert.equal(read(file), SPEC);
  assert.equal(fs.readFileSync(linked, "utf8"), "through the link");
  assert.deepEqual(
    current().spec.changes.map((c) => [c.source, c.restored]),
    [
      ["turn", true],
      ["turn", true],
    ],
  );
});
