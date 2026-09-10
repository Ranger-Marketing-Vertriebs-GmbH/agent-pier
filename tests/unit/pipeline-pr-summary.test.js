import test from "node:test";
import assert from "node:assert/strict";
import {
  pullRequestBody,
  pullRequestTitle,
} from "../../server/features/pipelines/workspace-pr-summary.js";

test("PR titles use the task headline with its ticket and purpose", () => {
  assert.equal(
    pullRequestTitle({
      pipelineName: "Implement and review",
      task: "\n## NEONNIGHTS-353 — ActionCam auf das Token-Set ziehen.\r\n\nRead AGENTS.md.",
    }),
    "NEONNIGHTS-353 — ActionCam auf das Token-Set ziehen.",
  );
  assert.equal(pullRequestTitle({ task: "Fix\tlogin\0 timeout" }), "Fix login timeout");
  assert.equal(pullRequestTitle({ task: "x".repeat(200) }).length, 180);
  assert.equal(
    pullRequestTitle({ task: "\n ", pipelineName: "Legacy run" }),
    "Legacy run",
  );
  assert.equal(pullRequestTitle({}), "AgentPier pipeline");
});

test("pull request summary includes public stage and verification results without raw logs or account secrets", () => {
  const body = pullRequestBody({
    id: "run-1",
    pipelineName: "Implement and review",
    task: "Implement request",
    workspace: { baseSha: "a".repeat(40) },
    secret: "must-not-appear",
    nodes: [
      {
        id: "review",
        status: "passed",
        profileSnapshot: {
          name: "Reviewer",
          config: {
            cliTool: "codex",
            models: { default: "verified-model" },
            apiKey: "must-not-appear",
          },
        },
        verdict: {
          result: "pass",
          summary: "Review complete",
          findings: [{ severity: "low", title: "Document follow-up" }],
        },
        verifyResult: {
          status: "pass",
          steps: [
            {
              name: "Unit checks",
              exitCode: 0,
              blocking: true,
              logTail: "must-not-appear",
            },
          ],
        },
      },
    ],
  });
  for (const value of [
    "run-1",
    "Pipeline: Implement and review",
    "Implement request",
    "Reviewer",
    "verified-model",
    "Review complete",
    "Document follow-up",
    "Unit checks: exit 0",
  ])
    assert.equal(body.includes(value), true);
  assert.equal(body.includes("must-not-appear"), false);
});
test("pull request body has a bounded size for large accumulated stage histories", () => {
  const node = {
    id: "stage",
    verdict: {
      summary: "x".repeat(100000),
      findings: Array.from({ length: 200 }, () => ({ title: "x".repeat(10000) })),
    },
  };
  assert.ok(
    pullRequestBody({
      id: "run",
      task: "x".repeat(100000),
      nodes: Array.from({ length: 1000 }, () => node),
    }).length <= 60000,
  );
});
