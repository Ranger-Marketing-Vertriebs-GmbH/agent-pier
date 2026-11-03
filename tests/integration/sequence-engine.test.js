import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fc from "fast-check";
import * as prForge from "../../server/features/tickets/pr-forge.js";
import { prVerdict } from "../../server/features/tickets/pr-status.js";
import { githubPull } from "../helpers/ticket-fakes.js";
import {
  GREEN,
  KEY,
  awaitingMerge,
  forgeMerges as merges,
  forgeMutations as mutations,
  sequenceFixture,
  T0,
} from "../helpers/sequence-fixture.js";

const head = (f) => f.items().find((item) => item.state !== "done");

test("session ticket: worktree, launch, task, in progress", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  await f.engine.run();
  assert.equal(f.launched.length, 1);
  const [{ body, trusted }] = f.launched;
  assert.ok(body.cwd.startsWith(path.join(f.repoPath, ".worktrees") + path.sep));
  assert.equal(trusted.ticket.key, KEY);
  assert.equal(body.name, `${KEY} · Fix thing 12`);
  const [item] = f.items();
  assert.equal(item.state, "running");
  assert.equal(item.starting, undefined);
  assert.equal(item.sessionId, f.launched[0].session.id);
  assert.equal(item.worktree.cwd, body.cwd);
  assert.equal(item.worktree.baseRef, "main");
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes(item.worktree.branch));
  assert.equal(f.sent[0].id, item.sessionId);
  const starts = f.ticketStore.starts("p1");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].targetId, item.sessionId);
  assert.equal(starts[0].writeBack.state, "done");
  const marked = f.sourceCalls.filter((call) => call.name === "markInProgress");
  assert.equal(marked.length, 1);
  assert.equal(marked[0].options.kind, "session");
  assert.ok(f.signals.includes("tickets.queue:p1"));
  assert.ok(f.signals.includes("tickets.project:p1"));
  // The next pass looks for the PR but never launches again.
  await f.engine.run();
  assert.equal(f.launched.length, 1);
  assert.equal(f.sent.length, 1);
});

test("pipeline ticket: one queue item with reserved id and externalRef", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  await f.engine.run();
  await f.engine.run();
  const [item] = f.items();
  assert.equal(item.state, "running");
  assert.ok(item.runId);
  assert.equal(f.queued.size, 1);
  const queued = f.queued.get(item.runId);
  assert.equal(queued.externalRef, KEY);
  assert.equal(queued.pipelineId, "pl1");
  assert.equal(queued.baseBranch, "main");
  assert.equal(queued.source.kind, "ticket-sequence");
  assert.equal(queued.source.ticket.key, KEY);
  assert.match(queued.task, /Closes #12/);
  assert.equal(f.launched.length, 0);
  assert.equal(f.ticketStore.starts("p1")[0].targetId, item.runId);
});

test("PR found moves to awaiting-merge (session: by branch)", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  await f.engine.run();
  const branch = f.items()[0].worktree.branch;
  // An older PR of an earlier attempt and a look-alike branch never count.
  f.forge.pulls.push(
    githubPull(20, { headRef: "ticket/120-other" }),
    githubPull(21, {
      headRef: branch,
      createdAt: "2026-10-01T10:00:00Z",
      state: "CLOSED",
    }),
  );
  await f.engine.run();
  assert.equal(f.items()[0].state, "running");
  f.forge.pulls.push(githubPull(30, { headRef: branch }));
  await f.engine.run();
  const [item] = f.items();
  assert.equal(item.state, "awaiting-merge");
  assert.deepEqual(item.pr, {
    number: 30,
    url: "https://github.com/acme/app/pull/30",
    headRef: branch,
  });
});

test("PR found moves to awaiting-merge (pipeline: by run.pullRequestUrl)", async (t) => {
  const f = await sequenceFixture(t, { pulls: [githubPull(5)] });
  f.append([KEY], { kind: "pipeline" });
  await f.engine.run();
  const { runId } = f.items()[0];
  f.runs.set(runId, { id: runId, status: "running", pullRequestUrl: null });
  await f.engine.run();
  assert.equal(f.items()[0].state, "running");
  f.runs.set(runId, {
    id: runId,
    status: "running",
    pullRequestUrl: "https://github.com/acme/app/pull/5",
  });
  await f.engine.run();
  const [item] = f.items();
  assert.equal(item.state, "awaiting-merge");
  assert.equal(item.pr.number, 5);
  assert.equal(item.pr.headRef, "ticket/5-work");
});

