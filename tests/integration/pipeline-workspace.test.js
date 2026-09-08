import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const { PipelineWorkspace } =
  await import("../../server/features/pipelines/workspace-manager.js").catch(() => ({}));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-pipeline-git-"));
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
  return { root, project, dataDir, git };
}
test("pipeline worktree branches from requested base without changing user checkout and refuses unsafe cleanup", async (t) => {
  assert.equal(typeof PipelineWorkspace, "function");
  const { project, dataDir, git } = await fixture(t);
  const base = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(project, "personal.txt"), "keep");
  const manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({
    runId: "run-1",
    cwd: project,
    baseBranch: "main",
  });
  assert.equal(workspace.baseSha, base);
  assert.equal(workspace.branch, "agentpier/run-1");
  assert.equal(await git("branch", "--show-current"), "main");
  assert.equal(await fs.readFile(path.join(project, "personal.txt"), "utf8"), "keep");
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "changed\n");
  assert.match((await manager.diff({ workspace, from: base })).diff, /changed/);
  await assert.rejects(manager.remove({ workspace }), /uncommitted/i);
  await assert.rejects(
    manager.remove({ workspace: { ...workspace, cwd: project } }),
    /ownership/i,
  );
  await exec("git", ["checkout", "--", "tracked.txt"], { cwd: workspace.cwd });
  await manager.remove({ workspace });
  assert.equal(
    await fs.stat(workspace.cwd).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(await git("branch", "--show-current"), "main");
});
test("unknown base and preexisting or symlink worktree roots never mutate unrelated directories", async (t) => {
  assert.equal(typeof PipelineWorkspace, "function");
  const { root, project, dataDir, git } = await fixture(t);
  const manager = new PipelineWorkspace({ dataDir });
  await assert.rejects(
    manager.prepare({ runId: "bad-ref", cwd: project, baseBranch: "does-not-exist" }),
  );
  assert.equal(await git("branch", "--show-current"), "main");
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "canary"), "safe");
  await fs.rm(path.join(project, ".agentpier-worktrees"), {
    recursive: true,
    force: true,
  });
  await fs.symlink(outside, path.join(project, ".agentpier-worktrees"));
  await assert.rejects(manager.prepare({ runId: "unsafe", cwd: project }), /worktree/i);
  assert.equal(await fs.readFile(path.join(outside, "canary"), "utf8"), "safe");
});
test("stage checkpoints commit owned code changes but exclude pipeline artifacts and credential files", async (t) => {
  const { project, dataDir, git } = await fixture(t);
  const manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({ runId: "checkpoint", cwd: project });
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "stage one\n");
  await fs.mkdir(path.join(workspace.cwd, ".pipeline"));
  await fs.writeFile(path.join(workspace.cwd, ".pipeline/verdict.json"), "{}");
  await fs.writeFile(path.join(workspace.cwd, ".env"), "API_KEY=fixture-secret");
  assert.equal(typeof manager.checkpoint, "function");
  const result = await manager.checkpoint({
    workspace,
    run: { id: "checkpoint" },
    node: { id: "implementation" },
  });
  assert.notEqual(result.sha, workspace.baseSha);
  const files = (
    await exec("git", ["show", "--format=", "--name-only", result.sha], {
      cwd: workspace.cwd,
    })
  ).stdout;
  assert.match(files, /tracked.txt/);
  assert.equal(files.includes(".pipeline"), false);
  assert.equal(files.includes(".env"), false);
  assert.equal(await git("branch", "--show-current"), "main");
  assert.equal(
    (await manager.checkpoint({ workspace, run: { id: "checkpoint" } })).sha,
    result.sha,
  );
});
test("a finished worktree containing only ignored private verdict files can be cleaned", async (t) => {
  const { project, dataDir } = await fixture(t);
  const manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({ runId: "verdict-only", cwd: project });
  await fs.mkdir(path.join(workspace.cwd, ".pipeline/turns/t"), { recursive: true });
  await fs.writeFile(path.join(workspace.cwd, ".pipeline/turns/t/verdict.json"), "{}");
  assert.equal((await manager.inspect(workspace)).dirty, false);
  await manager.remove({ workspace });
  assert.equal(
    await fs.stat(workspace.cwd).then(
      () => true,
      () => false,
    ),
    false,
  );
});
test("existing pull requests receive a fresh owned checkpoint and branch push", async (t) => {
  const { root, project, dataDir, git } = await fixture(t);
  const calls = path.join(root, "gh-calls.jsonl"),
    gh = path.join(root, "fake-gh.cjs");
  await fs.writeFile(
    gh,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[1]==='list')console.log('[{"url":"https://github.example/org/repo/pull/1"}]');`,
    { mode: 0o700 },
  );
  const github = {
    prepare: async ({ launch }) => launch,
    discard: async () => {},
    resolveGh: () => gh,
  };
  const manager = new PipelineWorkspace({ dataDir, github });
  const workspace = await manager.prepare({ runId: "publish", cwd: project });
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await git("remote", "add", "origin", "https://github.example/org/repo.git");
  await git("config", "remote.origin.pushurl", remote);
  await fs.writeFile(path.join(workspace.cwd, "tracked.txt"), "latest code\n");
  const result = await manager.createPr({
    workspace,
    run: { id: "publish", name: "Fixture", task: "Updated details" },
  });
  assert.equal(result.url, "https://github.example/org/repo/pull/1");
  const pushed = (
    await exec("git", ["show", "refs/heads/agentpier/publish:tracked.txt"], {
      cwd: remote,
    })
  ).stdout;
  assert.equal(pushed, "latest code\n");
  const args = (await fs.readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(
    args.some((row) => row[1] === "create"),
    false,
  );
  assert.match(
    args.find((row) => row[1] === "edit").at(-1),
    /AgentPier run publish[\s\S]*Updated details/,
  );
});
test("restart adopts a completed worktree from its durable preparation intent without creating another branch", async (t) => {
  const { project, dataDir, git } = await fixture(t),
    manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({
    runId: "recover",
    cwd: project,
    baseBranch: "main",
  });
  const intent = { ...workspace, preparing: true };
  delete intent.device;
  delete intent.inode;
  delete intent.commonDir;
  await fs.writeFile(
    path.join(dataDir, "pipeline-workspaces/recover.json"),
    JSON.stringify(intent),
  );
  const resumed = await new PipelineWorkspace({ dataDir }).prepare({
    runId: "recover",
    cwd: project,
    baseBranch: "main",
  });
  assert.equal(resumed.ownership, workspace.ownership);
  assert.equal(resumed.baseSha, workspace.baseSha);
  assert.equal(resumed.preparing, undefined);
  assert.equal(
    (await git("branch", "--list", "agentpier/recover")).trim(),
    "+ agentpier/recover",
  );
});
