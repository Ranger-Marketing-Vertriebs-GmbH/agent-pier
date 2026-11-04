import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fixture } from "../helpers/pipeline-engine.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { availableActions } from "../../server/features/pipelines/pipeline-actions.js";
import {
  requestReturn,
  returnOptions,
} from "../../server/features/pipelines/return-service.js";
import { RunQueue } from "../../server/features/pipelines/run-queue.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { ReviewCommentStore } from "../../server/features/changes/review-comment-store.js";
import { commentInput } from "../../server/features/changes/review-comment-input.js";
import { anchorAt } from "../../server/features/changes/review-anchor.js";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { pipelineRunRoutes } from "../../server/http/routes/pipeline-runs.js";
import { routeAccess } from "../../server/http/route-access.js";
import { registerResponses } from "../../server/http/responses.js";
import {
  reopenAtStage,
  returnableStages,
} from "../../server/features/pipelines/return-to-stage.js";

// build -> review -> approve; a review failure loops back to build.
function completedFixture(t, options = {}) {
  const f = fixture(t, { loop: true, options });
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: ["build", "review", "approve"].map((id) => ({
        id,
        kind: "profile",
        profileId: "profile",
      })),
      edges: [
        { from: "build", to: "review", condition: "default" },
        { from: "review", to: "approve", condition: "default" },
        { from: "review", to: "build", condition: "fail", maxIterations: 1 },
      ],
    };
    return snapshot;
  };
  return f;
}
const pass = (summary) => ({ result: "pass", summary, findings: [] });

async function completed(t, options) {
  const f = completedFixture(t, options);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"), { nativeId: "native-build" });
  await f.end(pass("Reviewed"), { nativeId: "native-review" });
  await f.end(pass("Approved"), { nativeId: "native-approve" });
  assert.equal(f.engine.get(run.id).status, "completed");
  const reopen = (input) =>
    f.engine.lock(run.id, () =>
      reopenAtStage(f.engine, f.engine.store.get(run.id), input),
    );
  return { f, run, reopen, current: () => f.engine.get(run.id) };
}

test("a completed run reopens at the chosen stage and later stages reset", async (t) => {
  const { f, reopen, current } = await completed(t);
  const result = await reopen({
    nodeId: "review",
    note: "Review notes (1):\n- fix it",
    requestId: "req-1",
  });
  assert.deepEqual(result, { repeated: false });
  const saved = current();
  assert.equal(saved.status, "running");
  assert.equal(saved.finishedAt, undefined);
  assert.deepEqual(
    saved.nodes.map((n) => [n.id, n.status]),
    [
      ["build", "passed"],
      ["review", "running"],
      ["approve", "pending"],
    ],
  );
  assert.match(
    f.launches.at(-1).prompt,
    /The operator sent the run back with this instruction for the repair:\n\nReview notes \(1\):/,
  );
  assert.deepEqual(
    saved.returns.map((r) => [r.requestId, r.nodeId]),
    [["req-1", "review"]],
  );
});

test("the round is recorded but no loop limit counts it", async (t) => {
  const { f, reopen, current } = await completed(t);
  const before = structuredClone(current().loopState);
  await reopen({ nodeId: "review", note: "Review notes", requestId: "req-1" });
  const saved = current();
  assert.deepEqual(saved.loopState, before);
  const round = saved.loopRounds.at(-1);
  assert.equal(round.toNodeId, "review");
  assert.equal(round.edge, "owner:approve->review");
  assert.equal(round.round, 1);
  assert.equal(saved.nodes[1].loop.maxIterations, undefined);
  assert.equal(saved.nodes[1].loop.owner, true);
  assert.doesNotMatch(f.launches.at(-1).prompt, /Repair round \d+ of/);
});

