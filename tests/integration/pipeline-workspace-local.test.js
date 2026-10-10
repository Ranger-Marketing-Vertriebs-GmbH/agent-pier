import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";
import { availableActions } from "../../server/features/pipelines/pipeline-actions.js";

const copy = serverMessages.pipelineWorkspaces;
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-pipeline-local-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    dataDir = path.join(root, "data");
  await fs.mkdir(project);
  await fs.mkdir(dataDir);
  const git = async (...args) =>
    (
      await exec("git", args, {
        cwd: project,
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(project, "tracked.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  return { project, dataDir, git, manager: new PipelineWorkspace({ dataDir }) };
}

test("checkpoint commits name the stage instead of its internal node id", async (t) => {
  const { project, manager } = await fixture(t);
  const workspace = await manager.prepare({ runId: "named", cwd: project });
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "stage\n");
  const { sha } = await manager.checkpoint({
    workspace,
    run: { id: "named" },
    node: { id: "stage-0b6c", profileSnapshot: { name: "Implementer\nInjected" } },
  });
  const subject = (
    await exec("git", ["log", "-1", "--format=%s", sha], { cwd: workspace.cwd })
  ).stdout.trim();
  assert.equal(subject, "AgentPier named: Implementer Injected");
});

test("a repository without a remote offers no pull request and records it", async (t) => {
  const { project, manager } = await fixture(t);
  const workspace = await manager.prepare({ runId: "local", cwd: project });
  assert.equal(workspace.hasRemote, false);
  const run = { status: "completed", workspace, pullRequestUrl: null };
  assert.deepEqual(availableActions(run), ["delete"]);
  assert.deepEqual(
    availableActions({ ...run, workspace: { ...workspace, hasRemote: true } }),
    ["delete", "create-pr"],
  );
});

test("a clean worktree with only local commits is removed only after explicit confirmation", async (t) => {
  const { project, git, manager } = await fixture(t);
  const workspace = await manager.prepare({ runId: "commits", cwd: project });
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "stage\n");
  const { sha } = await manager.checkpoint({ workspace, run: { id: "commits" } });
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "dirty\n");
  await assert.rejects(manager.remove({ workspace, confirmLocalCommits: true }), {
    message: copy.uncommittedChanges,
  });
  await exec("git", ["checkout", "--", "tracked.txt"], { cwd: workspace.cwd });
  await assert.rejects(manager.remove({ workspace }), {
    message: copy.unpublishedCommits,
    code: "PIPELINE_LOCAL_COMMITS",
  });
  assert.deepEqual(await manager.remove({ workspace, confirmLocalCommits: true }), {
    removed: true,
    keptBranch: "agentpier/commits",
  });
  await assert.rejects(fs.stat(workspace.cwd));
  // The branch keeps the local commits; nothing is lost by removing the worktree.
  assert.equal(await git("rev-parse", "agentpier/commits"), sha);
});
