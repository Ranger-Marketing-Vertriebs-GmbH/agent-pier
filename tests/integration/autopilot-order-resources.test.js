import test from "node:test";
import "../helpers/composer-writes.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { PipelineWorkspace } from "../../server/features/pipelines/workspace-manager.js";
import {
  OrderResources,
  checkSelection,
} from "../../server/features/autopilot/order-resources.js";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ap-order-")));
  const projectRoot = path.join(home, "repo"),
    dataDir = path.join(home, "data");
  fs.mkdirSync(projectRoot);
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "f@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "f@example.test",
      },
    }).trim();
  git(projectRoot, "init", "-q", "-b", "main");
  git(projectRoot, "commit", "-q", "--allow-empty", "-m", "base");
  const account = { id: "local-codex", tool: "codex", kind: "local" };
  const skill = path.join(home, ".codex", "skills", "agentpier-composer");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: agentpier-composer\ndescription: Fixture\n---\nagentpier-order-contract-v2\n",
  );
  fs.writeFileSync(path.join(skill, "scripts", "order-progress.mjs"), "");
  const sessions = new SessionManager({ dataDir });
  t.after(async () => {
    await sessions.ready;
    await sessions.close();
    await sessions.tmux(["kill-server"]).catch(() => {});
    fs.rmSync(path.dirname(sessions.socketPath), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const delivered = new Set(),
    noop = { discard() {}, remove() {} };
  const services = {
    accounts: { get: () => account, home, dataDir, environment: () => ({}) },
    providerAccess: { resolve: () => ({ account }) },
    tools: () => [{ id: "codex", installed: true }],
    sharedProfiles: { resolve: () => account.id, prepare() {} },
    sessionMcp: {
      ...noop,
      resources: () => ({
        projects: [{ id: "another-project" }],
        accounts: [account, { id: "unused" }],
        connections: [{ id: "paid" }, { id: "unused" }],
      }),
    },
    pipelineDefinitions: {
      listProfiles: () => [
        { config: { accountId: account.id, providerConnectionId: "paid" } },
      ],
    },
    sessions,
    pipelineWorkspace: new PipelineWorkspace({ dataDir, sessions }),
    launch: async (body, login, trusted) => {
      assert.equal(login, false);
      assert.equal(trusted.pipeline, undefined);
      assert.deepEqual(body.agentpierTools, {
        currentProject: true,
        projectIds: [],
        scopes: ["catalog:read", "runs:read", "runs:start", "runs:publish"],
        accountIds: [account.id],
        connectionIds: ["paid"],
      });
      return sessions.create({
        ...body,
        id: trusted.id,
        accountId: account.id,
        command: "/bin/cat",
        args: [],
        env: {},
      });
    },
    chatDelivery: {
      ...noop,
      send: async (id, request) => {
        assert.match(request.text, /agentpier-composer/);
        assert.match(request.text, /reconcile/i);
        delivered.add(request.deliveryId);
        return { status: "accepted" };
      },
    },
    requests: noop,
    chatAttachments: noop,
    memoryIntegration: noop,
    activity: noop,
    chat: noop,
    bindings: noop,
    github: noop,
    models: noop,
    pipelines: { store: { all: () => [] } },
  };
  function context() {
    const id = randomUUID();
    const ctx = {
      id,
      title: "Two orders with the same name",
      projectRoot,
      commonDir: path.join(projectRoot, ".git"),
      filename: id + ".json",
      selection: { tool: "codex" },
      resources: {},
      saveResources: async (value) => {
        ctx.resources = structuredClone(value);
      },
    };
    return ctx;
  }
  return {
    services,
    git,
    skill,
    ctx: context(),
    context,
    delivered,
    api: new OrderResources(services),
  };
}

test("owner selections exclude session identity, paths and non-coding sessions", () => {
  for (const value of [
    null,
    {},
    { tool: "shell" },
    { tool: "codex", cwd: "/tmp" },
    { accountId: 5 },
  ])
    assert.throws(() => checkSelection(value));
  assert.deepEqual(checkSelection({ tool: "codex", accountId: "acct" }), {
    tool: "codex",
    accountId: "acct",
  });
});

test("an order's SSH hosts and secrets are a stable, bounded part of its selection", () => {
  for (const value of [
    { tool: "codex", sshAccessIds: "host" },
    { tool: "codex", sshAccessIds: ["a", "a"] },
    { tool: "codex", sshAccessIds: Array.from({ length: 31 }, (_, i) => "h" + i) },
    { tool: "codex", secretIds: [""] },
    { tool: "codex", secretIds: [5] },
    { tool: "codex", secretIds: ["a\nb"] },
    { tool: "codex", secretIds: Array.from({ length: 51 }, (_, i) => "s" + i) },
  ])
    assert.throws(() => checkSelection(value), JSON.stringify(value));
  assert.deepEqual(
    checkSelection({
      secretIds: ["s2", "s1"],
      sshAccessIds: ["h2", "h1"],
      tool: "codex",
    }),
    { tool: "codex", sshAccessIds: ["h1", "h2"], secretIds: ["s1", "s2"] },
  );
  // No list and an empty one are the same request, as before the lists existed.
  assert.deepEqual(checkSelection({ tool: "codex", sshAccessIds: [], secretIds: [] }), {
    tool: "codex",
  });
});

test("the order session launches with its chosen hosts and secrets that still exist", async (t) => {
  const { api, ctx, services } = fixture(t);
  services.sshAccesses = { list: () => [{ id: "host-1" }, { id: "other" }] };
  services.secrets = { names: () => [{ id: "secret-1", name: "TOKEN" }] };
  const launch = services.launch;
  let body;
  services.launch = (input, ...rest) => {
    body = input;
    return launch(input, ...rest);
  };
  ctx.selection = {
    tool: "codex",
    sshAccessIds: ["host-1", "deleted-host"],
    secretIds: ["deleted-secret", "secret-1"],
  };
  await api.start(ctx);
  assert.deepEqual(body.sshAccessIds, ["host-1"]);
  assert.deepEqual(body.secretIds, ["secret-1"]);
  assert.equal(body.tool, "codex");
});

test("a removed or outdated Composer package requires repair before provisioning", async (t) => {
  const { api, ctx, skill } = fixture(t);
  fs.writeFileSync(path.join(skill, "SKILL.md"), "Old local skill");
  await assert.rejects(api.start(ctx), { status: 409 });
  assert.deepEqual(ctx.resources, {});
});

test("same-title orders have independent worktrees and interactive sessions; recovery reconciles before launching", async (t) => {
  const { api, ctx, context, services, delivered } = fixture(t);
  const another = context();
  const [first, second] = await Promise.all([api.start(ctx), api.start(another)]);
  assert.notEqual(first.worktree, second.worktree);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(delivered.size, 2);
  const restarted = new OrderResources(services);
  assert.deepEqual(await restarted.start(ctx), first);
  assert.equal(delivered.size, 2);
  await services.sessions.stop(first.sessionId);
  await services.sessions.remove(first.sessionId);
  assert.equal(await restarted.inspectSession(ctx), null);
  await assert.rejects(restarted.start(ctx), { status: 409 });
  const recovered = await restarted.start(ctx, { recover: true });
  assert.equal(recovered.worktree, first.worktree);
  assert.notEqual(recovered.sessionId, first.sessionId);
  assert.equal(delivered.size, 3);
  assert.deepEqual(await api.inspectSession(another), {
    id: second.sessionId,
    status: "running",
  });
});

test("cleanup refuses live sessions, ignored files and divergent commits before recording intent; retries never remove a changed branch", async (t) => {
  const { api, ctx, services, git } = fixture(t);
  const { sessionId, worktree, branch } = await api.start(ctx);
  let begins = 0;
  const begin = async () => {
    begins++;
    ctx.cleanup = true;
  };
  await assert.rejects(api.cleanup(ctx, { begin }), { status: 409 });
  await services.sessions.stop(sessionId);
  fs.writeFileSync(path.join(worktree, "untracked"), "keep");
  await assert.rejects(api.cleanup(ctx, { begin }), { status: 409 });
  fs.renameSync(path.join(worktree, "untracked"), path.join(worktree, ".pipeline"));
  await assert.rejects(api.cleanup(ctx, { begin }), { status: 409 });
  fs.unlinkSync(path.join(worktree, ".pipeline"));
  git(worktree, "commit", "-q", "--allow-empty", "-m", "unmerged");
  await assert.rejects(api.cleanup(ctx, { begin }), { status: 409 });
  assert.equal(begins, 0);
  git(ctx.projectRoot, "merge", "--ff-only", branch);
  const save = ctx.saveResources;
  ctx.saveResources = async (value) => {
    if (!fs.existsSync(worktree)) throw Error("interrupted");
    await save(value);
  };
  await assert.rejects(api.cleanup(ctx, { begin }), /interrupted/);
  assert.equal(fs.existsSync(worktree), false);
  ctx.saveResources = save;
  await new OrderResources(services).cleanup(ctx, { begin });
  assert.ok(!git(ctx.projectRoot, "branch", "--list", branch));
  assert.equal(await api.inspectSession(ctx), null);
});

test("a crash between reserving a Git workspace and adding it restarts the reserved preparation", async (t) => {
  const { api, ctx, services, git } = fixture(t);
  const manager = services.pipelineWorkspace;
  const original = manager.prepare.bind(manager);
  manager.prepare = async (input) => {
    const workspace = await original(input);
    git(ctx.projectRoot, "worktree", "remove", workspace.cwd);
    git(ctx.projectRoot, "branch", "-d", workspace.branch);
    fs.writeFileSync(
      manager.file(workspace.runId),
      JSON.stringify({ ...workspace, preparing: true }),
    );
    throw Error("crash");
  };
  await assert.rejects(api.start(ctx), /crash/);
  manager.prepare = original;
  const started = await new OrderResources(services).start(ctx);
  assert.equal(
    started.worktree,
    path.join(ctx.projectRoot, ".agentpier-worktrees", ctx.resources.workspaceId),
  );
});

test("a changed branch after worktree removal and a replaced checkout never confer deletion authority", async (t) => {
  const { api, ctx, services, git } = fixture(t);
  const { sessionId, worktree, branch } = await api.start(ctx);
  await services.sessions.stop(sessionId);
  git(worktree, "switch", "-qc", "foreign-branch");
  const begin = async () => {
    ctx.cleanup = true;
  };
  await assert.rejects(api.cleanup(ctx, { begin }), { status: 409 });
  assert.equal(ctx.cleanup, undefined);
  git(worktree, "switch", "-q", branch);
  const save = ctx.saveResources;
  ctx.saveResources = async (value) => {
    if (value.worktreeRemoved) throw Error("interrupted");
    return save(value);
  };
  await assert.rejects(api.cleanup(ctx, { begin }), /interrupted/);
  const other = git(
    ctx.projectRoot,
    "commit-tree",
    "-p",
    "HEAD",
    "HEAD^{tree}",
    "-m",
    "unmerged",
  );
  git(ctx.projectRoot, "update-ref", "refs/heads/" + branch, other);
  ctx.saveResources = save;
  await assert.rejects(api.cleanup(ctx, { begin }), {
    code: "AUTOPILOT_WORKTREE_UNMERGED",
  });
  assert.equal(git(ctx.projectRoot, "rev-parse", branch), other);
  assert.equal((await services.sessions.get(sessionId)).status, "stopped");
});

test("resuming a stopped, bound CLI uses normal session reload and re-delivers the checkpoint once", async (t) => {
  const { api, ctx, services, delivered } = fixture(t);
  const started = await api.start(ctx);
  await services.sessions.stop(started.sessionId);
  const requests = [];
  services.reload = {
    status: async () => ({ eligible: true, state: "idle" }),
    request: async (id, body, { current }) => {
      assert.ok(await current(await services.sessions.get(id)));
      requests.push(id);
      await services.sessions.updateReload(id, {
        state: "reloading",
        nativeId: "fixture",
      });
      await services.sessions.replace(id, async () => ({
        command: "/bin/cat",
        args: [],
        env: {},
      }));
      return { state: "completed" };
    },
  };
  assert.deepEqual(await api.start(ctx), started);
  assert.deepEqual(await api.start(ctx), started);
  assert.equal(requests.length, 1);
  assert.equal(delivered.size, 2);
});

test("an explicitly retried rejected kickoff delivers the same order to its existing session", async (t) => {
  const { api, ctx, services } = fixture(t);
  const attempts = [];
  services.chatDelivery.send = async (id, { deliveryId }) => {
    attempts.push({ id, deliveryId });
    return { status: attempts.length === 1 ? "rejected" : "accepted" };
  };
  await assert.rejects(api.start(ctx), { code: "AUTOPILOT_DELIVERY_FAILED" });
  await assert.rejects(api.start(ctx), { code: "AUTOPILOT_DELIVERY_FAILED" });
  const recovered = await api.start(ctx, { recover: true });
  assert.equal(recovered.sessionId, attempts[0].id);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].deliveryId, attempts[1].deliveryId);
});

test("cleanup refreshes a remote base and requires the Composer head on that branch", async (t) => {
  const { api, ctx, services, git } = fixture(t);
  const origin = path.join(path.dirname(ctx.projectRoot), "origin.git");
  git(ctx.projectRoot, "init", "--bare", "-q", "-b", "main", origin);
  git(ctx.projectRoot, "remote", "add", "origin", origin);
  git(ctx.projectRoot, "push", "-q", "origin", "main");
  const { sessionId, branch } = await api.start(ctx);
  await services.sessions.stop(sessionId);
  // A force-push replaces origin/main out of band. The checkout's cached ref still
  // contains the Composer head, but a cleanup must keep the owner's branch.
  const replacement = git(
    ctx.projectRoot,
    "commit-tree",
    "HEAD^{tree}",
    "-m",
    "replacement",
  );
  git(ctx.projectRoot, "push", "-q", "--force", origin, replacement + ":refs/heads/main");
  await assert.rejects(
    api.cleanup(ctx, { begin: async () => assert.fail("not merged") }),
    { code: "AUTOPILOT_WORKTREE_UNMERGED" },
  );
  assert.ok(git(ctx.projectRoot, "branch", "--list", branch));
});
