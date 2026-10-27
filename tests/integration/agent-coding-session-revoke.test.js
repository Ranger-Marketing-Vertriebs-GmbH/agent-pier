import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { mergedIntoBase } from "../../server/features/assistants/coding-sessions/session-worktrees.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected the call to fail");
};
// Git inside the fixture's temporary folders only, never with the user's config.
const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
const commit = (cwd, file, text = `${file}\n`) => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", `add ${file}`]);
  return git(cwd, ["rev-parse", "HEAD"]);
};
// A clone of origin that takes the worktree branch's commits onto main and pushes:
// the project's own origin/main stays stale until AgentPier fetches.
function mergeOnOrigin(f, branch, how) {
  const clone = path.join(f.dataDir, `clone-${crypto.randomUUID()}`);
  git(f.dataDir, ["clone", "-q", f.remote, clone]);
  commit(clone, `other-${crypto.randomUUID()}.txt`);
  git(clone, ["fetch", "-q", f.cwd, `${branch}:incoming`]);
  if (how === "rebase") {
    for (const sha of git(clone, ["rev-list", "--reverse", "main..incoming"]).split("\n"))
      git(clone, ["cherry-pick", sha]);
  } else {
    git(clone, ["merge", "-q", "--squash", "incoming"]);
    git(clone, ["commit", "-q", "-m", "squashed"]);
  }
  git(clone, ["push", "-q", "origin", "main"]);
}

async function startOne(f, input = {}) {
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "codex",
    ...input,
  });
  assert.equal(r.state, "running");
  return { ...r, record: f.workflows.sessions.store.get(r.sessionId) };
}
const stop = async (f, sessionId) =>
  f.call(await f.invocation(), { action: "stop", sessionId });
const removeWorktree = async (f, sessionId) =>
  f.call(await f.invocation(), { action: "worktree_remove", sessionId });