test("the stage resumes its earlier session when it can, else starts fresh", async (t) => {
  const { f, reopen, current } = await completed(t);
  await reopen({ nodeId: "review", note: "Again", requestId: "req-1" });
  assert.equal(f.launches.at(-1).kind, "resumed-repair");
  assert.equal(f.launches.at(-1).resumeNativeId, "native-review");

  const other = await completed(t);
  const run = other.f.engine.store.get(other.run.id);
  run.nodes[1].profileSnapshot = { ...run.nodes[1].profileSnapshot, id: "changed" };
  other.f.engine.store.save(run);
  await other.reopen({ nodeId: "review", note: "Again", requestId: "req-1" });
  assert.equal(other.f.launches.at(-1).kind, "kickoff");
  assert.deepEqual(other.current().executionLog.at(-1).repair, {
    edge: "owner:approve->review",
    round: 1,
    session: "fresh",
    fallback: "profile-changed",
  });
  assert.ok(current());
});

test("only stages that ran are offered; members stay out", async (t) => {
  const f = completedFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  assert.deepEqual(
    returnableStages(f.engine.get(run.id)).map((s) => s.id),
    ["build"],
  );
  const synthetic = {
    nodes: [
      { id: "a", profileSnapshot: { name: "Alpha" } },
      { id: "g", kind: "parallel" },
      { id: "m", group: "g" },
    ],
    executionLog: [{ nodeId: "a" }, { nodeId: "g" }, { nodeId: "m" }],
  };
  assert.deepEqual(returnableStages(synthetic), [{ id: "a", name: "Alpha" }]);
});

test("a repeated request id reopens once and the history stays bounded", async (t) => {
  const { f, reopen, current } = await completed(t);
  await reopen({ nodeId: "review", note: "Once", requestId: "req-1" });
  const count = f.launches.length;
  const again = await reopen({ nodeId: "review", note: "Once", requestId: "req-1" });
  assert.deepEqual(again, { repeated: true });
  assert.equal(f.launches.length, count);
  assert.equal(current().returns.length, 1);
  const run = f.engine.store.get(current().id);
  run.returns = Array.from({ length: 25 }, (_, i) => ({ requestId: `r${i}` }));
  run.status = "completed";
  f.engine.store.save(run);
  await reopen({ nodeId: "review", note: "More", requestId: "new" });
  assert.equal(current().returns.length, 20);
  assert.equal(current().returns[0].requestId, "r6");
  assert.equal(current().returns.at(-1).requestId, "new");
});

test("a second owner return to the same stage records round 2 under the owner key", async (t) => {
  const { f, reopen, current } = await completed(t);
  await reopen({ nodeId: "review", note: "First", requestId: "req-1" });
  await f.end(pass("Reviewed again"), { nativeId: "native-review" });
  await f.end(pass("Approved again"), { nativeId: "native-approve" });
  assert.equal(current().status, "completed");
  await reopen({ nodeId: "review", note: "Second", requestId: "req-2" });
  const rounds = current().loopRounds.filter((r) => r.edge === "owner:approve->review");
  assert.deepEqual(
    rounds.map((r) => r.round),
    [1, 2],
  );
  assert.equal(current().nodes[1].loop.iteration, 2);
});

test("the round number follows the last kept round once old ones are trimmed", async (t) => {
  const { reopen, current, f, run } = await completed(t);
  const saved = f.engine.store.get(run.id);
  saved.loopRounds = Array.from({ length: 10 }, (_, i) => ({
    edge: "owner:approve->review",
    round: i + 5,
    toNodeId: "review",
  }));
  f.engine.store.save(saved);
  await reopen({ nodeId: "review", note: "Late", requestId: "req-9" });
  assert.equal(current().loopRounds.at(-1).round, 15);
});

// ── The owner's return: blocks, slot, notes and the routes ──────────────────────

const copy = serverMessages.pipelines;
const diffText = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
].join("\n");

