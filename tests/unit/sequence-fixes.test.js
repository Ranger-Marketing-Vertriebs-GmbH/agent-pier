import test from "node:test";
import assert from "node:assert/strict";
import {
  FORGE_LIMIT_MS,
  IDLE_LIMIT_MS,
  MAX_FAILED_ROUNDS,
  fixDecision,
  repairDefaults,
} from "../../server/features/tickets/sequence-fixes.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const MIN = 60_000;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const rounds = (extra = {}) => ({
  failed: 0,
  lastSha: null,
  lastReview: null,
  lastActionAt: null,
  ...extra,
});
const item = (extra = {}) => ({ id: "i1", kind: "session", rounds: rounds(), ...extra });
const red = (headSha = A, extra = {}) => ({
  status: "open",
  checks: "failed",
  failed: ["ci"],
  changesRequested: false,
  headSha,
  ...extra,
});
const working = { exists: true, state: "working", since: NOW - 5 * MIN };
const idle = (since) => ({ exists: true, state: "idle", since });
const missing = { exists: false, state: "unknown", since: null };

test("the limits are the agreed values", () => {
  assert.equal(IDLE_LIMIT_MS, 30 * MIN);
  assert.equal(FORGE_LIMIT_MS, 30 * MIN);
  assert.equal(MAX_FAILED_ROUNDS, 3);
});

test("a new failing head notifies a session ticket and counts a round", () => {
  const decision = fixDecision({
    item: item(),
    verdict: red(),
    worker: working,
    now: NOW,
  });
  assert.equal(decision.action, "notify");
  assert.deepEqual(decision.notice, { checks: true, review: false });
  assert.deepEqual(decision.rounds, rounds({ failed: 1, lastSha: A, lastActionAt: NOW }));
});

test("the same failing sha never notifies twice", () => {
  const first = fixDecision({ item: item(), verdict: red(), worker: working, now: NOW });
  const again = fixDecision({
    item: item({ rounds: first.rounds }),
    verdict: red(),
    worker: working,
    now: NOW + MIN,
  });
  assert.equal(again.action, "none");
  assert.deepEqual(again.rounds, first.rounds);
});

test("a third failing sha parks with failedRounds", () => {
  const decision = fixDecision({
    item: item({ rounds: rounds({ failed: 2, lastSha: B }) }),
    verdict: red(C),
    worker: working,
    now: NOW,
  });
  assert.equal(decision.action, "park");
  assert.equal(decision.reason, "failedRounds");
  assert.equal(decision.rounds.failed, 3);
});

test("a pipeline ticket without a live repair session gets a repair", () => {
  for (const worker of [missing, { exists: true, state: "stopped", since: null }]) {
    const decision = fixDecision({
      item: item({ kind: "pipeline" }),
      verdict: red(),
      worker,
      now: NOW,
    });
    assert.equal(decision.action, "repair");
    assert.equal(decision.rounds.failed, 1);
  }
});

test("pipeline ticket with a live repair session notifies it instead of starting another", () => {
  const decision = fixDecision({
    item: item({ kind: "pipeline", rounds: rounds({ failed: 1, lastSha: A }) }),
    verdict: red(B),
    worker: idle(NOW - MIN),
    now: NOW,
  });
  assert.equal(decision.action, "notify");
  assert.equal(decision.rounds.failed, 2);
});

test("a new changes-requested review notifies without counting a round", () => {
  const verdict = { ...red(A), checks: "passed", failed: [], changesRequested: true };
  const decision = fixDecision({ item: item(), verdict, worker: working, now: NOW });
  assert.equal(decision.action, "notify");
  assert.deepEqual(decision.notice, { checks: false, review: true });
  assert.deepEqual(decision.rounds, rounds({ lastReview: A, lastActionAt: NOW }));
  const again = fixDecision({
    item: item({ rounds: decision.rounds }),
    verdict,
    worker: working,
    now: NOW + MIN,
  });
  assert.equal(again.action, "none");
  // The review still stands on a new head: answered once more, still no round.
  const pushed = fixDecision({
    item: item({ rounds: decision.rounds }),
    verdict: { ...verdict, headSha: B },
    worker: working,
    now: NOW + MIN,
  });
  assert.equal(pushed.action, "notify");
  assert.equal(pushed.rounds.failed, 0);
});

test("failing checks and a review on one new head are one action", () => {
  const verdict = red(A, { changesRequested: true });
  const decision = fixDecision({ item: item(), verdict, worker: working, now: NOW });
  assert.equal(decision.action, "notify");
  assert.deepEqual(decision.notice, { checks: true, review: true });
  assert.equal(decision.rounds.failed, 1);
});

test("green or pending PRs need nothing, whatever the worker does", () => {
  for (const checks of ["passed", "pending"])
    for (const worker of [missing, idle(NOW - 60 * MIN)]) {
      const decision = fixDecision({
        item: item({ rounds: rounds({ failed: 2, lastSha: B, lastActionAt: 1 }) }),
        verdict: { ...red(A), checks, failed: [] },
        worker,
        now: NOW,
      });
      assert.equal(decision.action, "none");
    }
});

