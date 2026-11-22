// A token that may not read checks (a fine-grained token without "Checks" and "Commit
// statuses"): GitHub answers the pull request with a FORBIDDEN error on the check
// rollup only. The PR's state stays readable, so a merged PR still finishes its ticket.
import test from "node:test";
import assert from "node:assert/strict";
import { readPullRequest } from "../../server/features/tickets/pr-forge.js";
import { prVerdict } from "../../server/features/tickets/pr-status.js";
import { PARK_REASONS } from "../../server/features/tickets/sequence-engine.js";
import { TicketSequenceService } from "../../server/features/tickets/sequence-service.js";
import { fakeGithubPulls, githubPull } from "../helpers/ticket-fakes.js";
import {
  GREEN,
  T0,
  awaitingMerge,
  forgeMerges as merges,
  forgeMutations as mutations,
  sequenceFixture,
} from "../helpers/sequence-fixture.js";

const MIN = 60_000;
const ROLLUP = ["repository", "pullRequest", "commits", "nodes", 0, "commit"];
const NO_CHECKS = {
  type: "FORBIDDEN",
  path: [...ROLLUP, "statusCheckRollup"],
  message: "Resource not accessible by personal access token",
};
// A fine-grained token with "Commit statuses: read": the single check runs stay hidden.
const NO_CHECK_RUNS = {
  type: "FORBIDDEN",
  path: [...ROLLUP, "statusCheckRollup", "contexts", "nodes", 0],
  message: "Resource not accessible by personal access token",
};
const RED = [{ ...GREEN[0], conclusion: "FAILURE" }];
const PENDING = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];

function service(f) {
  return new TicketSequenceService({
    store: f.store,
    engine: f.engine,
    tickets: f.tickets,
    sessions: f.sessionsApi,
    worktrees: f.worktrees,
    now: () => f.clock.now,
  });
}
async function settled(f) {
  while (f.engine.locks.size)
    await Promise.all([...f.engine.locks.values()].map((lock) => lock.promise));
}

test("readPullRequest keeps the PR when only its checks are forbidden", async (t) => {
  const graphqlErrors = [NO_CHECKS];
  const fake = await fakeGithubPulls(t, {
    pulls: [githubPull(1, { state: "MERGED", contexts: GREEN })],
    graphqlErrors,
  });
  const access = {
    host: "https://github.com",
    apiBase: "https://api.github.com",
    owner: "acme",
    repo: "app",
    token: "t",
    fetchImpl: fake.fetchImpl,
  };
  const pr = await readPullRequest(access, 1);
  assert.equal(pr.state, "MERGED");
  assert.equal(pr.checksUnreadable, true);
  assert.deepEqual(pr.checks, []);
  const verdict = prVerdict({ ...pr, state: "OPEN", mergeStateStatus: "CLEAN" });
  assert.equal(verdict.checks, "unknown");
  assert.equal(verdict.mergeReady, false);
  // Any other failure of that field is no permission answer: the read fails as before.
  graphqlErrors.splice(0, 1, { ...NO_CHECKS, type: "SERVICE_UNAVAILABLE" });
  await assert.rejects(readPullRequest(access, 1), { code: "invalidResponse" });
});

test("a readable PR reports its checks as readable", async (t) => {
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(1, { contexts: GREEN })] });
  const pr = await readPullRequest(
    {
      apiBase: "https://api.github.com",
      owner: "acme",
      repo: "app",
      token: "t",
      ...fake,
    },
    1,
  );
  assert.equal(pr.checksUnreadable, false);
  assert.equal(prVerdict(pr).checks, "passed");
});

test("a merged PR finishes its ticket although its checks are unreadable", async (t) => {
  const f = await sequenceFixture(t, { graphqlErrors: [NO_CHECKS] });
  const pull = await awaitingMerge(f);
  pull.state = "MERGED";
  await f.engine.run();
  const [first, second] = f.items();
  assert.equal(first.state, "done");
  assert.equal(first.doneBy, "merge");
  assert.notEqual(second.state, "waiting");
  assert.deepEqual(f.errors, []);
});

test("an open PR with unreadable checks is never merged and parks with its reason", async (t) => {
  assert.ok(PARK_REASONS.includes("checksUnreadable"));
  const graphqlErrors = [];
  const f = await sequenceFixture(t, { graphqlErrors });
  // Pending checks GitHub would let AgentPier arm, were they readable.
  const pull = await awaitingMerge(f, { pull: { contexts: PENDING } });
  f.store.patch("p1", f.items()[0].id, {
    options: { ...f.items()[0].options, allowMerge: true },
  });
  graphqlErrors.push(NO_CHECKS);
  await f.engine.run();
  const [first] = f.items();
  assert.equal(first.state, "needs-owner");
  assert.equal(first.needsOwner.reason, "checksUnreadable");
  assert.equal(merges(f).length, 0);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 0);
  assert.equal(f.notified.length, 1);
  // The owner merges it on GitHub: the parked ticket finishes and the queue moves on.
  pull.state = "MERGED";
  await f.engine.run();
  assert.equal(f.items()[0].state, "done");
  assert.equal(f.items()[0].needsOwner ?? null, null);
  assert.notEqual(f.items()[1].state, "waiting");
  assert.ok(f.sourceCalls.some((call) => call.name === "markDone"));
});

