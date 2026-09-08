import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  failDecision,
  loopResetSet,
} from "../../server/features/pipelines/graph-navigation.js";
import { parseVerdict } from "../../server/features/pipelines/stage-verdict.js";
test("automatic repair loops never exceed budget or bypass human-required verdicts", () => {
  check(
    fc.property(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 0, max: 30 }),
      fc.boolean(),
      (maxIterations, iterations, requiresHuman) => {
        const edge = { from: "review", to: "build", condition: "fail", maxIterations };
        const run = { edges: [edge], loopState: { "review->build": { iterations } } };
        const decision = failDecision(
          run,
          { id: "review" },
          {
            result: "fail",
            summary: "Finding",
            requiresHuman,
            findings: [{ severity: "high", title: "Issue" }],
          },
        );
        if (requiresHuman || iterations >= maxIterations)
          assert.equal(decision, "escalate");
        else assert.equal(decision, "loop");
      },
    ),
  );
});
test("loop reset excludes unrelated branches across generated chains", () => {
  check(
    fc.property(fc.integer({ min: 2, max: 40 }), (size) => {
      const edges = Array.from({ length: size - 1 }, (_, i) => ({
        from: "n" + i,
        to: "n" + (i + 1),
        condition: "default",
      }));
      edges.push({ from: "n0", to: "other", condition: "pass" });
      const edge = {
        from: "n" + (size - 1),
        to: "n0",
        condition: "fail",
        maxIterations: 2,
      };
      assert.deepEqual(
        new Set(loopResetSet({ edges: [...edges, edge] }, edge)),
        new Set(Array.from({ length: size }, (_, i) => "n" + i)),
      );
    }),
  );
});
test("only explicit recognized result words can authorize a verdict", () => {
  const accepted = new Set([
    "pass",
    "passed",
    "success",
    "successful",
    "fail",
    "failed",
    "failure",
    "unsuccessful",
  ]);
  check(
    fc.property(
      fc.oneof(
        fc.string({ maxLength: 40 }),
        fc.constantFrom("__proto__", "constructor", "toString"),
      ),
      (result) => {
        const raw = JSON.stringify({ result, summary: "Summary" });
        if (accepted.has(result.trim().toLowerCase()))
          assert.ok(["pass", "fail"].includes(parseVerdict(raw).result));
        else assert.throws(() => parseVerdict(raw));
      },
    ),
  );
});
