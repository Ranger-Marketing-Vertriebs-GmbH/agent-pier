import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

// A run whose workspace reports a changing diff since its base, checkpoints each turn
// and audits gate decisions.
function riskFixture(t, options = {}) {
  const audit = [];
  const f = fixture(t, {
    ...options,
    options: { audit: { append: (e) => audit.push(e) } },
  });
  let turn = 0;
  // `bySha` gives the diff up to a given commit; other commits see `changes`.
  const state = { changes: [], bySha: {}, files: {}, fail: false, diffs: [], prs: [] };
  f.workspace.checkpoint = async () => ({ sha: `end-${++turn}` });
  f.workspace.changes = async ({ from, to }) => {
    state.diffs.push({ from, to });
    if (state.fail) throw Error("git failed");
    return { from, to, changes: state.bySha[to] ?? state.changes };
  };
  f.workspace.createPr = async (input) => {
    state.prs.push(input);
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  f.workspace.fileAt = async ({ sha, path }) =>
    state.files[`${sha === "abc" ? "base" : "head"}:${path}`] ?? null;
  f.definitions.riskRules = () => ({
    globs: ["/.github/**", "migrations/**"],
    newDependency: true,
  });
  return { f, state, audit };
}
const start = (f) =>
  f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
const pass = { result: "pass", summary: "All criteria met", requiresHuman: false };

test("a risky change parks at the risk gate although every verdict passes", async (t) => {
  const { f, state, audit } = riskFixture(t);
  state.changes = [
    { status: "M", path: ".github/workflows/ci.yml" },
    { status: "M", path: "src/app.js" },
  ];
  const r = await start(f);
  await f.end(pass);
  let run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  const node = run.nodes[0];
  assert.equal(node.status, "awaiting-gate");
  assert.equal(node.failReason, "risk-gate");
  assert.deepEqual(node.riskGate.items, [
    { path: ".github/workflows/ci.yml", status: "M", rule: "/.github/**" },
  ]);
  assert.equal(node.riskGate.sha, "end-1");
  // The diff is the whole run since its base, up to the stage's checkpoint.
  assert.deepEqual(state.diffs.at(-1), { from: "abc", to: "end-1" });
  // The owner approves the change itself; an override is not offered.
  assert.ok(run.actions.includes("approve-risk"));
  assert.ok(!run.actions.includes("override"));
  assert.ok(!run.actions.includes("accept"));
  await f.engine.gate(r.id, { action: "approve-risk" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.nodes[0].gateDecision, "risk-approved");
  assert.equal(run.nodes[0].riskGate, undefined);
  assert.deepEqual(run.risk.approved, ["path:.github/workflows/ci.yml"]);
  assert.equal(run.risk.decisions[0].decision, "approved");
  assert.equal(run.risk.decisions[0].nodeId, "build");
  const entry = audit.find((e) => e.details?.kind === "risk");
  assert.deepEqual(entry.details, {
    kind: "risk",
    decision: "approve",
    stageId: "build",
    paths: [".github/workflows/ci.yml"],
    count: 1,
  });
  assert.equal(entry.action, "pipeline.updated");
  assert.equal(entry.source, "user");
});

test("approved paths gate again only when a new risky path or dependency appears", async (t) => {
  const { f, state } = riskFixture(t, { loop: true });
  state.changes = [{ status: "A", path: "db/migrations/001.sql" }];
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  await f.engine.gate(r.id, { action: "approve-risk" });
  // The review stage runs; the same path changed again is already approved.
  state.changes = [{ status: "M", path: "db/migrations/001.sql" }];
  await f.end({ result: "fail", summary: "Fix it", findings: [{ title: "Bug" }] });
  // A failing review loops back without a risk gate; the repair adds a dependency.
  let run = f.engine.get(r.id);
  assert.equal(run.status, "running");
  assert.equal(run.currentNodeId, "build");
  state.changes = [
    { status: "M", path: "db/migrations/001.sql" },
    { status: "M", path: "package.json" },
  ];
  state.files = {
    "base:package.json": JSON.stringify({ dependencies: { a: "1" } }),
    "head:package.json": JSON.stringify({ dependencies: { a: "1", left: "2" } }),
  };
  await f.end({ ...pass, responses: [{ finding: "R1-1", status: "fixed" }] });
  run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.deepEqual(
    run.nodes[0].riskGate.items.map((item) => item.dependency ?? item.path),
    ["left"],
  );
  await f.engine.gate(r.id, { action: "approve-risk" });
  await f.end(pass);
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.risk.decisions.length, 2);
});

test("approving the risk gate leaves the stage's own human approval in place", async (t) => {
  const { f, state } = riskFixture(t, { gate: true });
  state.changes = [{ status: "D", path: "migrations/002.sql" }];
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  // Approving does not accept the stage's own gate: the human approval still follows.
  await f.engine.gate(r.id, { action: "approve-risk" });
  let run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].status, "awaiting-gate");
  assert.equal(run.nodes[0].failReason, undefined);
  assert.ok(run.actions.includes("accept"));
  await f.engine.gate(r.id, { action: "accept" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
});

test("an escalating verdict still asks the owner after the risk gate", async (t) => {
  const { f, state } = riskFixture(t);
  state.changes = [{ status: "M", path: ".github/CODEOWNERS" }];
  const r = await start(f);
  await f.end({
    result: "pass",
    summary: "Needs a decision",
    requiresHuman: true,
    question: "Should CI also run on forks?",
    files: [".github/workflows/ci.yml", "../escape", ".github/workflows/ci.yml"],
  });
  await f.engine.gate(r.id, { action: "approve-risk" });
  const run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "verdict-fail");
  assert.equal(run.nodes[0].verdict.question, "Should CI also run on forks?");
  assert.deepEqual(run.nodes[0].verdict.files, [".github/workflows/ci.yml"]);
});