// A completed run with a review comment store, a PR state stub, a sequence watch and
// an audit log; `box` steers the stubs.
async function returnable(t) {
  const box = { pr: "open", watch: () => false, audit: [] };
  const done = await completed(t, {
    reviewComments: {
      list: (scope) => box.store.list(scope),
      markSent: (scope, ids) => box.store.markSent(scope, ids),
    },
    sequenceWatch: (id) => box.watch(id),
    audit: { append: (entry) => box.audit.push(auditEvent(entry)) },
  });
  const { f, run } = done;
  box.store = new ReviewCommentStore({ dataDir: f.dir });
  f.workspace.validate = async (workspace) => {
    if (box.gone) throw new Error("gone");
    return workspace;
  };
  f.workspace.pullRequestState = async () => {
    if (box.pr instanceof Error) throw box.pr;
    return box.pr;
  };
  f.workspace.runDiff = async () => ({
    from: "base",
    files: parseGitDiff(diffText),
    truncated: false,
  });
  const scope = { kind: "run", id: run.id };
  const comment = (body = "Check this.") =>
    box.store.create(
      scope,
      commentInput(
        {
          file: "server/a.js",
          side: "new",
          line: 41,
          anchor: anchorAt(parseGitDiff(diffText)[0].rows, 3),
          body,
        },
        { kind: "run" },
      ),
    );
  const edit = (change) => {
    const saved = f.engine.store.get(run.id);
    change(saved);
    f.engine.store.save(saved);
  };
  // Puts back the run as it completed, but for the fields given.
  const original = f.engine.store.get(run.id);
  const restore = (fields = {}) =>
    edit((r) => {
      for (const key of Object.keys(r)) if (key !== "revision") delete r[key];
      Object.assign(r, structuredClone({ ...original, ...fields }), {
        revision: r.revision,
      });
    });
  return { ...done, box, scope, comment, edit, restore };
}
let requests = 0;
const body = (extra = {}) => ({
  nodeId: "review",
  feedback: "Tighten the review.",
  requestId: `req-${++requests}`,
  ...extra,
});

test("finished runs with a workspace offer return-to-stage, which is no gate action", async (t) => {
  const workspace = { hasRemote: true };
  assert.ok(
    availableActions({ status: "completed", workspace }).includes("return-to-stage"),
  );
  assert.ok(
    availableActions({ status: "failed", workspace }).includes("return-to-stage"),
  );
  for (const run of [
    { status: "cancelled", workspace },
    { status: "completed", workspace: null },
    { status: "completed", workspace, imported: { historyOnly: true } },
  ])
    assert.ok(!availableActions(run).includes("return-to-stage"));
  const { f, run } = await returnable(t);
  await assert.rejects(f.engine.gate(run.id, { action: "return-to-stage" }), {
    status: 409,
    message: copy.actionUnavailable,
  });
});

test("the options name the stages that ran and the open notes", async (t) => {
  const { f, run, comment } = await returnable(t);
  comment();
  assert.deepEqual(await returnOptions(f.engine, run.id), {
    available: true,
    reason: null,
    stages: [
      { id: "build", name: "Builder" },
      { id: "review", name: "Builder" },
      { id: "approve", name: "Builder" },
    ],
    openComments: 1,
  });
});

test("every block names its own reason and sentence", async (t) => {
  const { f, run, box, edit, restore, current } = await returnable(t);
  const cases = [
    ["imported", "imported", (r) => (r.imported = { historyOnly: true })],
    ["not-finished", "notFinished", (r) => (r.status = "awaiting-human")],
    ["cancelled", "cancelled", (r) => (r.status = "cancelled")],
    ["no-workspace", "noWorkspace", (r) => (r.workspace = null)],
    ["workspace-gone", "workspaceGone", () => (box.gone = true)],
    ["pr-merged", "prMerged", () => (box.pr = "merged")],
    ["pr-closed", "prClosed", () => (box.pr = "closed")],
    ["pr-armed", "prArmed", () => (box.pr = "armed")],
    ["pr-unknown", "prUnknown", () => (box.pr = new Error("offline"))],
    ["sequence-watching", "sequenceWatching", () => (box.watch = () => true)],
  ];
  for (const [reason, key, change] of cases) {
    Object.assign(box, { pr: "open", gone: false, watch: () => false });
    restore({ pullRequestUrl: "https://github.example/o/r/pull/1" });
    edit(change);
    const options = await returnOptions(f.engine, run.id);
    assert.deepEqual([options.available, options.reason], [false, reason]);
    await assert.rejects(requestReturn(f.engine, run.id, body()), (error) => {
      assert.deepEqual(
        [error.status, error.code, error.reason, error.message],
        [409, "PIPELINE_RETURN_BLOCKED", reason, copy.returnBlocked[key]],
      );
      return true;
    });
  }
  assert.equal(new Set(Object.values(copy.returnBlocked)).size, cases.length);
  // Without a pull request no forge is asked.
  restore();
  Object.assign(box, { pr: new Error("never asked"), watch: () => false });
  assert.equal((await returnOptions(f.engine, run.id)).available, true);
  assert.equal(current().status, "completed");
});

