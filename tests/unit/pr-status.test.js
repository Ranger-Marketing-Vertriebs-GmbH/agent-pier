import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { branchMatchesKey, prVerdict } from "../../server/features/tickets/pr-status.js";

function snapshot(extra = {}) {
  return {
    state: "OPEN",
    headSha: "a".repeat(40),
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    checks: [],
    ...extra,
  };
}

const check = (name, state, required = false) => ({ name, state, required });

test("required checks decide when present", () => {
  const both = prVerdict(
    snapshot({
      checks: [check("build", "failure", true), check("lint", "failure")],
      mergeStateStatus: "BLOCKED",
    }),
  );
  assert.equal(both.checks, "failed");
  assert.deepEqual(both.failed, ["build"]);
  const optional = prVerdict(
    snapshot({ checks: [check("build", "success", true), check("lint", "failure")] }),
  );
  assert.equal(optional.checks, "passed");
  assert.deepEqual(optional.failed, []);
  assert.equal(optional.mergeReady, true);
});

test("without required checks every check counts", () => {
  const verdict = prVerdict(
    snapshot({ checks: [check("build", "success"), check("lint", "failure")] }),
  );
  assert.equal(verdict.checks, "failed");
  assert.deepEqual(verdict.failed, ["lint"]);
  assert.equal(verdict.mergeReady, false);
});

test("pending wins over passed", () => {
  const verdict = prVerdict(
    snapshot({ checks: [check("build", "success"), check("e2e", "pending")] }),
  );
  assert.equal(verdict.checks, "pending");
  assert.equal(verdict.mergeReady, false);
});

test("a failure wins over pending", () => {
  const verdict = prVerdict(
    snapshot({ checks: [check("build", "failure"), check("e2e", "pending")] }),
  );
  assert.equal(verdict.checks, "failed");
});

test("no checks at all counts as passed", () => {
  const verdict = prVerdict(snapshot());
  assert.equal(verdict.checks, "passed");
  assert.equal(verdict.mergeReady, true);
  assert.equal(verdict.headSha, "a".repeat(40));
});

test("CHANGES_REQUESTED blocks mergeReady even with green checks", () => {
  const verdict = prVerdict(
    snapshot({
      reviewDecision: "CHANGES_REQUESTED",
      checks: [check("build", "success", true)],
    }),
  );
  assert.equal(verdict.checks, "passed");
  assert.equal(verdict.changesRequested, true);
  assert.equal(verdict.reviewBlocks, true);
  assert.equal(verdict.mergeReady, false);
});

test("REVIEW_REQUIRED sets reviewBlocks", () => {
  const verdict = prVerdict(snapshot({ reviewDecision: "REVIEW_REQUIRED" }));
  assert.equal(verdict.reviewBlocks, true);
  assert.equal(verdict.changesRequested, false);
  assert.equal(verdict.mergeReady, false);
  assert.equal(prVerdict(snapshot({ reviewDecision: "APPROVED" })).reviewBlocks, false);
});

test("mergeReady needs CLEAN or HAS_HOOKS", () => {
  for (const status of ["CLEAN", "HAS_HOOKS"])
    assert.equal(prVerdict(snapshot({ mergeStateStatus: status })).mergeReady, true);
  for (const status of ["BLOCKED", "UNSTABLE", "BEHIND", "DIRTY", "UNKNOWN", null])
    assert.equal(prVerdict(snapshot({ mergeStateStatus: status })).mergeReady, false);
});

test("merged and closed pull requests are never merge-ready", () => {
  const merged = prVerdict(snapshot({ state: "MERGED" }));
  assert.equal(merged.status, "merged");
  assert.equal(merged.mergeReady, false);
  const closed = prVerdict(snapshot({ state: "CLOSED" }));
  assert.equal(closed.status, "closed");
  assert.equal(closed.mergeReady, false);
});

test("branchMatchesKey uses separators as boundaries", () => {
  const github = { source: "github", key: "acme/app#12" };
  assert.equal(branchMatchesKey("ticket/12-fix", github), true);
  assert.equal(branchMatchesKey("12", github), true);
  assert.equal(branchMatchesKey("feature/12_x", github), true);
  assert.equal(branchMatchesKey("fix-120", github), false);
  assert.equal(branchMatchesKey("v112-x", github), false);
  const plane = { source: "plane", key: "AP-12" };
  assert.equal(branchMatchesKey("ticket/ap-12-x", plane), true);
  assert.equal(branchMatchesKey("AP-12", plane), true);
  assert.equal(branchMatchesKey("ap-123", plane), false);
  assert.equal(branchMatchesKey("xap-12", plane), false);
  assert.equal(branchMatchesKey("ticket/12-x", { key: "acme/app#12" }), true);
  assert.equal(branchMatchesKey(undefined, github), false);
});

test("branchMatchesKey never matches a longer number", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 99999 }),
      fc.integer({ min: 0, max: 9 }),
      fc.constantFrom("", "ticket/", "fix-", "a."),
      fc.constantFrom("", "-x", "/y", "_z"),
      (number, digit, prefix, suffix) => {
        const ticket = { source: "github", key: `acme/app#${number}` };
        assert.equal(branchMatchesKey(`${prefix}${number}${suffix}`, ticket), true);
        assert.equal(
          branchMatchesKey(`${prefix}${number}${digit}${suffix}`, ticket),
          false,
        );
        assert.equal(
          branchMatchesKey(`${prefix}${digit + 1}${number}${suffix}`, ticket),
          false,
        );
      },
    ),
  );
});