test("feedback at the risk gate reruns the stage, and reverting the change clears it", async (t) => {
  const { f, state } = riskFixture(t);
  state.changes = [{ status: "M", path: ".github/workflows/ci.yml" }];
  const r = await start(f);
  await f.end(pass, { nativeId: "native" });
  await f.engine.gate(r.id, { action: "feedback", feedback: "Leave CI alone" });
  let run = f.engine.get(r.id);
  assert.equal(run.status, "running");
  assert.equal(run.nodes[0].riskGate, undefined);
  state.changes = [{ status: "M", path: "src/app.js" }];
  await f.end(pass);
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.risk, undefined);
});

test("a failed check parks with its reason and an approval skips it for that commit only", async (t) => {
  const { f, state, audit } = riskFixture(t);
  state.fail = true;
  const r = await start(f);
  await f.end(pass);
  let run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.equal(run.nodes[0].riskGate.error, true);
  assert.equal(run.nodes[0].failDetail, serverMessages.pipelines.riskCheckFailed);
  await f.engine.gate(r.id, { action: "approve-risk" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.risk.decisions[0].error, true);
  assert.equal(
    audit.find((e) => e.details?.kind === "risk").details.failReason,
    "risk-check-failed",
  );
});

test("rules come from the project's settings, never from the run's verdicts", async (t) => {
  const { f, state } = riskFixture(t);
  const asked = [];
  f.definitions.riskRules = (projectId) => {
    asked.push(projectId);
    return { globs: ["secrets/**"], newDependency: false };
  };
  state.changes = [{ status: "A", path: "config/secrets/key.txt" }];
  const r = await start(f);
  // A verdict cannot carry rules or approvals; extra fields are ignored.
  await f.end({ ...pass, riskRules: [], approved: ["path:config/secrets/key.txt"] });
  const run = f.engine.get(r.id);
  assert.deepEqual(asked, ["project"]);
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.equal(run.nodes[0].verdict.riskRules, undefined);
});

// build -> [verify] -> pull request
function withPr(f, { verify } = {}) {
  const graph = f.definitions.snapshot().pipeline.graph;
  graph.nodes.push({ id: "pr", kind: "createPr" });
  graph.edges.push({ from: "build", to: "pr", condition: "default" });
  if (verify) {
    f.definitions.getVerification = () => ({
      steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
    });
  }
}
// build -> verification -> pull request
function withPrAfterVerification(f) {
  withPr(f, { verify: true });
  const graph = f.definitions.snapshot().pipeline.graph;
  graph.nodes.splice(1, 0, { id: "check", kind: "verify" });
  graph.edges.splice(0, 1, { from: "build", to: "check", condition: "default" });
  graph.edges.push({ from: "check", to: "pr", condition: "default" });
}
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

test("the risk gate parks before verification starts", async (t) => {
  const verify = verifier();
  const { f, state } = riskFixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
  });
  state.changes = [{ status: "A", path: "migrations/003.sql" }];
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  assert.equal(verify.plans.length, 0);
  await f.engine.gate(r.id, { action: "approve-risk" });
  assert.equal(verify.plans.length, 1);
});

test("the risk gate parks before a pull request is created", async (t) => {
  const { f, state } = riskFixture(t);
  withPr(f);
  state.changes = [{ status: "M", path: ".github/workflows/ci.yml" }];
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  assert.equal(state.prs.length, 0);
  await f.engine.gate(r.id, { action: "approve-risk" });
  const run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(state.prs.length, 1);
  // The pull request publishes exactly the commit the gate checked last.
  assert.equal(state.prs[0].expectedSha, state.diffs.at(-1).to);
});

