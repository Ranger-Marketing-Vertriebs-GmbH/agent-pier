import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { fixtureProjectScope } from "../helpers/fixture-project-scope.js";
import { mailFixture } from "../helpers/agent-mail-fixture.js";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";

/**
 * A fake `git` first on PATH that counts its calls and, while `slow` exists, never
 * answers: the loaded test run in which Git discovery outlived its time limit.
 * Otherwise it reports "not a git repository", like Git in a plain folder.
 */
function slowGit(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slow-git-")));
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls");
  const slow = path.join(dir, "slow");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      `echo call >> '${calls}'`,
      `[ -e '${slow}' ] && exec sleep 30`,
      'echo "fatal: not a git repository" >&2',
      "exit 128",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(slow, "");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").length : 0),
    answer: () => fs.rmSync(slow),
  };
}

test("the mail fixture sets up without Git while Git discovery times out", async (t) => {
  const git = slowGit(t);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-project-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  // The slow Git reproduces the failure the fixture used to hit in its setup.
  await assert.rejects(projectScope(plain), {
    message: serverMessages.memory.gitDiscoveryTimedOut,
  });
  const spawned = git.calls();
  assert.ok(spawned > 0);
  const f = await mailFixture(t);
  assert.equal(git.calls(), spawned, "the fixture never ran Git");
  assert.equal(f.project.kind, "directory");
  // The fixture's project is the one real discovery finds for the same folder.
  git.answer();
  const real = await projectScope(path.join(f.dataDir, "project"));
  assert.equal(real.id, f.project.id);
  assert.equal(real.cwd, f.project.cwd);
  assert.equal(real.kind, "directory");
});

test("an approved coding start checks the project identity without Git", async (t) => {
  const git = slowGit(t);
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Build it",
  });
  await f.workflows.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve" },
    { kind: "owner" },
  );
  // The start runs McpTools.authorizeStart, which re-reads the project's scope.
  await f.workflows.tick();
  assert.equal(f.workflows.get(proposal.id).state, "running");
  assert.equal(f.starts.length, 1);
  assert.equal(git.calls(), 0, "neither setup nor the start ran Git");
});

test("the fixture scope still asks Git inside a work tree", async (t) => {
  const git = slowGit(t);
  git.answer();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "sub"));
  await fixtureProjectScope(path.join(repo, "sub"));
  assert.equal(git.calls() > 0, true, "a folder below .git goes to real discovery");
  await assert.rejects(fixtureProjectScope(path.join(repo, "missing")), {
    message: serverMessages.memory.projectDirectoryUnavailable,
  });
});
