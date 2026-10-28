import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationCoordinator } from "../../web/lib/navigation-guard.js";
import { createNavigationRunner } from "../../web/app/navigation-runner.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// A runner on a real coordinator whose guard answers each request in turn.
function setup() {
  const coordinator = createNavigationCoordinator({ target: null });
  const decisions = [];
  coordinator.register(() => {
    const decision = deferred();
    decisions.push(decision);
    return decision.promise;
  });
  const commits = [];
  let retries = 0;
  const run = createNavigationRunner({
    request: (request) => coordinator.request(request),
    commit: (next) => commits.push(next.view),
    retry: () => (retries += 1),
  });
  const decide = async (accepted) => {
    while (!decisions.length) await new Promise((resolve) => setImmediate(resolve));
    decisions.shift().resolve(accepted);
  };
  return { run, commits, decide, retries: () => retries };
}

test("the page redirect wins over a normalization in the same commit", async () => {
  const { run, commits, decide, retries } = setup();
  const redirect = run({ view: "redirect" }, true);
  // Computed from the older address: it waits instead of replacing the redirect.
  assert.equal(await run({ view: "stale" }, true, true), false);
  assert.equal(run.pending(), 1);
  await decide(true);
  assert.equal(await redirect, true);
  assert.deepEqual(commits, ["redirect"]);
  assert.equal(run.pending(), 0);
  // Retried once, for the new address.
  assert.equal(retries(), 1);
});

test("a normalization skipped during a declined navigation is retried", async () => {
  const { run, commits, decide, retries } = setup();
  const navigation = run({ view: "page" });
  assert.equal(await run({ view: "normalized" }, true, true), false);
  await decide(false);
  assert.equal(await navigation, false);
  assert.deepEqual(commits, []);
  assert.equal(run.pending(), 0);
  assert.equal(retries(), 1);
  // Now nothing is pending, so the retried normalization runs.
  const normalized = run({ view: "normalized" }, true, true);
  await decide(true);
  assert.equal(await normalized, true);
  assert.deepEqual(commits, ["normalized"]);
});

test("a superseded navigation retries a skipped normalization once both settle", async () => {
  const { run, commits, decide, retries } = setup();
  const first = run({ view: "first" });
  await run({ view: "normalized" }, true, true);
  const second = run({ view: "second" });
  // The first one's guard answers, but a later request replaced it.
  await decide(true);
  assert.equal(await first, false);
  assert.equal(retries(), 0);
  await decide(true);
  assert.equal(await second, true);
  assert.deepEqual(commits, ["second"]);
  assert.equal(retries(), 1);
});

test("without a pending navigation a normalization runs and nothing retries", async () => {
  const { run, commits, decide, retries } = setup();
  const normalized = run({ view: "normalized" }, true, true);
  await decide(true);
  assert.equal(await normalized, true);
  assert.deepEqual(commits, ["normalized"]);
  assert.equal(retries(), 0);
});