test("a run any sequence item names stays blocked, whatever the item's state", async (t) => {
  const { f, run, box } = await returnable(t);
  const sequences = new TicketSequenceStore({ dataDir: f.dir });
  box.watch = (id) => sequences.watchingRun(id);
  const [item] = sequences.append("p1", "/repo", [
    {
      source: "github",
      key: "o/r#1",
      title: "Ticket",
      url: "https://github.com/o/r/issues/1",
      kind: "pipeline",
      options: { allowMerge: false },
    },
  ]).items;
  assert.equal((await returnOptions(f.engine, run.id)).available, true);
  for (const state of ["running", "awaiting-merge", "done"]) {
    sequences.patch("p1", item.id, { state, runId: run.id });
    assert.equal((await returnOptions(f.engine, run.id)).reason, "sequence-watching");
  }
});

test("an unknown stage, an empty note or a bad request id is refused", async (t) => {
  const { f, run, current } = await returnable(t);
  const count = f.launches.length;
  await assert.rejects(requestReturn(f.engine, run.id, body({ nodeId: "nope" })), {
    status: 400,
    message: copy.returnStageUnknown,
  });
  for (const extra of [{ feedback: "  " }, { feedback: "", review: true }, {}])
    await assert.rejects(
      requestReturn(f.engine, run.id, body({ feedback: "", ...extra })),
      { status: 400, message: copy.returnNoteRequired },
    );
  for (const requestId of [undefined, "", "../x", 7])
    await assert.rejects(requestReturn(f.engine, run.id, body({ requestId })), {
      status: 400,
      message: copy.invalidIdentifier,
    });
  for (const feedback of [42, { text: "x" }, ["x"]])
    await assert.rejects(requestReturn(f.engine, run.id, body({ feedback })), {
      status: 400,
      message: copy.invalidLoopFeedback,
    });
  await assert.rejects(
    requestReturn(f.engine, run.id, body({ feedback: "x".repeat(40000) })),
    { status: 409, code: "PIPELINE_FEEDBACK_TOO_LARGE" },
  );
  assert.equal(f.launches.length, count);
  assert.equal(current().status, "completed");
});

test("the notes alone are enough, go along once and are marked sent after the reopen", async (t) => {
  const { f, run, box, scope, comment, current } = await returnable(t);
  comment("Use a constant-time comparison.");
  const input = body({ feedback: "", review: true });
  const { run: answered } = await requestReturn(f.engine, run.id, input);
  assert.equal(answered.status, "running");
  assert.ok(Array.isArray(answered.actions));
  assert.match(f.launches.at(-1).prompt, /Review notes \(1\):/);
  assert.equal(box.store.list(scope).comments[0].sentIn, 1);
  const count = f.launches.length;
  await requestReturn(f.engine, run.id, input);
  assert.equal(f.launches.length, count);
  assert.equal(box.store.list(scope).batches, 1);
  assert.deepEqual(
    box.audit.map((e) => [e.action, e.details]),
    [["pipeline.updated", { kind: "return", stageId: "review", comments: 1 }]],
  );
  assert.equal(current().returns.length, 1);
});

