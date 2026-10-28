import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execContinuationFixture } from "../helpers/exec-continuation-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// AGENTPIER-274: the owner decided that an agent may always send files back to him.
// agentpier_share_file reaches the owner's chat from every run of that chat (a direct
// turn, OpenClaw's follow-up after a background command, a member's result, a
// routine), whatever turn came before; only the file checks and other recipients'
// rules still refuse.
async function setup(t, options) {
  const f = await execContinuationFixture(t, options);
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const leadRequests = new Map();
  f.assistants.teams.store.find = (id) => leadRequests.get(id) || null;
  for (const id of ["r1", "r2"])
    leadRequests.set(id, { id, kind: "lead-request", parentAssistantId: f.id });
  const file = (name, body = "MP4") => {
    const target = path.join(f.workspaces, f.id, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  file("episode.mp4");
  // As the plugin prepares and invokes a share of a run of this session.
  const share = async (input = { path: "episode.mp4" }, runId = "turn-1", key) => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: key || "session",
      toolCallId: randomUUID(),
      action: "share_file",
      ...(runId ? { runId } : {}),
    });
    return f.bridge.invoke({ ticket, action: "share_file", input });
  };
  const sent = () => f.audits.filter((e) => e.action === "assistant.sent");
  const ended = async (runId) => {
    await f.emit("agent_end", {}, { sessionKey: "session", runId });
    f.assistants.completionRuns.observe({
      runId,
      sessionKey: "session",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  };
  // A native write of a completion run (the gate that still proves continuations).
  const write = (ctx) => f.call("notes/render.md", { ctx });
  const files = () => f.service.outbox.all(f.channel.id).filter((e) => e.kind === "file");
  const telegram = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  };
  return { ...f, leadRequests, file, share, sent, ended, write, files, telegram };
}
const forbidden = (error) => toolError(error).code === "FORBIDDEN";
const nul =
  "Execution command and arguments must not contain NUL bytes. Remove them and retry.";
const failed = (text) => ({ content: [{ type: "text", text }], details: {} });
// OpenClaw 2026.10.7's result of an error thrown inside the exec tool.
const thrown = (error) => ({
  content: [
    { type: "text", text: JSON.stringify({ status: "error", tool: "exec", error }) },
  ],
  details: { status: "error", tool: "exec", error },
});

test("a follow-up after a background command shares whatever turn started it", async (t) => {
  for (const origin of [
    { kind: "owner" },
    { kind: "owner", forwarded: true },
    { kind: "reminder" },
    { kind: "lead-request", requestId: "r1" },
    { kind: "member-result", requestId: "r9" },
    { kind: "hook" },
    { kind: "unknown" },
  ]) {
    const f = await setup(t);
    await f.turn(origin);
    await f.eventTurn();
    const result = await f.share({ path: "episode.mp4", caption: "Final cut" });
    assert.equal(result.status, "shared", JSON.stringify(origin));
    assert.equal(result.telegram, undefined);
    assert.deepEqual(
      f.sent().map((e) => e.details),
      [{ kind: "share", channel: "tool", via: "agent-run" }],
    );
  }
  // A run of the chat that is no completion at all (a check-in) shares too.
  const g = await setup(t);
  assert.equal((await g.share(undefined, "check-in-run")).status, "shared");
  assert.equal((await g.share(undefined, null)).status, "shared");
});

test("a render shares after member results and newer messages of any kind", async (t) => {
  const f = await setup(t);
  const { attemptId } = await f.invocation("lead-request-result:r1", {
    kind: "member-result",
    requestId: "r1",
  });
  await f.exec(attemptId);
  f.assistants.ledger.transition(attemptId, "completed");
  for (const [key, origin] of [
    ["lead-request-result:r2", { kind: "member-result", requestId: "r2" }],
    [randomUUID(), { kind: "owner", forwarded: true }],
    [randomUUID(), { kind: "reminder" }],
  ]) {
    const later = await f.invocation(key, origin);
    f.assistants.ledger.transition(later.attemptId, "completed");
  }
  await f.eventTurn();
  assert.equal((await f.share()).status, "shared");
});

test("a rejected NUL-byte command never blocks the chat's later follow-ups", async (t) => {
  const f = await setup(t);
  // OpenClaw's supervisor refuses it before spawning anything.
  await f.exec("earlier-run", { result: thrown(nul), error: nul });
  await f.turn({ kind: "owner" });
  const ctx = await f.eventTurn();
  assert.equal((await f.share()).status, "shared");
  // Writes and project folder actions, still proven, continue the owner turn too.
  assert.equal(await f.write(ctx), true);
});

test("a follow-up run that started its own command continues its owner turn", async (t) => {
  const f = await setup(t);
  const source = await f.turn({ kind: "owner" }, { sessionId: "lucky-tidepool" });
  // The render's completion run starts the export in the background.
  await f.eventTurn("turn-1", { line: "Exec completed (lucky-ti, code 0) :: rendered" });
  await f.exec("turn-1", { sessionId: "young-canyon" });
  await f.ended("turn-1");
  // The export's completion run.
  const ctx = await f.eventTurn("turn-2", {
    line: "Exec completed (young-ca, code 0) :: exported",
  });
  assert.equal((await f.share(undefined, "turn-2")).status, "shared");
  assert.equal(await f.write(ctx), true);
  assert.deepEqual(f.writes(), [["notes/render.md", source]]);
});

test("an uncertain exec call blocks other runs' follow-ups only while its run lasts", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  // Another run's call ends in an error that may come after a backgrounded start.
  await f.exec("other-run", { result: failed("Aborted"), error: "Aborted" });
  const ctx = await f.eventTurn();
  assert.equal(await f.write(ctx), false);
  // Sharing with the owner never waits for it.
  assert.equal((await f.share()).status, "shared");
  await f.ended("other-run");
  assert.equal(await f.write({ ...ctx }), true);
});

