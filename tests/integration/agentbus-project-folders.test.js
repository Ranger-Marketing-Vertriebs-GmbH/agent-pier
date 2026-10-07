import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

async function setup(t, { home: givenHome, classifyFolder } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-busdir-")),
  );
  const home = givenHome || path.join(root, "home");
  if (!givenHome) fs.mkdirSync(home);
  const dataDir = path.join(root, "data");
  const accounts = new AccountStore({ dataDir, home });
  const rows = [];
  const sessions = {
    list: async () => rows,
    get: async (id) => rows.find((row) => row.id === id),
    target: (id) => `fixture-${id}`,
    tmux: async () => String(process.pid),
  };
  const bus = new AgentBus({ dataDir, home, accounts, sessions, classifyFolder });
  await bus.ready;
  t.after(async () => {
    await bus.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const account = accounts.create({ name: "bus", tool: "codex", apiKey: "k" });
  const prepare = async (id, cwd) => {
    const result = await bus.prepare({
      id,
      account,
      cwd,
      launch: {
        command: process.execPath,
        args: [],
        env: accounts.environment(account.id),
      },
    });
    if (result.agentbus.enabled)
      rows.push({
        id,
        name: id,
        tool: "codex",
        cwd,
        accountId: account.id,
        status: "running",
        agentbus: result.agentbus,
      });
    return result;
  };
  return { root, home, bus, prepare };
}
function repository(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  fs.writeFileSync(path.join(cwd, "README.md"), "x\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  execFileSync("git", ["-C", cwd, "add", "."], { env });
  execFileSync("git", ["-C", cwd, "commit", "-qm", "init"], { env });
  return cwd;
}

test("AgentBus creates no project for the home folder or a collection folder", async (t) => {
  const ctx = await setup(t);
  const fromHome = await ctx.prepare("home-session", ctx.home);
  assert.deepEqual(fromHome.agentbus, { enabled: false });
  const collection = path.join(ctx.root, "Projects");
  repository(path.join(collection, "one"));
  repository(path.join(collection, "two"));
  const fromCollection = await ctx.prepare("collection-session", collection);
  assert.deepEqual(fromCollection.agentbus, { enabled: false });
  const fromProject = await ctx.prepare("project-session", path.join(collection, "one"));
  assert.equal(fromProject.agentbus.enabled, true);
  const listed = await ctx.bus.list();
  assert.deepEqual(
    listed.projects.map((project) => project.name),
    ["one"],
  );
});

test("a pipeline run worktree keeps its own bus but lists under its root project", async (t) => {
  const ctx = await setup(t);
  const app = repository(path.join(ctx.root, "work", "app"));
  const run = path.join(app, ".agentpier-worktrees", "8c1d4e2f-run");
  execFileSync("git", ["-C", app, "worktree", "add", "-q", "--detach", run]);
  const inRun = await ctx.prepare("run-session", run);
  const inRoot = await ctx.prepare("root-session", app);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(inRun.agentbus.projectId, hash(run));
  assert.equal(inRoot.agentbus.projectId, hash(app));
  assert.notEqual(inRun.agentbus.projectId, inRoot.agentbus.projectId);
  const listed = await ctx.bus.list();
  assert.deepEqual(
    listed.projects
      .map((project) => [project.id, project.name, project.cwd, project.sessions.length])
      .sort(),
    [
      [hash(app), "app", app, 1],
      [hash(run), "app", app, 1],
    ].sort(),
  );
});

test("AgentBus stays on where project memory keeps a home project with knowledge", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-busmem-")),
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const memory = new ProjectMemory({ dataDir: path.join(root, "memory"), home });
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scope = await projectScope(home);
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(scope.id, scope.name, scope.cwd, scope.kind, scope.identity, "2026-01-01");
  memory.write(scope.id, { title: "Kept", content: "Home notes" });
  const ctx = await setup(t, {
    home,
    classifyFolder: (cwd) => memory.classifyFolder(cwd),
  });
  assert.equal((await ctx.prepare("home-session", home)).agentbus.enabled, true);
  assert.equal((await memory.register(home)).id, scope.id);
});

test("folders below a home that is a Git work tree are no home folder", async (t) => {
  const ctx = await setup(t);
  execFileSync("git", ["init", "-q", ctx.home]);
  const notes = path.join(ctx.home, "notes");
  fs.mkdirSync(notes);
  assert.equal((await ctx.prepare("home-session", ctx.home)).agentbus.enabled, false);
  assert.equal((await ctx.prepare("notes-session", notes)).agentbus.enabled, true);
});
