import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "../helpers/pipeline-engine.js";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";

// Real worktree and checkpoints, synthetic native turns: build -> review, a review
// failure loops back to build once.
async function reportRun(t) {
  let workspace;
  const f = fixture(t, {
    loop: true,
    options: {
      get workspace() {
        return workspace;
      },
    },
  });
  const project = path.join(f.dir, "project");
  fs.mkdirSync(project);
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: f.dir, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.name", "Fixture");
  git(project, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(project, "app.js"), "export const value = 1;\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "base");
  workspace = new PipelineWorkspace({ dataDir: path.join(f.dir, "workspaces") });
  // The fixture engine was built before the workspace existed; rebuild it with it.
  await f.restart();
  const run = await f.engine.start({
    pipelineId: "definition",
    cwd: project,
    task: "Fix",
  });
  const current = () => f.engine.get(run.id);
  const turn = () => current().executionLog.at(-1);
  return { f, run, current, turn, git };
}

test("review reports stay off the run branch, survive loop-back and reach later stages", async (t) => {
  const { f, run, current, turn, git } = await reportRun(t);
  const cwd = current().workingDir;
  const report = (text) => {
    const file = `${turn().reportDir}/REVIEW.md`;
    fs.writeFileSync(path.join(cwd, file), text);
    return file;
  };
  // Every stage prompt names its own attempt's report directory.
  assert.match(f.launches[0].prompt, new RegExp(turn().reportDir.replaceAll(".", "\\.")));
  assert.equal(fs.statSync(path.join(cwd, turn().reportDir)).isDirectory(), true);

  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  await f.end();
  assert.equal(turn().nodeId, "review");
  const first = report("round 1 findings");
  await f.end({ result: "fail", summary: "Needs work", artifacts: [first] });

  assert.equal(turn().nodeId, "build");
  // The repair turn is handed the review's report path.
  assert.match(f.launches.at(-1).prompt, /Latest stage reports/);
  assert.ok(f.launches.at(-1).prompt.includes(first));
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 3;\n");
  await f.end();
  assert.equal(turn().nodeId, "review");
  const second = report("round 2 findings");
  assert.notEqual(second, first);
  const verdictPath = turn().verdictPath;
  await f.end({ result: "pass", summary: "Fine", artifacts: [second, verdictPath] });
  assert.equal(current().status, "completed");

  // Only the code change is on the branch; no checkpoint holds a report.
  assert.deepEqual(git(cwd, "diff", "--name-only", "main...HEAD").split("\n"), [
    "app.js",
  ]);
  const changed = git(cwd, "log", "--name-only", "--format=", "main..HEAD");
  assert.doesNotMatch(changed, /REVIEW\.md|\.pipeline/);
  assert.equal(git(cwd, "rev-list", "--count", "main..HEAD"), "2");
  assert.equal(git(cwd, "status", "--porcelain"), "");

  // Both rounds stay readable as declared artifacts of their attempts.
  assert.equal(f.engine.artifact(run.id, "review", first).text, "round 1 findings");
  assert.equal(f.engine.artifact(run.id, "review", second).text, "round 2 findings");
  assert.deepEqual(f.engine.artifacts(run.id, "review").artifacts, [
    { nodeId: "review", artifacts: [{ path: second }, { path: verdictPath }] },
  ]);
  // A declared verdict file of the same run stays private.
  assert.throws(() => f.engine.artifact(run.id, "review", verdictPath), {
    status: 403,
  });
});