test("a routine's run shares from its workspace and the agent's project folders", async (t) => {
  const f = await setup(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    capabilities: { memory: true, reminders: true },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-share-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "cut.mp4"), "MP4");
  const project = await f.memory.register(folder);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [project.id], projectFiles: { [project.id]: "read" } },
    f.workflows.access.get(f.id).revision,
  );
  const runKey = `agent:${f.agentId}:cron:job-1:run:run-7`;
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.assistants.routines = {
    runOrigin: (agent, key) =>
      agent.id === f.id && key === runKey
        ? {
            binding: { id: "b1", source: { assistantId: f.id }, telegram: null },
            conversation,
          }
        : null,
    writable: () => false,
  };
  assert.equal((await f.share(undefined, "run-7", runKey)).status, "shared");
  const shared = await f.share(
    { projectId: project.id, path: "cut.mp4" },
    "run-7",
    runKey,
  );
  assert.equal(shared.status, "shared");
});

test("project folders share on the agent's own grant in every turn of its chat", async (t) => {
  const f = await setup(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owner-share-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, ".git"));
  fs.writeFileSync(path.join(folder, ".git", "config"), "[remote] url=secret");
  fs.writeFileSync(path.join(folder, "cut.mp4"), "MP4");
  fs.writeFileSync(path.join(f.dataDir, "outside.txt"), "outside");
  fs.symlinkSync(path.join(f.dataDir, "outside.txt"), path.join(folder, "out.txt"));
  // AgentPier's own data inside the project folder is never shared.
  const data = path.join(folder, "agentpier-data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "secret.txt"), "secret");
  f.services.config.dataDir = data;
  const project = await f.memory.register(folder);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [project.id], projectFiles: { [project.id]: "read" } },
    f.workflows.access.get(f.id).revision,
  );
  const cut = { projectId: project.id, path: "cut.mp4" };
  // OpenClaw's follow-up run, and a reminder's turn (no owner-proven turn).
  await f.turn({ kind: "owner", forwarded: true });
  await f.eventTurn();
  assert.equal((await f.share(cut)).status, "shared");
  const { attemptId } = await f.invocation(randomUUID(), { kind: "reminder" });
  assert.equal((await f.share(cut, attemptId)).status, "shared");
  f.assistants.ledger.transition(attemptId, "completed");
  // The file checks stay: other projects, .git, links out, AgentPier's data, paths
  // outside the workspace.
  for (const input of [
    { projectId: "unknown", path: "cut.mp4" },
    { projectId: project.id, path: ".git/config" },
    { projectId: project.id, path: "out.txt" },
    { projectId: project.id, path: "agentpier-data/secret.txt" },
    { projectId: project.id, path: "../x" },
    { path: "../escape.txt" },
  ])
    await assert.rejects(f.share(input), { status: 403 }, JSON.stringify(input));
  fs.symlinkSync(path.join(f.dataDir, "outside.txt"), path.join(f.workspaces, f.id, "l"));
  await assert.rejects(f.share({ path: "l" }), { status: 403 });
});

test("the file reaches Telegram only when the chat's latest turn came from there", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  await f.eventTurn();
  assert.equal((await f.share()).telegram, undefined);
  assert.deepEqual(f.files(), []);
  await f.turn(f.telegram, { exec: false });
  assert.equal((await f.share()).telegram, "queued");
  assert.equal(f.files().length, 1);
  // A chat unpaired since gets nothing.
  f.service.store.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  assert.equal((await f.share()).telegram, undefined);
  assert.equal(f.files().length, 1);
});

test("other recipients keep their rules: a user agent shares only in a turn", async (t) => {
  const userAccess = {
    mode: "shared",
    members: [{ userId: "anna", level: "chat" }],
    released: [],
  };
  const f = await setup(t, { userAccess });
  await f.turn({ kind: "user", userId: "anna" });
  await f.eventTurn();
  await assert.rejects(f.share(), forbidden);
  await assert.rejects(f.share(undefined, null), forbidden);
  assert.deepEqual(f.sent(), []);
  // Any other session without a turn or routine shares nothing.
  const g = await setup(t);
  await assert.rejects(
    g.share(undefined, "x", `agent:${g.agentId}:cron:job-2`),
    forbidden,
  );
});

test("continuation refusals are logged with their time and reason", async (t) => {
  const f = await setup(t);
  const warnings = [];
  f.bridge.warn = (message) => warnings.push(message);
  await f.turn({ kind: "owner" });
  await f.emit(
    "before_tool_call",
    { toolName: "exec", params: {} },
    { agentId: f.agentId, sessionKey: "session", runId: "r9", toolCallId: "p1" },
  );
  assert.equal(await f.write(await f.eventTurn()), false);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] Exec completion continuation refused for [^ ]+ \(UNTRACKED: pending\)\.$/,
  );
});

test("a hook's run shares into the agent's main chat", async (t) => {
  const f = await setup(t);
  const conversation = f.store.getConversation(f.channel.conversationId);
  const invocation = {
    attemptId: null,
    hook: { conversation, event: { id: "event-1" } },
    assertCurrent() {},
  };
  const result = await f.assistants.shares.invoke(invocation, { path: "episode.mp4" });
  assert.equal(result.status, "shared");
  assert.equal(result.telegram, undefined);
  const row = f.assistants.attachments.db
    .prepare("SELECT request_id, conversation_id FROM agent_attachments")
    .get();
  assert.deepEqual(
    { ...row },
    {
      request_id: "share:hook:event-1",
      conversation_id: conversation.id,
    },
  );
});