test("merged PR writes Done and starts the next ticket in the same pass", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f);
  pull.state = "MERGED";
  await f.engine.run();
  const [first, second] = f.items();
  assert.equal(first.state, "done");
  assert.equal(first.doneBy, "merge");
  assert.equal(first.doneAt, T0);
  assert.deepEqual(first.writeBack, { state: "done" });
  assert.equal(second.state, "running");
  assert.equal(f.launched.length, 2);
  const done = f.sourceCalls.filter((call) => call.name === "markDone");
  assert.equal(done.length, 1);
  assert.equal(done[0].key, KEY);
  assert.equal(done[0].options.prUrl, "https://github.com/acme/app/pull/30");
});

test("a failed Done write-back is recorded and does not block the next ticket", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f);
  f.tickets.sources.github.markDone = async () => {
    throw Object.assign(new Error("x"), { code: "forbidden" });
  };
  pull.state = "MERGED";
  await f.engine.run();
  const [first, second] = f.items();
  assert.deepEqual(first.writeBack, { state: "failed", code: "forbidden" });
  assert.equal(second.state, "running");
});

test("without allowMerge nothing is merged or armed", async (t) => {
  for (const repoSettings of [
    { mergeQueues: ["main"] },
    {},
    { autoMergeAllowed: false },
  ]) {
    const f = await sequenceFixture(t, { repoSettings });
    await awaitingMerge(f, { allowMerge: false });
    for (let n = 0; n < 3; n += 1) await f.engine.run();
    for (const name of ["enqueuePullRequest", "enablePullRequestAutoMerge"])
      assert.equal(mutations(f, name).length, 0);
    assert.equal(merges(f).length, 0);
    assert.equal(head(f).state, "awaiting-merge");
  }
});

test("allowMerge with a merge queue enqueues once", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const pull = await awaitingMerge(f, { allowMerge: true });
  for (let n = 0; n < 3; n += 1) await f.engine.run();
  assert.equal(mutations(f, "enqueuePullRequest").length, 1);
  assert.equal(
    mutations(f, "enqueuePullRequest")[0].body.variables.input.expectedHeadOid,
    pull.headSha,
  );
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 0);
  assert.equal(merges(f).length, 0);
  assert.equal(pull.inMergeQueue, true);
  assert.equal(f.items()[0].armed, "queue");
});

test("allowMerge with auto-merge enables it once while GitHub blocks the PR", async (t) => {
  const f = await sequenceFixture(t);
  const pending = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: pending } });
  for (let n = 0; n < 3; n += 1) await f.engine.run();
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
  assert.equal(merges(f).length, 0);
  assert.equal(pull.autoMerge, true);
  assert.equal(f.items()[0].armed, "auto");
});

test("allowMerge with neither merges only when mergeReady and sends headSha", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { autoMergeAllowed: false } });
  const pending = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: pending } });
  await f.engine.run();
  assert.equal(merges(f).length, 0);
  pull.contexts = GREEN;
  await f.engine.run();
  assert.equal(merges(f).length, 1);
  assert.equal(merges(f)[0].body.sha, pull.headSha);
  assert.equal(merges(f)[0].body.merge_method, "squash");
  // The merge finishes the ticket in the same pass and starts the next one.
  assert.equal(f.items()[0].state, "done");
  assert.equal(f.items()[1].state, "running");
});

test("UNSTABLE with green required checks merges; a red required check never does", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { autoMergeAllowed: false } });
  const contexts = [
    { ...GREEN[0], conclusion: "FAILURE" },
    {
      __typename: "CheckRun",
      name: "lint",
      status: "COMPLETED",
      conclusion: "FAILURE",
      isRequired: false,
    },
  ];
  const pull = await awaitingMerge(f, {
    allowMerge: true,
    pull: { contexts, mergeStateStatus: "UNSTABLE" },
  });
  await f.engine.run();
  assert.equal(merges(f).length, 0);
  pull.contexts = [GREEN[0], contexts[1]];
  await f.engine.run();
  assert.equal(merges(f).length, 1);
});

