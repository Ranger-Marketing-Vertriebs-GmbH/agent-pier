import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { validateGraph } from "../../server/features/pipelines/graph-validation.js";

function chain(count) {
  return {
    entry: "n0",
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      kind: "profile",
      profileId: "fixture",
    })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({
      from: `n${index}`,
      to: `n${index + 1}`,
      condition: "default",
    })),
  };
}
test("generated pipeline cycles require finite fail budgets and strip unknown fields", () => {
  check(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.integer({ min: 1, max: 5 }),
      (count, budget) => {
        const graph = chain(count);
        const loop = {
          from: `n${count - 1}`,
          to: "n0",
          condition: "fail",
          maxIterations: budget,
        };
        graph.edges.push(loop);
        graph.nodes[0].secret = "discard";
        assert.equal(validateGraph(graph).nodes[0].secret, undefined);
        delete loop.maxIterations;
        assert.throws(() => validateGraph(graph), /bounded fail/);
      },
    ),
  );
});
test("failure cannot use a default edge or ambiguous condition and side effects cannot be loop targets", () => {
  const graph = chain(2);
  graph.edges.push({ ...graph.edges[0] });
  assert.throws(() => validateGraph(graph), /one edge/);
  const side = {
    entry: "n0",
    nodes: [
      { id: "n0", kind: "profile", profileId: "fixture" },
      { id: "gate", kind: "gate" },
    ],
    edges: [{ from: "n0", to: "gate", condition: "fail" }],
  };
  assert.throws(() => validateGraph(side), /side-effect/);
  assert.throws(
    () => validateGraph({ ...chain(1), nodes: [{ id: "n0", kind: "updateTicket" }] }),
    /Unsupported/,
  );
});
