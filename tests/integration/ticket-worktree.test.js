import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  TicketWorktrees,
  ticketBranchName,
} from "../../server/features/tickets/ticket-worktree.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const run = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function fixture(t, { gitignore = "" } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticket-wt-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git"),
    seed = path.join(dir, "seed"),
    source = path.join(dir, "source");
  run(dir, "init", "--bare", "-b", "main", origin);
  run(dir, "clone", origin, seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  if (gitignore) fs.writeFileSync(path.join(seed, ".gitignore"), gitignore);
  run(seed, "add", ".");
  run(seed, "commit", "-m", "first");
  run(seed, "push", "origin", "HEAD:main");
  run(dir, "clone", origin, source);
  const github = {
    prepare: async () => ({ env: { ...process.env } }),
    discard: async () => {},
  };
  return {
    dir,
    origin,
    seed,
    source,
    worktrees: new TicketWorktrees({ dataDir: path.join(dir, "data"), github }),
  };
}
const ticket = { source: "github", key: "#12", title: "Fix the Login!" };

test("creates the session worktree from the fetched default branch", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, "b.txt"), "b\n");
  run(f.seed, "add", ".");
  run(f.seed, "commit", "-m", "second");
  run(f.seed, "push", "origin", "HEAD:main");
  const created = await f.worktrees.createSession({
    projectPath: f.source,
    ticket,
    name: "ticket-12-abcd1234",
  });
  assert.equal(created.cwd, path.join(f.source, ".worktrees", "ticket-12-abcd1234"));
  assert.equal(run(created.cwd, "rev-parse", "HEAD"), run(f.seed, "rev-parse", "HEAD"));
  assert.equal(run(created.cwd, "branch", "--show-current"), created.branch);
  assert.equal(created.branch, "ticket/12-fix-the-login");
  assert.equal(created.baseSha, run(f.seed, "rev-parse", "HEAD"));
  assert.equal(await f.worktrees.exists(created.cwd), true);
});

test("leaves the source checkout untouched", async (t) => {
  const f = fixture(t);
  run(f.source, "checkout", "-b", "other");
  fs.writeFileSync(path.join(f.source, "a.txt"), "changed\n");
  const before = run(f.source, "status", "--porcelain");
  await f.worktrees.createSession({
    projectPath: f.source,
    ticket,
    name: "ticket-12-abcd1234",
  });
  assert.equal(run(f.source, "branch", "--show-current"), "other");
  assert.equal(run(f.source, "status", "--porcelain"), before);
  assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "changed\n");
});

test("excludes .worktrees when the repo does not ignore it", async (t) => {
  const f = fixture(t);
  await f.worktrees.createSession({ projectPath: f.source, ticket, name: "ticket-a-1" });
  run(f.source, "check-ignore", "-q", ".worktrees/x");
  assert.equal(fs.existsSync(path.join(f.source, ".gitignore")), false);
  const ignoring = fixture(t, { gitignore: "/.worktrees/\n" });
  await ignoring.worktrees.createSession({
    projectPath: ignoring.source,
    ticket,
    name: "ticket-a-1",
  });
  const exclude = path.join(ignoring.source, ".git", "info", "exclude");
  assert.doesNotMatch(fs.readFileSync(exclude, "utf8"), /\.worktrees/);
  assert.equal(
    fs.readFileSync(path.join(ignoring.source, ".gitignore"), "utf8"),
    "/.worktrees/\n",
  );
});

test("refuses an existing path and a symlinked .worktrees", async (t) => {
  const f = fixture(t);
  const existing = path.join(f.source, ".worktrees", "ticket-a-1");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "keep.txt"), "x");
  await assert.rejects(
    f.worktrees.createSession({ projectPath: f.source, ticket, name: "ticket-a-1" }),
    { status: 409 },
  );
  assert.equal(fs.existsSync(path.join(existing, "keep.txt")), true);

  const g = fixture(t);
  const elsewhere = path.join(g.dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(g.source, ".worktrees"));
  await assert.rejects(
    g.worktrees.createSession({ projectPath: g.source, ticket, name: "ticket-a-1" }),
    { status: 409 },
  );
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("repair worktree tracks the PR branch", async (t) => {
  const f = fixture(t);
  run(f.seed, "checkout", "-b", "agentpier/r1");
  fs.writeFileSync(path.join(f.seed, "pr.txt"), "pr\n");
  run(f.seed, "add", ".");
  run(f.seed, "commit", "-m", "pr");
  run(f.seed, "push", "origin", "agentpier/r1");
  const repair = await f.worktrees.createRepair({
    projectPath: f.source,
    headRef: "agentpier/r1",
    name: "ticket-repair-abcd1234",
  });
  assert.equal(run(repair.cwd, "rev-parse", "HEAD"), run(f.seed, "rev-parse", "HEAD"));
  assert.equal(repair.branch, "ticket-repair/abcd1234");
  assert.equal(run(repair.cwd, "branch", "--show-current"), repair.branch);
  await assert.rejects(
    f.worktrees.createRepair({
      projectPath: f.source,
      headRef: "--upload-pack=x",
      name: "ticket-repair-zzzz0000",
    }),
  );
});

test("fetch failure falls back to the local origin ref with fetchWarning", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.origin, { recursive: true, force: true });
  const created = await f.worktrees.createSession({
    projectPath: f.source,
    ticket,
    name: "ticket-12-abcd1234",
  });
  assert.ok(created.fetchWarning);
  assert.equal(created.baseRef, "refs/remotes/origin/main");
  assert.equal(run(created.cwd, "rev-parse", "HEAD"), run(f.source, "rev-parse", "HEAD"));
});

test("ticketBranchName slugs and de-duplicates", () => {
  assert.equal(
    ticketBranchName({ key: "#12", title: "Fix the Login!" }, new Set()),
    "ticket/12-fix-the-login",
  );
  assert.equal(
    ticketBranchName({ key: "AP-12", title: "  Ünï; rm -rf $(x) `y` " }, new Set()),
    "ticket/ap-12-uni-rm-rf-x-y",
  );
  const long = ticketBranchName({ key: "AP-1", title: "a".repeat(80) }, new Set());
  assert.equal(long, `ticket/ap-1-${"a".repeat(30)}`);
  const taken = new Set(["ticket/12-fix-the-login", "ticket/12-fix-the-login-2"]);
  assert.equal(
    ticketBranchName({ key: "#12", title: "Fix the Login!" }, taken),
    "ticket/12-fix-the-login-3",
  );
  assert.equal(ticketBranchName({ key: "#7", title: "" }, new Set()), "ticket/7");
});