test("a risky file written by verification after the checkpoint parks before the push", async (t) => {
  const verify = verifier();
  const { f, state, audit } = riskFixture(t, { verify });
  withPrAfterVerification(f);
  // The stage's checkpoint holds a harmless change; the push commit also holds the
  // workflow a test wrote while verification ran.
  state.bySha = {
    "end-1": [{ status: "M", path: "src/app.js" }],
    "end-2": [
      { status: "M", path: "src/app.js" },
      { status: "A", path: ".github/workflows/release.yml" },
    ],
  };
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).status, "running");
  assert.equal(verify.plans.length, 1);
  verify.jobs.set(verify.plans[0].id, {
    status: "pass",
    steps: [{ name: "check", exitCode: 0 }],
  });
  await f.engine.reconcile();
  let run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.equal(run.nodes[0].verified, true);
  assert.deepEqual(
    run.nodes[0].riskGate.items.map((i) => i.path),
    [".github/workflows/release.yml"],
  );
  assert.equal(run.nodes[0].riskGate.sha, "end-2");
  assert.equal(state.prs.length, 0);
  await f.engine.gate(r.id, { action: "approve-risk" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(state.prs.length, 1);
  assert.equal(verify.plans.length, 1);
  assert.ok(
    audit.some((e) => e.details?.paths?.includes(".github/workflows/release.yml")),
  );
});

test("retrying a failed pull request checks late changes again", async (t) => {
  const { f, state } = riskFixture(t);
  withPr(f);
  let fail = true;
  f.workspace.createPr = async (input) => {
    state.prs.push(input);
    if (fail) throw Error("push failed");
    return { url: "https://github.com/fixture/repo/pull/1" };
  };
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "pr-failed");
  // Something wrote a migration before the retry.
  state.changes = [{ status: "A", path: "migrations/004.sql" }];
  fail = false;
  await f.engine.retry(r.id);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  assert.equal(state.prs.length, 1);
  await f.engine.gate(r.id, { action: "approve-risk" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(state.prs.length, 2);
});

test("publishing a completed run checks late changes and reopens it at the risk gate", async (t) => {
  const { f, state, audit } = riskFixture(t);
  f.workspace.hasRemote = async () => true;
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).status, "completed");
  state.changes = [{ status: "M", path: ".github/CODEOWNERS" }];
  let run = await f.engine.createPr(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.equal(run.nodes[0].riskGate.resume, "publish");
  assert.ok(run.actions.includes("approve-risk"));
  assert.equal(state.prs.length, 0);
  await f.engine.gate(r.id, { action: "approve-risk" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.pullRequestUrl, "https://github.com/fixture/repo/pull/1");
  assert.equal(state.prs.length, 1);
  assert.ok(audit.some((e) => e.details?.kind === "risk"));
});

test("an override of failed verification still checks what the push publishes", async (t) => {
  const verify = verifier();
  const { f, state } = riskFixture(t, { verify });
  withPrAfterVerification(f);
  const r = await start(f);
  for (let i = 0; i < 3; i++) {
    await f.end(pass, { nativeId: "native" });
    verify.jobs.set(verify.plans.at(-1).id, {
      status: "fail",
      steps: [{ name: "check", exitCode: 1 }],
    });
    await f.engine.reconcile();
  }
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "verify-failed");
  state.changes = [{ status: "A", path: ".github/workflows/x.yml" }];
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "risk-gate");
  assert.equal(state.prs.length, 0);
});

test("product decisions of the spec park the run until the owner confirms them", async (t) => {
  const { f, state } = riskFixture(t);
  const r = await start(f);
  // The spec stage recorded a product decision; a passing stage cannot skip it.
  const stored = f.engine.store.get(r.id);
  stored.spec = {
    text: "spec",
    sha256: "s".repeat(64),
    criteria: [{ id: "AC1", text: "Works" }],
    assumptions: [
      { id: "A1", text: "Free users keep exports for 7 days", productDecision: true },
      { id: "A2", text: "Uses the store", productDecision: false },
    ],
  };
  f.engine.store.save(stored);
  state.changes = [{ status: "M", path: "src/app.js" }];
  await f.end(pass);
  let run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "risk-gate");
  assert.deepEqual(run.nodes[0].riskGate.items, [
    { assumption: "A1", text: "Free users keep exports for 7 days" },
  ]);
  await f.engine.gate(r.id, { action: "approve-risk" });
  run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.ok(run.risk.approved.some((key) => key.startsWith("assumption:")));
});

test("an owner who turned the gate off for the project is never stopped", async (t) => {
  const { f, state } = riskFixture(t);
  f.definitions.riskRules = () => ({
    globs: ["/.github/**"],
    newDependency: true,
    enabled: false,
  });
  state.changes = [{ status: "M", path: ".github/workflows/ci.yml" }];
  const r = await start(f);
  await f.end(pass);
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(state.diffs.length, 0);
});
