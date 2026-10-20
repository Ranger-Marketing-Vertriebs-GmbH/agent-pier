import test from "node:test";
import assert from "node:assert/strict";
import {
  stageProfiles,
  validateGraph,
} from "../../server/features/pipelines/graph-validation.js";
import {
  compileSnapshot,
  failDecision,
  loopResetSet,
} from "../../server/features/pipelines/graph-navigation.js";
import { joinVerdict } from "../../server/features/pipelines/parallel-group.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const messages = serverMessages.pipelineGraph;
const group = (members, extra = {}) => ({
  id: "review",
  kind: "parallel",
  members: members.map((id) => ({ id, profileId: `p-${id}` })),
  ...extra,
});
const graph = (review, edges = []) => ({
  entry: "build",
  nodes: [{ id: "build", kind: "profile", profileId: "p-build" }, review],
  edges: [{ from: "build", to: "review", condition: "default" }, ...edges],
});

test("a parallel group validates its members, concurrency and routing", () => {
  const valid = validateGraph(
    graph(group(["security", "code"], { concurrency: 1 }), [
      { from: "review", to: "build", condition: "fail", maxIterations: 2 },
    ]),
  );
  assert.deepEqual(valid.nodes[1], group(["security", "code"], { concurrency: 1 }));
  assert.deepEqual(
    stageProfiles(valid).map((s) => [s.id, s.profileId]),
    [
      ["build", "p-build"],
      ["security", "p-security"],
      ["code", "p-code"],
    ],
  );
  for (const members of [["solo"], Array.from({ length: 9 }, (_, i) => `m${i}`)])
    assert.throws(() => validateGraph(graph(group(members))), {
      message: messages.invalidParallelGroup("review"),
    });
  // Member ids share the node namespace and must be unique.
  for (const members of [
    ["code", "code"],
    ["build", "code"],
  ])
    assert.throws(() => validateGraph(graph(group(members))), {
      message: messages.invalidParallelGroup("review"),
    });
  assert.throws(
    () =>
      validateGraph({
        ...graph(group(["security", "code"])),
        nodes: [
          ...graph(group(["security", "code"])).nodes,
          { id: "code", kind: "gate" },
        ],
      }),
    { message: messages.invalidNodeId },
  );
  for (const concurrency of [0, 3, 1.5])
    assert.throws(() => validateGraph(graph(group(["a", "b"], { concurrency }))), {
      message: messages.invalidParallelConcurrency("review"),
    });
  assert.throws(
    () =>
      validateGraph(
        graph({
          ...group(["a", "b"]),
          members: [{ id: "a" }, { id: "b", profileId: "p" }],
        }),
      ),
    { message: messages.invalidParallelGroup("review") },
  );
  // Edges name the group, never a member; a loop never returns into a group.
  assert.throws(
    () =>
      validateGraph(
        graph(group(["a", "b"]), [{ from: "a", to: "build", condition: "fail" }]),
      ),
    { message: messages.invalidEdge("a", "build", "fail") },
  );
  assert.throws(
    () =>
      validateGraph({
        entry: "build",
        nodes: [
          { id: "build", kind: "profile", profileId: "p" },
          group(["a", "b"]),
          { id: "fix", kind: "profile", profileId: "p" },
        ],
        edges: [
          { from: "build", to: "review", condition: "default" },
          { from: "review", to: "fix", condition: "default" },
          { from: "fix", to: "review", condition: "fail", maxIterations: 1 },
        ],
      }),
    { message: messages.failEdgeIntoParallelGroup("review") },
  );
  assert.throws(
    () =>
      validateGraph({
        entry: "review",
        nodes: [group(["a", "b"])],
        edges: [],
      }),
    { message: messages.entryMustBeProfile },
  );
});

test("a group compiles to a routing node and one node per member", () => {
  const pipeline = {
    graph: validateGraph(
      graph(group(["security", "code"]), [
        { from: "review", to: "build", condition: "fail", maxIterations: 2 },
      ]),
    ),
  };
  const profile = (id) => ({ id, name: id.toUpperCase(), config: {} });
  const compiled = compileSnapshot({
    pipeline,
    profiles: Object.fromEntries(
      ["p-build", "p-security", "p-code"].map((id) => [id, profile(id)]),
    ),
  });
  assert.deepEqual(
    compiled.nodes.map((n) => [n.id, n.kind, n.group]),
    [
      ["build", undefined, undefined],
      ["review", "parallel", undefined],
      ["security", undefined, "review"],
      ["code", undefined, "review"],
    ],
  );
  const review = compiled.nodes[1];
  assert.deepEqual(review.members, ["security", "code"]);
  assert.equal(review.concurrency, 2);
  assert.equal(review.label, "P-SECURITY · P-CODE");
  // The loop reset set includes the group and its members.
  const edge = compiled.edges.find((e) => e.condition === "fail");
  assert.deepEqual(
    new Set(loopResetSet(compiled, edge)),
    new Set(["build", "review", "security", "code"]),
  );
});

const run = (loop = true) => ({
  edges: loop
    ? [{ from: "review", to: "build", condition: "fail", maxIterations: 2 }]
    : [],
  loopState: {},
});
const member = (id, verdict, extra = {}) => ({
  id,
  group: "review",
  profileSnapshot: { name: id },
  verdict,
  ...extra,
});
const low = { severity: "low", title: "Nit" };
const high = { severity: "high", title: "Hole" };

test("the join fails when any member fails and keeps every finding tagged", () => {
  const joined = joinVerdict(run(), { id: "review" }, [
    member("security", { result: "fail", summary: "Bad", findings: [high] }),
    member("code", { result: "pass", summary: "Good", findings: [low] }),
  ]);
  assert.equal(joined.result, "fail");
  assert.equal(joined.requiresHuman, false);
  assert.deepEqual(joined.findings, [
    { ...high, member: "security", profile: "security" },
    { ...low, member: "code", profile: "code" },
  ]);
  assert.equal(joined.summary, "security: Bad\ncode: Good");
  // The group never re-applies the low-only rule to the merged findings.
  const node = { id: "review", kind: "parallel" };
  const lowOnlyMerge = joinVerdict(run(), node, [
    member("security", { result: "fail", summary: "?", findings: [] }),
    member("code", { result: "pass", summary: "ok", findings: [low] }),
  ]);
  assert.equal(lowOnlyMerge.result, "fail");
  assert.equal(failDecision(run(), node, lowOnlyMerge), "loop");
});

test("the low-only rule applies per member and only on a bounded loop", () => {
  const members = [
    member("security", { result: "fail", summary: "Minor", findings: [low] }),
    member("code", { result: "pass", summary: "ok", findings: [] }),
  ];
  assert.equal(joinVerdict(run(true), { id: "review" }, members).result, "pass");
  assert.equal(joinVerdict(run(false), { id: "review" }, members).result, "fail");
});

test("one member requiring a person makes the group require one", () => {
  const joined = joinVerdict(run(), { id: "review" }, [
    member("security", {
      result: "pass",
      summary: "Ask",
      findings: [],
      requiresHuman: true,
      question: "Ship it?",
      files: ["a.js"],
    }),
    member("code", undefined, { overridden: true }),
  ]);
  assert.equal(joined.result, "pass");
  assert.equal(joined.requiresHuman, true);
  assert.equal(joined.question, "Ship it?");
  assert.deepEqual(joined.files, ["a.js"]);
  assert.deepEqual(joined.members[1], {
    nodeId: "code",
    result: null,
    passes: true,
    overridden: true,
  });
});