test("without Allow merge a PR with unreadable checks is watched until it merges", async (t) => {
  const f = await sequenceFixture(t, { graphqlErrors: [NO_CHECKS] });
  const pull = await awaitingMerge(f);
  f.clock.now = T0 + 45 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].state, "awaiting-merge");
  pull.state = "MERGED";
  await f.engine.run();
  assert.equal(f.items()[0].state, "done");
});

test("a ticket parked for an unreachable GitHub finishes once its merged PR is read", async (t) => {
  const failures = {};
  const f = await sequenceFixture(t, { failures });
  const pull = await awaitingMerge(f);
  failures["POST /graphql"] = 503;
  await f.engine.run();
  f.clock.now = T0 + 31 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "forgeUnreachable");
  const logged = f.errors.length;
  // Still down: the parked ticket stays, and its reads no longer fill the log.
  f.clock.now = T0 + 40 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.errors.length, logged);
  assert.equal(f.notified.length, 1);
  delete failures["POST /graphql"];
  // Open again: a parked ticket is not picked up by itself, only a merge finishes it.
  await f.engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  pull.state = "MERGED";
  await f.engine.run();
  assert.equal(f.items()[0].state, "done");
  assert.notEqual(f.items()[1].state, "waiting");
});

test("a parked ticket whose PR closed unmerged stays with the owner", async (t) => {
  const f = await sequenceFixture(t, { graphqlErrors: [NO_CHECKS] });
  const pull = await awaitingMerge(f);
  pull.state = "CLOSED";
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "prClosed");
  await f.engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[1].state, "waiting");
});

test("the owner may mark done or remove a ticket that awaits its merge", async (t) => {
  for (const action of ["markDone", "remove"]) {
    const f = await sequenceFixture(t);
    await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
    const [first] = f.items();
    assert.equal(first.state, "awaiting-merge");
    assert.equal(first.armed, "auto");
    const view = await service(f)[action]("p1", first.id);
    await settled(f);
    // Nobody watches the PR afterwards, so it is disarmed first.
    assert.equal(mutations(f, "disablePullRequestAutoMerge").length, 1, action);
    const left = view.queue.items.find((item) => item.id === first.id);
    if (action === "remove") assert.equal(left, undefined);
    else assert.equal(left.state, "done");
    assert.notEqual(f.items().at(-1).state, "waiting", action);
  }
});

test("an unreadable PR that awaits its merge needs the owner's confirmation", async (t) => {
  const failures = {};
  const f = await sequenceFixture(t, { failures });
  await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  const [first] = f.items();
  failures["POST /graphql"] = 503;
  await assert.rejects(service(f).markDone("p1", first.id), { status: 409 });
  assert.equal(f.items()[0].state, "awaiting-merge");
  const done = await service(f).markDone("p1", first.id, { force: true });
  assert.equal(done.queue.items[0].state, "done");
  assert.equal(done.queue.items[0].prUnchecked, true);
});

test("hidden check runs fall back to GitHub's overall check state", async (t) => {
  const pull = githubPull(1, { contexts: GREEN });
  const fake = await fakeGithubPulls(t, {
    pulls: [pull],
    graphqlErrors: [NO_CHECK_RUNS],
  });
  const access = {
    apiBase: "https://api.github.com",
    owner: "acme",
    repo: "app",
    ...fake,
  };
  const read = () => readPullRequest({ ...access, token: "t" }, 1);
  let pr = await read();
  assert.equal(pr.checksUnreadable, false);
  assert.deepEqual(pr.checks, [{ name: "checks", state: "success", required: false }]);
  assert.equal(prVerdict(pr).mergeReady, true);
  pull.contexts = PENDING;
  pr = await read();
  assert.equal(prVerdict(pr).checks, "pending");
  assert.equal(prVerdict(pr).mergeReady, false);
  pull.contexts = RED;
  pr = await read();
  assert.deepEqual(prVerdict(pr).failed, ["checks"]);
});

test("a PR with hidden check runs merges once GitHub's overall state is green", async (t) => {
  const f = await sequenceFixture(t, { graphqlErrors: [NO_CHECK_RUNS] });
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  // Pending: nothing is merged, and auto-merge is not armed on checks it cannot see.
  await f.engine.run();
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(merges(f).length, 0);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 0);
  pull.contexts = GREEN;
  await f.engine.run();
  assert.equal(merges(f).length, 1);
  assert.equal(f.items()[0].state, "done");
  assert.deepEqual(f.errors, []);
});