test("a failed run goes back to a stage as well", async (t) => {
  const { f, run, edit, current } = await returnable(t);
  edit((r) => {
    r.status = "failed";
    r.nodes.at(-1).status = "failed";
  });
  assert.equal((await returnOptions(f.engine, run.id)).available, true);
  const count = f.launches.length;
  await requestReturn(f.engine, run.id, body({ nodeId: "build" }));
  assert.equal(current().status, "running");
  assert.equal(f.launches.length, count + 1);
  assert.deepEqual(
    current().returns.map((r) => r.nodeId),
    ["build"],
  );
});

// A real run queue of the fixture's project with one slot.
function projectQueue(t, f, { known = true } = {}) {
  f.definitions.getQueueSettings = (projectId) => ({
    projectId,
    limit: 1,
    countParked: false,
  });
  const queue = new RunQueue({
    dataDir: f.dir,
    engine: f.engine,
    definitions: f.definitions,
    projects: (id) => {
      if (!known || id !== "project")
        throw Object.assign(new Error("missing"), { status: 404 });
      return { id, cwd: f.dir };
    },
    projectMoved: () => null,
    pollIntervalMs: 0,
  });
  t.after(() => queue.close());
  return queue;
}

test("a busy project refuses the return and keeps the run and its notes", async (t) => {
  const { f, run, box, scope, comment, current } = await returnable(t);
  const queue = projectQueue(t, f);
  comment();
  const other = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "B" });
  assert.equal(f.engine.get(other.id).status, "running");
  const count = f.launches.length;
  const input = body({ review: true });
  await assert.rejects(requestReturn(f.engine, run.id, input, { queue }), {
    status: 409,
    code: "PIPELINE_RETURN_BUSY",
    message: copy.returnBusy,
  });
  assert.equal(current().status, "completed");
  assert.equal(current().returns, undefined);
  assert.equal(f.launches.length, count);
  assert.equal(box.store.list(scope).comments[0].sentIn, null);
  assert.equal(box.audit.length, 0);
  // Once the other run finished, the same request goes through.
  await f.engine.cancel(other.id);
  await requestReturn(f.engine, run.id, input, { queue });
  assert.equal(current().status, "running");
  assert.equal(box.store.list(scope).comments[0].sentIn, 1);
});

test("a run without a registered project reopens at once", async (t) => {
  const { f, run, current } = await returnable(t);
  const queue = projectQueue(t, f, { known: false });
  await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "B" });
  await requestReturn(f.engine, run.id, body(), { queue });
  assert.equal(current().status, "running");
});

// The routes behind the owner's access check; `?as=user` is a restricted user.
async function serve(t, f, queue) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = req.query.as === "user" ? { role: "user", userId: "u" } : null;
    next();
  });
  app.use("/api", routeAccess());
  app.use(
    "/api",
    pipelineRunRoutes({
      pipelines: f.engine,
      pipelineRunCounts: {},
      pipelineQueue: queue,
    }),
  );
  registerResponses(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (url, payload) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: payload ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("the routes answer options and the reopened run, blocks by reason, users 404", async (t) => {
  const { f, run, box } = await returnable(t);
  const call = await serve(t, f, projectQueue(t, f));
  const url = `/api/pipeline-runs/${run.id}/return-to-stage`;
  assert.equal((await call(`${url}?as=user`)).status, 404);
  assert.equal((await call(`${url}?as=user`, body())).status, 404);
  const options = await call(url);
  assert.equal(options.status, 200);
  assert.deepEqual(
    [options.body.available, options.body.reason, options.body.openComments],
    [true, null, 0],
  );
  box.pr = "armed";
  f.engine.store.save({
    ...f.engine.store.get(run.id),
    pullRequestUrl: "https://github.example/o/r/pull/1",
  });
  const blocked = await call(url, body());
  assert.equal(blocked.status, 409);
  assert.deepEqual(
    [blocked.body.code, blocked.body.reason, blocked.body.messageKey],
    ["PIPELINE_RETURN_BLOCKED", "pr-armed", "pipelines.returnBlocked.prArmed"],
  );
  box.pr = "open";
  const done = await call(url, body());
  assert.equal(done.status, 200);
  assert.equal(done.body.run.status, "running");
  assert.equal(done.body.run.returns.length, 1);
});
