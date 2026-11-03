import test from "node:test";
import assert from "node:assert/strict";
import * as prForge from "../../server/features/tickets/pr-forge.js";
import { TicketSourceError } from "../../server/features/tickets/http-json.js";
import { PARK_REASONS } from "../../server/features/tickets/sequence-engine.js";
import {
  GREEN,
  awaitingMerge,
  forgeMerges as merges,
  forgeMutations as mutations,
  sequenceFixture,
} from "../helpers/sequence-fixture.js";

const PENDING = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
const RED = [{ ...GREEN[0], conclusion: "FAILURE" }];
const passes = async (engine, count = 3) => {
  for (let n = 0; n < count; n += 1) await engine.run();
};

/** A forge whose `name` call fails with `code` and is counted. */
function refusingForge(name, code) {
  const calls = [];
  return {
    calls,
    forge: {
      ...prForge,
      [name]: async () => {
        calls.push(name);
        throw new TicketSourceError(code);
      },
    },
  };
}

test("an auto-merge the owner disabled on GitHub is not armed again; the queue parks", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  assert.equal(pull.autoMerge, true);
  assert.equal(f.items()[0].armedHead, pull.headSha);
  pull.autoMerge = false;
  await passes(f.engine);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "mergeDisarmed");
  assert.equal(f.notified.length, 1);
});

test("a PR the merge queue dropped is not enqueued again; the queue parks", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const pull = await awaitingMerge(f, { allowMerge: true });
  assert.equal(pull.inMergeQueue, true);
  pull.inMergeQueue = false;
  await passes(f.engine);
  assert.equal(mutations(f, "enqueuePullRequest").length, 1);
  assert.equal(f.items()[0].needsOwner.reason, "mergeDisarmed");
  assert.equal(f.notified.length, 1);
});

test("a disarmed head with red checks waits for the fix rounds", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  pull.autoMerge = false;
  pull.contexts = RED;
  await passes(f.engine);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.notified.length, 0);
});

test("a new push may be armed once more", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  pull.autoMerge = false;
  pull.headSha = "b".repeat(40);
  await passes(f.engine);
  const enabled = mutations(f, "enablePullRequestAutoMerge");
  assert.equal(enabled.length, 2);
  assert.equal(enabled[1].body.variables.input.expectedHeadOid, "b".repeat(40));
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.items()[0].armedHead, "b".repeat(40));
});

test("auto-merge is enabled while checks are pending", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  assert.equal(pull.autoMerge, true);
  assert.equal(f.items()[0].armed, "auto");
});

test("a merge queue is entered only with green counted checks", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  await passes(f.engine);
  pull.contexts = RED;
  await passes(f.engine);
  assert.equal(mutations(f, "enqueuePullRequest").length, 0);
  pull.contexts = GREEN;
  await f.engine.run();
  assert.equal(mutations(f, "enqueuePullRequest").length, 1);
  assert.equal(pull.inMergeQueue, true);
});

test("a refused auto-merge on a pending head is recorded, never retried, and parks once ready", async (t) => {
  const f = await sequenceFixture(t);
  const { forge, calls } = refusingForge("enableAutoMerge", "invalidResponse");
  const engine = f.build({ forge });
  const pull = await awaitingMerge(f, {
    engine,
    allowMerge: true,
    pull: { contexts: PENDING },
  });
  await passes(engine);
  assert.equal(calls.length, 1);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.deepEqual(f.items()[0].refused, {
    headSha: pull.headSha,
    what: "arm",
    code: "invalidResponse",
  });
  pull.contexts = GREEN;
  await engine.run();
  assert.equal(calls.length, 1);
  assert.equal(f.items()[0].needsOwner.reason, "armRefused");
  assert.equal(f.notified.length, 1);
});

test("a refused enqueue of a ready head parks with armRefused", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const { forge, calls } = refusingForge("enqueue", "forbidden");
  const engine = f.build({ forge });
  const pull = await awaitingMerge(f, {
    engine,
    allowMerge: true,
    pull: { contexts: PENDING },
  });
  assert.equal(calls.length, 0);
  pull.contexts = GREEN;
  await passes(engine);
  assert.equal(calls.length, 1);
  assert.equal(f.items()[0].needsOwner.reason, "armRefused");
  assert.equal(f.notified.length, 1);
});

test("a refused merge of a ready head parks with mergeRefused", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { autoMergeAllowed: false } });
  const { forge, calls } = refusingForge("mergePullRequest", "invalidResponse");
  const engine = f.build({ forge });
  const pull = await awaitingMerge(f, {
    engine,
    allowMerge: true,
    pull: { contexts: PENDING },
  });
  pull.contexts = GREEN;
  await passes(engine);
  assert.equal(calls.length, 1);
  assert.equal(f.items()[0].needsOwner.reason, "mergeRefused");
  assert.equal(f.items()[0].refused.what, "merge");
  assert.equal(f.notified.length, 1);
});

test("rate limits and outages only skip the pass", async (t) => {
  for (const code of ["rateLimited", "unavailable", "unreachable"]) {
    const f = await sequenceFixture(t, { repoSettings: { autoMergeAllowed: false } });
    const { forge, calls } = refusingForge("mergePullRequest", code);
    const engine = f.build({ forge });
    await awaitingMerge(f, { engine, allowMerge: true });
    await passes(engine);
    assert.equal(calls.length, 4);
    assert.equal(f.items()[0].state, "awaiting-merge");
    assert.equal(f.items()[0].refused, undefined);
    assert.equal(f.notified.length, 0);
    assert.equal(merges(f).length, 0);
  }
});

test("every park reason the engine uses is listed once", () => {
  assert.equal(new Set(PARK_REASONS).size, PARK_REASONS.length);
  for (const reason of ["mergeDisarmed", "armRefused", "mergeRefused", "startFailed"])
    assert.ok(PARK_REASONS.includes(reason));
});
