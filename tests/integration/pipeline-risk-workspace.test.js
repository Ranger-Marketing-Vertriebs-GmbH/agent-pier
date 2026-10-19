import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";
import { riskItems } from "../../server/features/pipelines/risk-gate.js";
import { DEFAULT_RISK } from "../../server/features/pipelines/risk-rules.js";

const exec = promisify(execFile);
async function repository(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-risk-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    dataDir = path.join(root, "data");
  await fs.mkdir(project);
  await fs.mkdir(dataDir);
  const git = async (cwd, ...args) =>
    (
      await exec("git", args, {
        cwd,
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
      })
    ).stdout.trim();
  const write = async (cwd, file, text) => {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), text);
  };
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.name", "Fixture");
  await git(project, "config", "user.email", "fixture@example.invalid");
  await write(
    project,
    "src/auth/login.js",
    "export const login = () => true;\n".repeat(20),
  );
  await write(project, "db/migrations/001.sql", "create table a (id int);\n");
  await write(project, "package.json", JSON.stringify({ dependencies: { a: "1" } }));
  await write(project, "src/app.js", "app\n");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "base");
  return { root, project, dataDir, git, write };
}

test("the run diff since base names renames on both sides, deletes and added dependencies", async (t) => {
  const { project, dataDir, git, write } = await repository(t);
  const manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({ runId: "risk-run", cwd: project });
  const cwd = workspace.cwd;
  await git(cwd, "config", "user.name", "Fixture");
  await git(cwd, "config", "user.email", "fixture@example.invalid");
  await fs.mkdir(path.join(cwd, "src/session"));
  await git(cwd, "mv", "src/auth/login.js", "src/session/login.js");
  await git(cwd, "rm", "-q", "db/migrations/001.sql");
  await write(cwd, "package.json", JSON.stringify({ dependencies: { a: "2", b: "1" } }));
  await write(cwd, "src/app.js", "changed\n");
  await write(cwd, "Ä file.txt", "unicode\n");
  // Private run files never reach a checkpoint or the gate.
  await write(cwd, ".pipeline/reports/x/REVIEW.md", "report\n");
  const run = { id: "risk-run" };
  const { sha } = await manager.checkpoint({ workspace, run, attempt: {} });
  const { changes, from, to } = await manager.changes({
    workspace,
    from: workspace.baseSha,
    to: sha,
  });
  assert.equal(from, workspace.baseSha);
  assert.equal(to, sha);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.deepEqual(byPath["src/session/login.js"], {
    status: "R",
    from: "src/auth/login.js",
    path: "src/session/login.js",
  });
  assert.equal(byPath["db/migrations/001.sql"].status, "D");
  assert.equal(byPath["package.json"].status, "M");
  assert.equal(byPath["Ä file.txt"].status, "A");
  assert.ok(!changes.some((c) => c.path.startsWith(".pipeline/")));
  const items = await riskItems(changes, DEFAULT_RISK, (side, file) =>
    manager.fileAt({ workspace, sha: side === "from" ? from : to, path: file }),
  );
  assert.deepEqual(
    items.map((item) => [item.path, item.rule ?? `+${item.dependency}`]).sort(),
    [
      ["db/migrations/001.sql", "migrations/**"],
      ["package.json", "+b"],
      ["package.json", "package.json"],
      ["src/auth/login.js", "auth/**"],
    ],
  );
  assert.equal(
    await manager.fileAt({ workspace, sha: from, path: "src/session/login.js" }),
    null,
  );
  await assert.rejects(manager.fileAt({ workspace, sha: to, path: "../outside" }), {
    status: 400,
  });
});

test("a rename an agent commits out of a private file still names its new path", async (t) => {
  const { project, dataDir, git, write } = await repository(t);
  await write(project, ".env.example", "TOKEN=\nURL=\nMODE=\nDEBUG=\n");
  await git(project, "add", "-f", ".env.example");
  await git(project, "commit", "-m", "example env");
  const manager = new PipelineWorkspace({ dataDir });
  const workspace = await manager.prepare({ runId: "risk-rename", cwd: project });
  const cwd = workspace.cwd;
  await git(cwd, "config", "user.name", "Fixture");
  await git(cwd, "config", "user.email", "fixture@example.invalid");
  await fs.mkdir(path.join(cwd, "scripts"));
  // The agent moves and commits the file itself; checkpoints never stage it.
  await git(cwd, "mv", ".env.example", "scripts/deploy.sh");
  await write(
    cwd,
    "package.json",
    JSON.stringify({ dependencies: { a: "1" } }).padEnd(1024 * 1024 + 10),
  );
  await git(cwd, "add", "package.json");
  await git(cwd, "commit", "-q", "-m", "agent commit");
  const { changes, from, to } = await manager.changes({ workspace });
  assert.deepEqual(
    changes.find((c) => c.path === "scripts/deploy.sh"),
    { status: "R", from: ".env.example", path: "scripts/deploy.sh" },
  );
  const items = await riskItems(changes, DEFAULT_RISK, (side, file) =>
    manager.fileAt({ workspace, sha: side === "from" ? from : to, path: file }),
  );
  assert.ok(
    items.some((i) => i.path === "scripts/deploy.sh" && i.rule === "/scripts/**"),
  );
  // A manifest too large to read cannot rule out a new dependency.
  assert.ok(items.some((i) => i.path === "package.json" && i.dependency === ""));
});

