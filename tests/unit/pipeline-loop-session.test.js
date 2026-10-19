import test from "node:test";
import assert from "node:assert/strict";
import { validateGraph } from "../../server/features/pipelines/graph-validation.js";
import {
  contextExhausted,
  relaunchOptions,
  repairLaunch,
  sessionKey,
} from "../../server/features/pipelines/loop-session.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  graphToStages,
  stagesToGraph,
} from "../../web/features/pipelines/graph-editor.js";

const graph = (edge) => ({
  entry: "build",
  nodes: [
    { id: "build", kind: "profile", profileId: "p" },
    { id: "review", kind: "profile", profileId: "p" },
  ],
  edges: [
    { from: "build", to: "review", condition: "default" },
    { from: "review", to: "build", condition: "fail", maxIterations: 2, ...edge },
  ],
});

test("only a bounded loop edge may continue its target's session", () => {
  assert.deepEqual(validateGraph(graph({ continueSession: true })).edges[1], {
    from: "review",
    to: "build",
    condition: "fail",
    maxIterations: 2,
    continueSession: true,
  });
  // Off is the default and is not stored.
  assert.equal(
    Object.hasOwn(
      validateGraph(graph({ continueSession: false })).edges[1],
      "continueSession",
    ),
    false,
  );
  for (const invalid of ["yes", 1, null])
    assert.throws(() => validateGraph(graph({ continueSession: invalid })), {
      message: serverMessages.pipelineGraph.continueSessionLoopOnly,
    });
  const forward = graph({});
  forward.edges[0].continueSession = true;
  assert.throws(() => validateGraph(forward), {
    message: serverMessages.pipelineGraph.continueSessionLoopOnly,
  });
  const unbounded = graph({ continueSession: true });
  delete unbounded.edges[1].maxIterations;
  unbounded.edges = [
    unbounded.edges[1],
    { from: "build", to: "review", condition: "pass" },
  ];
  assert.throws(() => validateGraph(unbounded), {
    message: serverMessages.pipelineGraph.continueSessionLoopOnly,
  });
});

test("the pipeline editor keeps the option of a loop", () => {
  const stages = graphToStages(graph({ continueSession: true }));
  assert.equal(stages[1].continueSession, true);
  assert.deepEqual(
    stagesToGraph(stages).edges[1],
    graph({ continueSession: true }).edges[1],
  );
  const off = graphToStages(graph({}));
  assert.equal(off[1].continueSession, false);
  assert.equal(Object.hasOwn(stagesToGraph(off).edges[1], "continueSession"), false);
  // A stage without a loop never writes the option.
  assert.equal(
    stagesToGraph([{ ...off[0], continueSession: true }]).edges.some(
      (edge) => "continueSession" in edge,
    ),
    false,
  );
});

test("a session is bound to its profile, account, connection, tool and model", () => {
  const profile = {
    id: "p",
    accountSnapshot: { id: "a" },
    config: { cliTool: "codex", accountId: "a", models: { default: "m" } },
  };
  assert.equal(sessionKey(profile), sessionKey(structuredClone(profile)));
  for (const change of [
    (p) => (p.id = "q"),
    (p) => (p.config.accountId = "b"),
    (p) => (p.accountSnapshot.id = "b"),
    (p) => (p.config.cliTool = "claude"),
    (p) => (p.config.models.default = "n"),
    (p) => (p.config.providerConnectionId = "c"),
  ]) {
    const other = structuredClone(profile);
    change(other);
    assert.notEqual(sessionKey(other), sessionKey(profile));
  }
});

test("native wordings of an exhausted context are recognised", () => {
  for (const error of [
    "Codex ran out of room in the model's context window. Start a new conversation.",
    "Prompt is too long",
    "ContextOverflowError: input exceeds the context limit",
    "This model's maximum context length is 200000 tokens.",
  ])
    assert.equal(contextExhausted({ error }), true, error);
  assert.equal(contextExhausted({ errorCode: "context_length_exceeded" }), true);
  for (const error of [
    "Rate limited",
    "Native output could not be validated.",
    undefined,
  ])
    assert.equal(contextExhausted({ error }), false);
});

test("a loop back resumes only a session it can continue", () => {
  const profile = { id: "p", config: { cliTool: "codex", accountId: "a" } };
  const target = {
    id: "build",
    nativeId: "n-1",
    attemptId: "a-1",
    profileSnapshot: profile,
  };
  const run = {
    executionLog: [
      { nodeId: "build", attemptId: "a-1", sessionKey: sessionKey(profile) },
      { nodeId: "review", attemptId: "r-1" },
    ],
  };
  const edge = { continueSession: true };
  const decide = (options = {}) =>
    repairLaunch(options.run || run, options.target || target, options.edge || edge, {
      edgeKey: "review->build",
      iteration: 2,
    });
  assert.deepEqual(decide(), {
    kind: "resumed-repair",
    resumeNativeId: "n-1",
    repair: { edge: "review->build", round: 2, session: "resumed" },
  });
  assert.deepEqual(decide({ edge: {} }), {
    kind: "kickoff",
    repair: { edge: "review->build", round: 2, session: "fresh" },
  });
  const fallback = (options) => decide(options).repair.fallback;
  assert.equal(fallback({ target: { ...target, nativeId: undefined } }), "no-session");
  const exhausted = structuredClone(run);
  exhausted.executionLog.push({
    nodeId: "build",
    attemptId: "a-1",
    contextExhausted: true,
  });
  assert.equal(fallback({ run: exhausted }), "context-exhausted");
  const rebound = { ...target, profileSnapshot: { ...profile, id: "other" } };
  assert.equal(fallback({ target: rebound }), "profile-changed");
  // A run recorded before sessions were keyed never resumes.
  assert.equal(
    fallback({ run: { executionLog: [{ nodeId: "build", attemptId: "a-1" }] } }),
    "profile-changed",
  );
});

test("a relaunched repair keeps its round and starts a new session", () => {
  const node = { id: "build", attemptId: "a-2" };
  const opened = (repair) => ({
    executionLog: [
      {
        nodeId: "build",
        attemptId: "a-1",
        repair: { edge: "e", round: 1, session: "fresh" },
      },
      { nodeId: "build", attemptId: "a-2", repair },
      { nodeId: "build", attemptId: "a-2", kind: "verdict-nudge" },
    ],
  });
  assert.deepEqual(
    relaunchOptions(opened({ edge: "e", round: 2, session: "resumed" }), node),
    {
      repair: { edge: "e", round: 2, session: "fresh", fallback: "retried" },
    },
  );
  assert.deepEqual(
    relaunchOptions(
      opened({ edge: "e", round: 2, session: "fresh", fallback: "context-exhausted" }),
      node,
    ),
    { repair: { edge: "e", round: 2, session: "fresh", fallback: "context-exhausted" } },
  );
  assert.deepEqual(
    relaunchOptions(opened({ edge: "e", round: 2, session: "fresh" }), node),
    {
      repair: { edge: "e", round: 2, session: "fresh" },
    },
  );
  // A stage that repairs nothing is relaunched as a plain kickoff.
  assert.deepEqual(relaunchOptions({ executionLog: [] }, node), {});
});
