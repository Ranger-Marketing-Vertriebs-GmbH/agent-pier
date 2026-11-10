import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { codingSessionDefinition } from "../../server/features/assistants/team-plugin/coding-session-tool.js";

async function fixture(t, { worktree = false } = {}) {
  const f = await agentSessionFixture(t);
  const calls = [];
  const s = f.services;
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  s.sessions.remove = async (id) => {
    if ((await s.sessions.get(id)).status === "running")
      throw Object.assign(Error("Stop before deleting"), { status: 409 });
    calls.push(["sessions.remove", id]);
    f.sessions.delete(id);
  };
  for (const name of [
    "sessionMcp",
    "sshSessions",
    "sessionSecrets",
    "sshIntegration",
    "chatDelivery",
    "chatAttachments",
    "requests",
    "memoryIntegration",
    "bindings",
    "github",
    "chatSync",
  ]) {
    s[name] ??= {};
    s[name].discard = record(`${name}.discard`);
  }
  for (const name of ["activity", "chat", "models"]) {
    s[name] ??= {};
    s[name].remove = record(`${name}.remove`);
  }
  s.chatImages = { forgetSession: record("chatImages.forgetSession") };
  s.live = { invalidate: record("live.invalidate") };
  const events = [];
  s.audit = { append: (e) => events.push(auditEvent(e)) };
  const { sessionId } = await f.call(await f.invocation(), {
    action: "start",
    requestId: "delete-test",
    projectId: f.project.id,
    tool: "codex",
    worktree,
  });
  const invoke = async (action, id = sessionId) =>
    f.call(await f.invocation(), { action, sessionId: id });
  return { ...f, sessionId, calls, events, invoke };
}

const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => toolError(error).code === code);

test("delete is advertised and removes stopped session data, signals state and audits the agent", async (t) => {
  assert.ok(
    codingSessionDefinition.coding_session.parameters.properties.action.enum.includes(
      "delete",
    ),
  );
  const f = await fixture(t, { worktree: true });
  const id = f.sessionId;
  const worktree = f.workflows.sessions.store.get(id).worktree;
  const unsaved = path.join(worktree.cwd, "unsaved.txt");
  fs.writeFileSync(unsaved, "keep this work\n");
  const directory = path.join(f.dataDir, "attachments", id);
  f.sessions.get(id).attachments = { directory };
  await f.invoke("stop");
  f.calls.length = 0;
  f.workflows.sessions.readAt.set(id, Date.now());
  f.workflows.sessions.store.patch(id, { wakes: { state: { seq: 1 } } });
  assert.deepEqual(await f.invoke("delete"), { deleted: true });
  assert.equal(f.sessions.has(id), false);
  assert.deepEqual(f.calls, [
    ["sessions.remove", id],
    ["sessionMcp.discard", id],
    ["sshSessions.discard", id],
    ["sessionSecrets.discard", id],
    ["sshIntegration.discard", id],
    ["chatDelivery.discard", id],
    ["chatAttachments.discard", id, directory],
    ["requests.discard", id],
    ["memoryIntegration.discard", id],
    ["activity.remove", id],
    ["chat.remove", id],
    ["chatImages.forgetSession", id],
    ["chatSync.discard", id],
    ["bindings.discard", id],
    ["github.discard", id],
    ["models.remove", id],
    ["live.invalidate", "state"],
  ]);
  assert.equal(fs.readFileSync(unsaved, "utf8"), "keep this work\n");
  execFileSync("git", ["show-ref", "--verify", `refs/heads/${worktree.branch}`], {
    cwd: f.cwd,
  });
  const saved = f.workflows.sessions.store.get(id);
  assert.equal(saved.ended, true);
  assert.deepEqual(saved.wakes, {});
  assert.equal(f.workflows.sessions.readAt.has(id), false);
  const listed = await f.invoke("list");
  assert.equal(listed.sessions[0].status, "gone");
  assert.equal(listed.sessions[0].ended, true);
  const event = f.events.find((e) => e.action === "session.deleted");
  assert.equal(event.sessionId, id);
  assert.deepEqual(event.details.agentSession, { assistantId: f.id, op: "delete" });
  assert.ok(!JSON.stringify(event).includes(directory));
  await rejectsCode(f.invoke("delete"), "NOT_FOUND");
  await rejectsCode(f.invoke("read"), "NOT_FOUND");
  // A replay of the original start cannot recreate the deleted session.
  const replay = await f.call(await f.invocation(), {
    action: "start",
    requestId: "delete-test",
    projectId: f.project.id,
    tool: "codex",
    worktree: true,
  });
  assert.equal(replay.sessionId, id);
  assert.equal(f.launches.length, 1);
});

test("delete refuses a running session, missing ids and sessions of owners or other agents", async (t) => {
  const f = await fixture(t);
  await rejectsCode(f.invoke("delete"), "SESSION_RUNNING");
  await rejectsCode(f.invoke("delete", "missing"), "NOT_FOUND");
  await f.services.launch({ tool: "codex", cwd: f.cwd }, false, { id: "owner-session" });
  await f.services.sessions.stop("owner-session");
  await rejectsCode(f.invoke("delete", "owner-session"), "NOT_FOUND");
  await f.invoke("stop");
  const own = f.workflows.sessions.store.get(f.sessionId);
  f.workflows.sessions.store.delete(f.sessionId);
  f.workflows.sessions.store.insert({ ...own, assistantId: "another-agent" });
  await rejectsCode(f.invoke("delete"), "NOT_FOUND");
  assert.deepEqual(f.calls, []);
  assert.equal(f.sessions.size, 2);
  assert.equal(
    f.events.some((e) => e.action === "session.deleted"),
    false,
  );
});

test("delete refuses revoked access and a turn that ended during the session lookup", async (t) => {
  const f = await fixture(t);
  await f.invoke("stop");
  const access = f.workflows.access;
  access.save(f.id, { ...f.policy, sessionProjectIds: [] }, access.get(f.id).revision);
  await rejectsCode(f.invoke("delete"), "GRANT_REVOKED");
  access.save(
    f.id,
    { ...f.policy, sessionProjectIds: [f.project.id] },
    access.get(f.id).revision,
  );
  const stale = {
    ...(await f.invocation()),
    assertCurrent() {
      throw Error("turn ended");
    },
  };
  await assert.rejects(
    f.call(stale, { action: "delete", sessionId: f.sessionId }),
    /turn ended/,
  );
  assert.deepEqual(f.calls, []);
  assert.ok(f.sessions.has(f.sessionId));
});

test("a removal rejected by the session manager leaves all data and the agent record intact", async (t) => {
  const f = await fixture(t);
  await f.invoke("stop");
  // The owner can resume the session after control() but before serialized removal.
  f.services.sessions.remove = async () => {
    throw Object.assign(Error("Session resumed"), { status: 409 });
  };
  const before = f.workflows.sessions.store.get(f.sessionId);
  await assert.rejects(f.invoke("delete"), { status: 409 });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.workflows.sessions.store.get(f.sessionId), before);
  assert.equal(
    f.events.some((e) => e.action === "session.deleted"),
    false,
  );
});