test("risk rules are stored per project in the data directory, with defaults until saved", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-risk-defs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const accounts = { get: () => ({}) };
  let definitions = new PipelineDefinitions({ dataDir: root, accounts });
  const initial = definitions.getRisk("project-a");
  assert.equal(initial.custom, false);
  assert.deepEqual(initial.globs, DEFAULT_RISK.globs);
  assert.deepEqual(initial.defaults.globs, DEFAULT_RISK.globs);
  definitions.saveRisk("project-a", { globs: ["infra/**"], newDependency: false });
  assert.throws(
    () => definitions.saveRisk("project-a", { globs: ["../x"], newDependency: true }),
    {
      status: 400,
    },
  );
  definitions = new PipelineDefinitions({ dataDir: root, accounts });
  assert.deepEqual(definitions.riskRules("project-a"), {
    globs: ["infra/**"],
    newDependency: false,
    enabled: true,
  });
  assert.equal(definitions.getRisk("project-a").custom, true);
  // Turning the gate off is a saved decision of its own.
  definitions.saveRisk("project-c", { globs: [], newDependency: false, enabled: false });
  assert.equal(definitions.riskRules("project-c").enabled, false);
  // A project id the store cannot name still gets the defaults.
  assert.deepEqual(definitions.riskRules("/not/an/id").globs, DEFAULT_RISK.globs);
  // A plain folder that became a Git work tree hands its rules on.
  definitions.moveVerification("project-a", "project-b");
  assert.equal(definitions.getRisk("project-a").custom, false);
  assert.deepEqual(definitions.getRisk("project-b").globs, ["infra/**"]);
  assert.equal(definitions.hasVerification("project-b"), true);
  // Definitions written before risk rules existed load without any.
  const file = path.join(root, "pipelines", "definitions.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  delete stored.risk;
  await fs.writeFile(file, JSON.stringify(stored));
  definitions = new PipelineDefinitions({ dataDir: root, accounts });
  assert.equal(definitions.getRisk("project-b").custom, false);
});

test("the Approver is a seeded review profile that asks the owner with a question and files", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-risk-seed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const definitions = new PipelineDefinitions({ dataDir: root, accounts: {} });
  const approver = definitions.getProfile("seed-approver");
  assert.equal(approver.name, "Approver");
  assert.equal(approver.phaseKey, "review");
  assert.equal(approver.config.run.autonomous, true);
  assert.equal(approver.config.run.earlierVerdicts, true);
  // Other seeded reviewers review on their own.
  assert.equal(
    definitions.getProfile("seed-code-reviewer").config.run.earlierVerdicts,
    undefined,
  );
  const role = approver.config.prompts.role;
  for (const part of [
    "spec",
    "per criterion",
    "run diff",
    "Spot-check at least one acceptance criterion",
    '"requiresHuman":true',
    '"question"',
    '"files"',
    "product decision",
    "adds a dependency",
  ])
    assert.ok(role.includes(part), part);
});

test("the push publishes the checked commit, not one that lands while GitHub answers", async (t) => {
  const { root, project, dataDir, git } = await repository(t);
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await git(project, "remote", "add", "origin", "https://github.example/org/repo.git");
  await git(project, "config", "remote.origin.pushurl", remote);
  // `gh pr list` stands for the network round trip; a leftover process commits a
  // workflow in the worktree meanwhile.
  const gh = path.join(root, "fake-gh.cjs");
  await fs.writeFile(
    gh,
    `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const cwd = fs.readFileSync(${JSON.stringify(path.join(root, "cwd"))}, "utf8");
if (args[1] === "list") {
  fs.mkdirSync(cwd + "/.github/workflows", { recursive: true });
  fs.writeFileSync(cwd + "/.github/workflows/late.yml", "on: push\\n");
  const git = (...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=x", "-c", "user.email=x@example.invalid", ...a]);
  git("add", ".github");
  git("commit", "-q", "-m", "late");
  console.log("[]");
} else console.log("https://github.example/org/repo/pull/7");
`,
    { mode: 0o700 },
  );
  const github = {
    prepare: async ({ launch }) => launch,
    discard: async () => {},
    resolveGh: () => gh,
  };
  const manager = new PipelineWorkspace({ dataDir, github });
  const workspace = await manager.prepare({ runId: "late-push", cwd: project });
  await fs.writeFile(path.join(root, "cwd"), workspace.cwd);
  await fs.writeFile(path.join(workspace.cwd, "src/app.js"), "checked\n");
  const run = { id: "late-push", task: "Change the app" };
  const { sha } = await manager.checkpoint({ workspace, run, attempt: {} });
  const result = await manager.createPr({ workspace, run, expectedSha: sha });
  assert.equal(result.url, "https://github.example/org/repo/pull/7");
  // The worktree moved on, but the branch holds exactly the checked commit.
  assert.notEqual(await git(workspace.cwd, "rev-parse", "HEAD"), sha);
  assert.equal(await git(remote, "rev-parse", "refs/heads/agentpier/late-push"), sha);
  await assert.rejects(
    git(
      remote,
      "cat-file",
      "-e",
      "refs/heads/agentpier/late-push:.github/workflows/late.yml",
    ),
  );
  // A checkpoint that no longer matches the check refuses to publish at all.
  await fs.writeFile(path.join(workspace.cwd, "src/app.js"), "changed again\n");
  await assert.rejects(manager.createPr({ workspace, run, expectedSha: sha }), {
    status: 409,
  });
});