const branchExists = (f, branch) => {
  try {
    git(f.cwd, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};
// The fixture's GitHub stand-in hands git a credential-free environment.
function withCredentials(f) {
  f.services.github.prepare = async ({ launch }) => ({ env: launch.env });
  f.services.github.discard = async () => {};
}

test("stop keeps the worktree and its branch", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const s = await startOne(f);
  const { cwd, branch } = s.record.worktree;
  const r = await stop(f, s.sessionId);
  assert.deepEqual(r, { stopped: true, state: "ended" });
  assert.equal(f.sessions.get(s.sessionId).status, "stopped");
  assert.ok(fs.existsSync(cwd));
  assert.ok(branchExists(f, branch));
  assert.equal(f.workflows.sessions.store.get(s.sessionId).seen.state, "ended");
  const stopped = events.find((e) => e.action === "session.stopped");
  assert.equal(stopped.sessionId, s.sessionId);
  assert.deepEqual(stopped.details.agentSession, { assistantId: f.id, op: "stop" });
  // Stopping again is harmless; through the reload service when there is one.
  const reloads = [];
  f.services.reload = { stop: async (id) => reloads.push(id) };
  const other = await startOne(f, { worktree: false });
  assert.deepEqual(await stop(f, other.sessionId), {
    stopped: true,
    state: "idle",
  });
  assert.deepEqual(reloads, [other.sessionId]);
  assert.deepEqual(await stop(f, s.sessionId), { stopped: true, state: "ended" });
  // Never another session: the owner's own answers NOT_FOUND and keeps running.
  await f.services.launch({ tool: "claude", cwd: f.cwd }, false, { id: "owner-1" });
  assert.equal(await code(stop(f, "owner-1")), "NOT_FOUND");
  assert.equal(f.sessions.get("owner-1").status, "running");
});

test("worktree_remove refuses a running session, a dirty tree and an unmerged branch", async (t) => {
  const f = await agentSessionFixture(t);
  withCredentials(f);
  const s = await startOne(f);
  const { cwd, branch } = s.record.worktree;
  commit(cwd, "feature.txt");
  assert.equal(await code(removeWorktree(f, s.sessionId)), "SESSION_RUNNING");
  await stop(f, s.sessionId);
  fs.writeFileSync(path.join(cwd, "scratch.txt"), "dirty\n");
  assert.equal(await code(removeWorktree(f, s.sessionId)), "WORKTREE_DIRTY");
  fs.rmSync(path.join(cwd, "scratch.txt"));
  assert.equal(await code(removeWorktree(f, s.sessionId)), "WORKTREE_NOT_MERGED");
  // A squash merge rewrites the patch: the branch counts as unmerged and stays.
  commit(cwd, "second.txt");
  mergeOnOrigin(f, branch, "squash");
  assert.equal(await code(removeWorktree(f, s.sessionId)), "WORKTREE_NOT_MERGED");
  assert.ok(fs.existsSync(cwd));
  assert.ok(branchExists(f, branch));
  assert.equal(f.workflows.sessions.store.get(s.sessionId).worktree.removed, undefined);
  // A session without a worktree has nothing to remove.
  const plain = await startOne(f, { worktree: false });
  await stop(f, plain.sessionId);
  assert.equal(await code(removeWorktree(f, plain.sessionId)), "INVALID_INPUT");
  assert.equal(await code(removeWorktree(f, "missing")), "NOT_FOUND");
});

test("worktree_remove removes a clean worktree whose commits are on origin/main after a rebase merge", async (t) => {
  const f = await agentSessionFixture(t);
  withCredentials(f);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const s = await startOne(f);
  const { cwd, branch, runId } = s.record.worktree;
  commit(cwd, "one.txt");
  commit(cwd, "two.txt");
  await stop(f, s.sessionId);
  mergeOnOrigin(f, branch, "rebase");
  // A turn that ended before the removal removes nothing.
  const stale = {
    ...(await f.invocation()),
    assertCurrent() {
      throw Object.assign(Error("stale"), { status: 409 });
    },
  };
  await assert.rejects(
    f.call(stale, { action: "worktree_remove", sessionId: s.sessionId }),
  );
  assert.ok(fs.existsSync(cwd));
  const r = await removeWorktree(f, s.sessionId);
  assert.deepEqual(r, { removed: true, keptBranch: branch });
  assert.equal(fs.existsSync(cwd), false);
  // The branch stays: removing a worktree never discards a commit.
  assert.ok(branchExists(f, branch));
  assert.equal(f.workflows.sessions.store.get(s.sessionId).worktree.removed, true);
  const listed = await f.call(await f.invocation(), { action: "list" });
  assert.equal(listed.sessions[0].worktree.removed, true);
  const removed = events.find((e) => e.details?.agentSession?.op === "worktree-remove");
  assert.equal(removed.outcome, "success");
  assert.equal(removed.sessionId, s.sessionId);
  assert.deepEqual(removed.details.agentSession, {
    assistantId: f.id,
    op: "worktree-remove",
  });
  assert.ok(!JSON.stringify(events).includes(branch));
  // Again: already removed.
  assert.deepEqual(await removeWorktree(f, s.sessionId), {
    removed: true,
    keptBranch: branch,
  });
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.dataDir, "pipeline-workspaces", `${runId}.json`)),
    ).removed,
    true,
  );
});

test("mergedIntoBase: an ancestor of origin/<base>, or every commit picked onto it", async (t) => {
  const f = await agentSessionFixture(t);
  const s = await startOne(f);
  const workspace = JSON.parse(
    fs.readFileSync(
      path.join(f.dataDir, "pipeline-workspaces", `${s.record.worktree.runId}.json`),
    ),
  );
  // No commits yet: HEAD is the base, on origin/main.
  assert.equal(await mergedIntoBase(workspace), true);
  const sha = commit(workspace.cwd, "feature.txt");
  assert.equal(await mergedIntoBase(workspace), false);
  // Fast-forwarded onto origin main (pushed from the project, so no fetch needed).
  git(f.cwd, ["push", "-q", "origin", `${sha}:refs/heads/main`]);
  assert.equal(await mergedIntoBase(workspace), true);
  // An unknown base branch on origin is never merged.
  assert.equal(await mergedIntoBase({ ...workspace, baseBranch: "nowhere" }), false);
});

