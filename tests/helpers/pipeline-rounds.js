import { recordRound } from "../../server/features/pipelines/loop-rounds.js";

// build -> test -> review, a review failure loops back to build.
export const edge = { from: "review", to: "build", condition: "fail", maxIterations: 3 };
export function loopRun() {
  return {
    nodes: ["build", "test", "review"].map((id) => ({ id, status: "passed" })),
    edges: [
      { from: "build", to: "test", condition: "default" },
      { from: "test", to: "review", condition: "default" },
      edge,
    ],
    loopState: {},
    executionLog: [],
  };
}
const minute = (n, seconds = 0) =>
  new Date(Date.UTC(2026, 9, 19, 10, n, seconds)).toISOString();
// Appends a finished turn; each turn starts a minute after the previous one.
export function turn(run, nodeId, verdict, extra = {}) {
  const n = run.executionLog.length + 1;
  const entry = {
    id: `turn-${n}`,
    nodeId,
    attemptId: `attempt-${n}`,
    kind: "kickoff",
    reportDir: `.pipeline/reports/${nodeId}/attempt-${n}`,
    startedAt: minute(n),
    finishedAt: minute(n, 30),
    ...(verdict ? { verdict } : {}),
    ...extra,
  };
  run.executionLog.push(entry);
  return entry;
}
export const failing = (title, artifacts = []) => ({
  result: "fail",
  summary: `Review: ${title}`,
  findings: [{ severity: "high", title, detail: `Fix ${title}` }],
  artifacts,
});
// Records a round at the time the last turn finished.
export const record = (run, verdict, options) =>
  recordRound(run, run.nodes[2], edge, verdict, {
    at: run.executionLog.at(-1)?.finishedAt,
    ...options,
  });
// One full round: build, test passes with a note, review fails.
export function round(run, title, iteration) {
  turn(run, "build", { result: "pass", summary: "Built", findings: [], artifacts: [] });
  turn(run, "test", {
    result: "pass",
    summary: `Tests green ${iteration}`,
    findings: [{ severity: "low", title: "Slow test" }],
    artifacts: [],
  });
  const report = `.pipeline/reports/review/attempt-${run.executionLog.length + 1}/REVIEW.md`;
  const verdict = failing(title, [{ path: report }, { path: "app.js" }]);
  turn(run, "review", verdict);
  return record(run, verdict, { iteration });
}
// The loop target's context as loopBack() sets it.
export function repairing(run, iteration, maxIterations = 3) {
  const build = run.nodes[0];
  build.loop = { edge: "review->build", fromNodeId: "review", iteration, maxIterations };
  return build;
}
