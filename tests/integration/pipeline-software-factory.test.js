import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";
import { PipelineEngine } from "../../server/features/pipelines/pipeline-engine.js";

// The seeded "Software factory" pipeline end to end: the real definitions store with its
// seeds and default risk rules, a synthetic native driver and a workspace that reports
// the run's changes and records pull requests.
const SPEC = `# Spec

## Context
- src/app.js

## Requirements
- Validate input.

## Acceptance criteria
1. Empty input is rejected. Verify: npm test
2. Valid input is stored. Verify: npm test

## Out of scope
- Styling

## Assumptions
- The API stays the same.
`;
const MEMBERS = ["security", "code", "ux", "ui"];
const accounts = {
  get: (id) => ({ id, tool: id.slice(6), kind: "local", hasSecret: true }),
};
const met = ["AC1", "AC2"].map((criterion) => ({
  criterion,
  status: "met",
  evidence: "npm test passes",
}));
// The role instructions the native driver puts before the stage prompt.
const role = (launch) => launch.profileSnapshot.config.prompts.role;
const pass = (summary, extra = {}) => ({ result: "pass", summary, ...extra });

function factory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-factory-"));
  const definitions = new PipelineDefinitions({ dataDir: dir, accounts });
  const launches = [],
    outcomes = new Map(),
    prs = [],
    audit = [];
  let changes = [{ status: "M", path: "src/app.js" }];
  let commit = 0;
  const driver = {
    async start(input) {
      launches.push(input);
      outcomes.set(input.sessionId, { status: "running" });
      return { sessionId: input.sessionId };
    },
    inspect: async (input) => outcomes.get(input.sessionId) || { status: "missing" },
    async cancel(input) {
      outcomes.set(input.sessionId, { status: "failed", exitCode: 130 });
    },
  };
  const workspace = {
    async prepare({ runId }) {
      const cwd = path.join(dir, runId);
      fs.mkdirSync(cwd);
      return {
        cwd,
        projectRoot: dir,
        projectId: "project",
        branch: `agentpier/${runId}`,
        baseSha: "base",
      };
    },
    // The commit moves only when a writing stage changed the worktree, so the read-only
    // reviewers of a group leave it where it was.
    checkpoint: async () => ({ sha: `commit-${commit}` }),
    changes: async ({ from, to }) => ({ from, to, changes }),
    fileAt: async ({ path: file }) =>
      file === "package.json" ? JSON.stringify({ dependencies: { a: "1" } }) : null,
    async createPr(input) {
      prs.push(input);
      return { url: "https://github.com/fixture/repo/pull/7" };
    },
    async remove() {
      throw Error("unexpected cleanup");
    },
  };
  const engine = new PipelineEngine({
    dataDir: dir,
    definitions,
    driver,
    workspace,
    pollIntervalMs: 0,
    audit: { append: (entry) => audit.push(entry) },
  });
  t.after(async () => {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let run;
  const current = () => engine.get(run.id);
  // Ends the newest turn of a stage or member with a verdict and reconciles once.
  async function finish(nodeId, verdict, extra = {}) {
    const launch = launches.findLast((l) => l.nodeId === nodeId);
    assert.ok(launch, `no turn of ${nodeId}`);
    if (nodeId === "implement") commit += 1;
    const file = path.join(launch.cwd, launch.verdictPath);
    fs.writeFileSync(file, JSON.stringify(verdict));
    const at = Math.ceil(engine.nowMs() / 1000);
    fs.utimesSync(file, at, at);
    outcomes.set(launch.sessionId, { status: "completed", exitCode: 0, ...extra });
    await engine.reconcile();
  }
  return {
    engine,
    launches,
    prs,
    audit,
    current,
    finish,
    setChanges: (next) => (changes = next),
    async start() {
      run = await engine.start({
        pipelineId: "seed-software-factory",
        cwd: dir,
        task: "Validate the input form",
      });
      return run;
    },
    // The spec writer writes spec.md into its report directory and declares it.
    async writeSpec() {
      const turn = current().executionLog.at(-1);
      const file = `${turn.reportDir}/spec.md`;
      fs.writeFileSync(path.join(current().workingDir, file), SPEC);
      await finish(
        "spec",
        pass("Spec written", { artifacts: [{ path: file, role: "spec" }] }),
      );
      return file;
    },
    async reviewAll(verdicts = {}) {
      for (const id of MEMBERS) await finish(id, verdicts[id] ?? pass(`${id} approves`));
    },
  };
}

test("the software factory takes a passing run from spec to pull request", async (t) => {
  const f = factory(t);
  await f.start();
  assert.equal(f.launches[0].nodeId, "spec");
  assert.match(role(f.launches[0]), /spec\.md in the stage report directory/);
  const spec = await f.writeSpec();
  assert.equal(f.current().spec.frozen, true);
  // The implementer works against the frozen spec and reports every criterion.
  const build = f.launches.at(-1);
  assert.equal(build.nodeId, "implement");
  assert.ok(build.prompt.includes(`Spec: ${spec}`));
  assert.match(role(build), /IMPLEMENTATION\.md/);
  await f.finish("implement", pass("Built", { criteria: met }), { nativeId: "impl-1" });
  // Verification follows the implementer; without configured steps it passes.
  let run = f.current();
  assert.equal(
    run.nodes.find((n) => n.id === "implement").verifyResult.status,
    "not-configured",
  );
  // Four reviewers start together, each in its own turn with its own role.
  assert.equal(run.currentNodeId, "review");
  assert.deepEqual(Object.keys(run.activeTurns).sort(), [...MEMBERS].sort());
  const ux = f.launches.findLast((l) => l.nodeId === "ux");
  assert.match(role(ux), /UX-REVIEW\.md/);
  assert.match(role(f.launches.findLast((l) => l.nodeId === "ui")), /styling system/);
  await f.reviewAll();
  // The approver reads the earlier verdicts, then the pull request is opened.
  const approver = f.launches.at(-1);
  assert.equal(approver.nodeId, "approve");
  assert.match(role(approver), /APPROVAL\.md/);
  assert.match(approver.prompt, /security approves/);
  assert.equal(f.prs.length, 0);
  await f.finish("approve", pass("Checked AC1 myself", { criteria: [met[0]] }));
  run = f.current();
  assert.equal(run.status, "completed");
  assert.equal(f.prs.length, 1);
  assert.equal(run.pullRequestUrl, "https://github.com/fixture/repo/pull/7");
  assert.deepEqual(
    run.executionLog.filter((a) => a.kind !== "group").map((a) => a.nodeId),
    ["spec", "implement", ...MEMBERS, "approve"],
  );
});

test("a risky change stops the factory at the risk gate before review and PR", async (t) => {
  const f = factory(t);
  await f.start();
  await f.writeSpec();
  f.setChanges([
    { status: "M", path: "src/app.js" },
    { status: "M", path: "package.json" },
  ]);
  await f.finish("implement", pass("Built", { criteria: met }), { nativeId: "impl-1" });
  let run = f.current();
  assert.equal(run.status, "awaiting-human");
  const implement = run.nodes.find((n) => n.id === "implement");
  assert.equal(implement.failReason, "risk-gate");
  assert.deepEqual(
    implement.riskGate.items.map((item) => item.path),
    ["package.json"],
  );
  assert.ok(run.actions.includes("approve-risk"));
  assert.equal(f.launches.filter((l) => MEMBERS.includes(l.nodeId)).length, 0);
  await f.engine.gate(run.id, { action: "approve-risk" });
  run = f.current();
  assert.deepEqual(run.risk.approved, ["path:package.json"]);
  assert.equal(run.currentNodeId, "review");
  await f.reviewAll();
  await f.finish("approve", pass("Approved", { criteria: [met[0]] }));
  run = f.current();
  assert.equal(run.status, "completed");
  assert.equal(f.prs.length, 1);
  assert.ok(f.audit.some((entry) => entry.details?.kind === "risk"));
});

test("a failing review resumes the implementer's session, which repairs and passes", async (t) => {
  const f = factory(t);
  await f.start();
  await f.writeSpec();
  await f.finish("implement", pass("Built", { criteria: met }), { nativeId: "impl-1" });
  await f.reviewAll({
    security: {
      result: "fail",
      summary: "Input reaches the query unescaped",
      findings: [{ severity: "high", title: "SQL injection", criterion: "AC1" }],
    },
  });
  // One round back to the implementer, in its own native session.
  const repair = f.launches.at(-1);
  assert.equal(repair.nodeId, "implement");
  assert.equal(repair.kind, "resumed-repair");
  assert.equal(repair.resumeNativeId, "impl-1");
  assert.match(repair.prompt, /Repair round 1 of 2, sent back by review/);
  assert.match(repair.prompt, /SQL injection/);
  let run = f.current();
  assert.equal(run.loopRounds.length, 1);
  assert.equal(run.loopRounds[0].stages[0].nodeId, "security");
  await f.finish(
    "implement",
    pass("Escaped the input", {
      criteria: met,
      responses: [{ finding: "R1-1", status: "fixed" }],
    }),
    { nativeId: "impl-1" },
  );
  // Verification and every reviewer run again; this time all pass.
  assert.equal(f.launches.filter((l) => l.nodeId === "security").length, 2);
  await f.reviewAll();
  await f.finish("approve", pass("Approved", { criteria: [met[0]] }));
  run = f.current();
  assert.equal(run.status, "completed");
  assert.equal(f.prs.length, 1);
  assert.deepEqual(run.loopRounds[0].responses, [{ finding: "R1-1", status: "fixed" }]);
  assert.deepEqual(run.executionLog.find((a) => a.kind === "resumed-repair").repair, {
    edge: "review->implement",
    round: 1,
    session: "resumed",
  });
});