test("switching sessions off leaves the session running and answers GRANT_REVOKED", async (t) => {
  const f = await agentSessionFixture(t);
  const s = await startOne(f);
  const access = f.workflows.access;
  access.save(f.id, { ...f.policy, sessionProjectIds: [] }, access.get(f.id).revision);
  const send = { action: "send", sessionId: s.sessionId, text: "go on" };
  assert.equal(await code(f.call(await f.invocation(), send)), "GRANT_REVOKED");
  for (const action of ["stop", "worktree_remove", "read", "requests"])
    assert.equal(
      await code(f.call(await f.invocation(), { action, sessionId: s.sessionId })),
      "GRANT_REVOKED",
      action,
    );
  assert.equal(f.sessions.get(s.sessionId).status, "running");
  assert.deepEqual(f.sessions.get(s.sessionId).startedBy, {
    kind: "agent",
    assistantId: f.id,
    name: f.store.getAssistant(f.id).name,
  });
  assert.ok(fs.existsSync(s.record.worktree.cwd));
  assert.equal(f.workflows.sessions.store.get(s.sessionId).ended, false);
});

test("removing the project grant, archiving the agent or revoking the lead's share revokes control", async (t) => {
  const f = await agentSessionFixture(t);
  const w = f.workflows;
  const read = async (id) =>
    f.call(await f.invocation(), { action: "read", sessionId: id });
  // The project grant itself.
  const s = await startOne(f, { worktree: false });
  w.access.save(f.id, { ...f.policy, projectIds: [] }, w.access.get(f.id).revision);
  assert.equal(await code(read(s.sessionId)), "GRANT_REVOKED");
  assert.equal(f.sessions.get(s.sessionId).status, "running");

  // A session on the lead's share: control lasts while the share does.
  const lead = f.store.createAssistant({
    name: "Lead",
    model: { connectionId: "test", modelId: "fixture" },
  });
  w.access.save(lead.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  const shared = await f.services.launch({ tool: "codex", cwd: f.cwd }, false, {
    id: crypto.randomUUID(),
    startedBy: { kind: "agent", assistantId: f.id, name: "Agent" },
  });
  w.sessions.store.insert({
    ...w.sessions.store.get(s.sessionId),
    sessionId: shared.id,
    inherited: { leadId: lead.id, shareId: "share-1" },
  });
  const row = {
    id: "share-1",
    kind: "project",
    requestId: null,
    memberAssistantId: f.id,
    leadId: lead.id,
    projectId: f.project.id,
  };
  let rows = { "share-1": row };
  w.shares.find = (id) => rows[id] ?? null;
  w.shares.live = () => ({ ended: null, coding: true });
  assert.equal((await read(shared.id)).cursor, null);
  rows = {};
  assert.equal(await code(read(shared.id)), "GRANT_REVOKED");
  assert.equal(f.sessions.get(shared.id).status, "running");

  // Archiving the agent.
  w.access.save(
    f.id,
    { ...f.policy, sessionProjectIds: [f.project.id] },
    w.access.get(f.id).revision,
  );
  const own = await startOne(f, { worktree: false });
  const { control } =
    await import("../../server/features/assistants/coding-sessions/session-control.js");
  await control(w, f.id, own.sessionId);
  archive(f);
  assert.equal(await code(control(w, f.id, own.sessionId)), "GRANT_REVOKED");
  assert.equal(f.sessions.get(own.sessionId).status, "running");
});

// Archives the agent as the store keeps it (team-store.js, user-release.js).
function archive(f) {
  const body = { ...f.store.storedAssistant(f.id), archivedAt: new Date().toISOString() };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
}

test("archiving the agent never deletes the worktree", async (t) => {
  const f = await agentSessionFixture(t);
  const s = await startOne(f);
  const { cwd, branch } = s.record.worktree;
  commit(cwd, "work.txt");
  fs.writeFileSync(path.join(cwd, "unsaved.txt"), "keep\n");
  archive(f);
  await f.workflows.tick?.();
  await f.workflows.sessions.tick();
  assert.ok(fs.existsSync(cwd));
  assert.ok(fs.existsSync(path.join(cwd, "unsaved.txt")));
  assert.ok(branchExists(f, branch));
  assert.equal(f.sessions.get(s.sessionId).status, "running");
  assert.ok(f.workflows.sessions.store.get(s.sessionId));
});