test("never merges with red required checks or changes requested", async (t) => {
  const f = await sequenceFixture(t);
  const calls = [];
  let snapshot;
  const forge = {
    ...prForge,
    readPullRequest: async () => structuredClone(snapshot),
    mergePullRequest: async (_access, pr) => calls.push({ name: "merge", pr }),
    enqueue: async (_access, pr) => calls.push({ name: "enqueue", pr }),
    enableAutoMerge: async (_access, pr) => calls.push({ name: "auto", pr }),
    dequeue: async (_access, pr) => calls.push({ name: "dequeue", pr }),
    disableAutoMerge: async (_access, pr) => calls.push({ name: "disable", pr }),
  };
  const engine = f.build({ forge });
  let n = 100;
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        mergeStateStatus: fc.constantFrom(
          "CLEAN",
          "HAS_HOOKS",
          "UNSTABLE",
          "BLOCKED",
          "BEHIND",
          "DIRTY",
          "UNKNOWN",
          null,
        ),
        reviewDecision: fc.constantFrom(
          null,
          "APPROVED",
          "CHANGES_REQUESTED",
          "REVIEW_REQUIRED",
        ),
        checks: fc.array(
          fc.record({
            name: fc.constantFrom("ci", "lint"),
            state: fc.constantFrom("success", "failure", "pending"),
            required: fc.boolean(),
          }),
          { maxLength: 4 },
        ),
        autoMerge: fc.boolean(),
        inMergeQueue: fc.boolean(),
        repo: fc.record({ autoMergeAllowed: fc.boolean(), mergeQueue: fc.boolean() }),
      }),
      async (shape) => {
        n += 1;
        const key = `acme/app#${n}`;
        f.append([key], { allowMerge: true });
        const item = f.items().find((entry) => entry.key === key);
        f.store.patch("p1", item.id, { state: "running", startedAt: T0 });
        f.store.patch("p1", item.id, {
          state: "awaiting-merge",
          pr: { number: n, url: `https://github.com/acme/app/pull/${n}`, headRef: "b" },
        });
        snapshot = {
          id: `PR_${n}`,
          number: n,
          url: `https://github.com/acme/app/pull/${n}`,
          state: "OPEN",
          headRef: "b",
          headSha: "a".repeat(40),
          baseRef: "main",
          mergeable: "MERGEABLE",
          ...shape,
          repo: { ...shape.repo, defaultMergeMethod: "MERGE", defaultBranch: "main" },
        };
        calls.length = 0;
        await engine.advance("p1");
        const verdict = prVerdict(snapshot);
        for (const call of calls) {
          if (call.name === "merge") assert.ok(verdict.mergeReady);
          if (["merge", "enqueue", "auto"].includes(call.name))
            assert.equal(verdict.changesRequested, false);
        }
        assert.ok(calls.filter((call) => call.name === "merge").length <= 1);
        f.store.patch("p1", item.id, { state: "done" });
      },
    ),
    { numRuns: 120 },
  );
});

test("changes requested after auto-merge disarms it", async (t) => {
  const f = await sequenceFixture(t);
  const pending = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: pending } });
  await f.engine.run();
  assert.equal(pull.autoMerge, true);
  pull.reviewDecision = "CHANGES_REQUESTED";
  await f.engine.run();
  assert.equal(mutations(f, "disablePullRequestAutoMerge").length, 1);
  assert.equal(pull.autoMerge, false);
  assert.equal(f.items()[0].armed, null);
  await f.engine.run();
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
  assert.equal(merges(f).length, 0);
});

test("changes requested after enqueue dequeues", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const pull = await awaitingMerge(f, { allowMerge: true });
  assert.equal(pull.inMergeQueue, true);
  pull.reviewDecision = "CHANGES_REQUESTED";
  await f.engine.run();
  assert.equal(mutations(f, "dequeuePullRequest").length, 1);
  assert.equal(pull.inMergeQueue, false);
  assert.equal(f.items()[0].armed, null);
});

test("a nudge from an action's first synchronous tick returns a promise", async (t) => {
  const f = await sequenceFixture(t);
  let nudged;
  const result = await f.engine.exclusive("p1", () => {
    nudged = f.engine.nudge("p1");
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(typeof nudged?.then, "function");
  await nudged;
  while (f.engine.locks.size)
    await Promise.all([...f.engine.locks.values()].map((lock) => lock.promise));
  assert.equal(f.engine.locks.size, 0);
});