test("a red PR with an idle worker parks after 30 minutes", () => {
  const handled = item({ rounds: rounds({ failed: 1, lastSha: A, lastActionAt: 1 }) });
  const at = (minutes, worker) =>
    fixDecision({ item: handled, verdict: red(), worker, now: NOW + minutes * MIN });
  assert.equal(at(29, idle(NOW)).action, "none");
  const parked = at(30, idle(NOW));
  assert.equal(parked.action, "park");
  assert.equal(parked.reason, "idle");
  assert.deepEqual(parked.rounds, handled.rounds);
});

test("idle counts from the later of idle-since and the last notice", () => {
  const noticed = NOW + 10 * MIN;
  const handled = item({
    rounds: rounds({ failed: 1, lastSha: A, lastActionAt: noticed }),
  });
  const decide = (now, worker) =>
    fixDecision({ item: handled, verdict: red(), worker, now }).action;
  // Idle since NOW, notified 10 minutes later: the clock starts at the notice.
  assert.equal(decide(NOW + 35 * MIN, idle(NOW)), "none");
  assert.equal(decide(noticed + 30 * MIN, idle(NOW)), "park");
  // Idle only after the notice: the clock starts at idle.
  const later = noticed + 20 * MIN;
  assert.equal(decide(noticed + 30 * MIN, idle(later)), "none");
  assert.equal(decide(later + 30 * MIN, idle(later)), "park");
  // A stopped or gone worker counts from the notice.
  assert.equal(decide(noticed + 30 * MIN, missing), "park");
  assert.equal(
    decide(noticed + 30 * MIN, { exists: true, state: "stopped", since: null }),
    "park",
  );
});

test("working sessions never park for idle", () => {
  const handled = item({ rounds: rounds({ failed: 1, lastSha: A, lastActionAt: 1 }) });
  for (const state of ["working", "waiting", "unknown"]) {
    const decision = fixDecision({
      item: handled,
      verdict: red(),
      worker: { exists: true, state, since: 1 },
      now: NOW + 600 * MIN,
    });
    assert.equal(decision.action, "none", state);
  }
});

test("changes requested also count as red for the idle limit", () => {
  const handled = item({
    rounds: rounds({ lastReview: A, lastActionAt: NOW }),
  });
  const verdict = { ...red(A), checks: "passed", failed: [], changesRequested: true };
  const decision = fixDecision({
    item: handled,
    verdict,
    worker: idle(NOW),
    now: NOW + 31 * MIN,
  });
  assert.equal(decision.action, "park");
  assert.equal(decision.reason, "idle");
});

test("a merged or closed PR needs nothing", () => {
  for (const status of ["merged", "closed"])
    assert.equal(
      fixDecision({
        item: item(),
        verdict: red(A, { status }),
        worker: missing,
        now: NOW,
      }).action,
      "none",
    );
});

test("repairDefaults takes the newest coding session in the project or below", async () => {
  const sessions = {
    list: async () => [
      {
        id: "1",
        tool: "codex",
        accountId: "old",
        cwd: "/repo",
        createdAt: "2026-11-01T00:00:00Z",
      },
      {
        id: "2",
        tool: "claude",
        accountId: "a2",
        nativeModelId: "opus",
        launchMode: "plan",
        cwd: "/repo/.worktrees/x",
        createdAt: "2026-11-03T00:00:00Z",
      },
      {
        id: "3",
        tool: "shell",
        accountId: "sh",
        cwd: "/repo",
        createdAt: "2026-11-04T00:00:00Z",
      },
      {
        id: "4",
        tool: "claude",
        accountId: "x",
        cwd: "/repo-other",
        createdAt: "2026-11-05T00:00:00Z",
      },
      {
        id: "5",
        tool: "claude",
        accountId: "p",
        cwd: "/repo",
        pipeline: { runId: "r" },
        createdAt: "2026-11-06T00:00:00Z",
      },
    ],
  };
  assert.deepEqual(await repairDefaults(sessions, "/repo"), {
    tool: "claude",
    accountId: "a2",
    nativeModelId: "opus",
    launchMode: "plan",
  });
  assert.equal(await repairDefaults(sessions, "/elsewhere"), null);
});

test("repairDefaults keeps a provider connection instead of the account", async () => {
  const sessions = {
    list: async () => [
      {
        id: "1",
        tool: "claude",
        accountId: "provider-account",
        cwd: "/repo",
        access: { providerConnectionId: "pc1", providerModelId: "m1" },
        createdAt: "2026-11-03T00:00:00Z",
      },
    ],
  };
  assert.deepEqual(await repairDefaults(sessions, "/repo"), {
    tool: "claude",
    providerConnectionId: "pc1",
    providerModelId: "m1",
  });
});
