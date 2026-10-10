import test from "node:test";
import assert from "node:assert/strict";
import { validateGraph } from "../../server/features/pipelines/graph-validation.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

test("an invalid edge is named in the validation message", () => {
  const graph = {
    entry: "work",
    nodes: [{ id: "work", kind: "profile", profileId: "p" }],
    edges: [{ from: "work", to: "missing", condition: "default" }],
  };
  assert.throws(() => validateGraph(graph), {
    message: serverMessages.pipelineGraph.invalidEdge("work", "missing", "default"),
  });
  assert.match(
    serverMessages.pipelineGraph.invalidEdge("work", "missing", "default"),
    /work → missing \(default\)/,
  );
  const odd = { ...graph, edges: [{ from: { x: 1 }, to: "x".repeat(200) }] };
  assert.throws(
    () => validateGraph(odd),
    (error) => error.message.length < 200,
  );
});
