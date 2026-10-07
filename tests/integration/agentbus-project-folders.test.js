import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { AgentBus } from "../../server/features/agentbus/agent-bus.js";

async function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-busdir-")),
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const dataDir = path.join(root, "data");
  const accounts = new AccountStore({ dataDir, home });
  const rows = [];
  const sessions = {
    list: async () => rows,
    get: async (id) => rows.find((row) => row.id === id),
    target: (id) => `fixture-${id}`,
    tmux: async () => String(process.pid),
  };
  const bus = new AgentBus({ dataDir, home, accounts, sessions });
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

test("a pipeline run worktree joins its root project on AgentBus", async (t) => {
  const ctx = await setup(t);
  const app = repository(path.join(ctx.root, "work", "app"));
  const run = path.join(app, ".agentpier-worktrees", "8c1d4e2f-run");
  execFileSync("git", ["-C", app, "worktree", "add", "-q", "--detach", run]);
  const inRun = await ctx.prepare("run-session", run);
  const inRoot = await ctx.prepare("root-session", app);
  assert.equal(inRun.agentbus.projectId, createHash("sha256").update(app).digest("hex"));
  assert.equal(inRun.agentbus.projectId, inRoot.agentbus.projectId);
  const listed = await ctx.bus.list();
  assert.equal(listed.projects.length, 1);
  assert.deepEqual(
    [listed.projects[0].name, listed.projects[0].cwd, listed.projects[0].sessions.length],
    ["app", app, 2],
  );
});
