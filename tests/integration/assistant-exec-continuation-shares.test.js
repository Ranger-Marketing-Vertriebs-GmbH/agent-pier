import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execContinuationFixture } from "../helpers/exec-continuation-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { execEvidence } from "../../server/features/assistants/team-plugin/exec-processes.js";

// AGENTPIER-237: the completion run of a background command hands the owner its
// result with agentpier_share_file, as the turn that started the command would.
async function setup(t) {
  const f = await execContinuationFixture(t);
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  // The lead requests a member's result follow-up may hand over (member-result-writes.js).
  const leadRequests = new Map();
  f.assistants.teams.store.find = (id) => leadRequests.get(id) || null;
  const file = (name, body = "MP4") => {
    const target = path.join(f.workspaces, f.id, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  // As the plugin prepares and invokes a share of a completion run.
  const share = async (input, runId = "wake-1") => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "share_file",
      runId,
      exec: execEvidence("session", runId),
    });
    return f.bridge.invoke({ ticket, action: "share_file", input });
  };
  // A turn with this client request id and origin that started a background exec.
  const started = async (key, origin) => {
    const { attemptId } = await f.invocation(key, origin);
    await f.exec(attemptId);
    f.assistants.ledger.transition(attemptId, "completed");
    return attemptId;
  };
  const sent = () => f.audits.filter((e) => e.action === "assistant.sent");
  return { ...f, leadRequests, file, share, started, sent };
}

test("a completion run of an owner turn shares into that turn's chat", async (t) => {
  const f = await setup(t);
  f.file("renders/episode.mp4");
  await f.turn({ kind: "owner" });
  await f.wake();
  const result = await f.share({ path: "renders/episode.mp4", caption: "Final cut" });
  assert.equal(result.status, "shared");
  assert.equal(result.file.name, "episode.mp4");
  assert.equal(result.telegram, undefined, "a web turn never reaches Telegram");
  assert.deepEqual(
    f.sent().map((e) => e.details),
    [{ kind: "share", channel: "tool" }],
  );
  // The same file checks as in the turn: never outside the workspace.
  await assert.rejects(f.share({ path: "../escape.txt" }), { status: 403 });
});

test("a completion run of a work-goal continuation shares like its owner turn", async (t) => {
  const f = await setup(t);
  f.file("episode.mp4");
  await f.turn({
    kind: "owner",
    goal: { id: "goal-1", anchorRequestId: "anchor", title: "Finish the episode" },
  });
  await f.eventTurn();
  assert.equal((await f.share({ path: "episode.mp4" }, "turn-1")).status, "shared");
});

test("a completion run of an owner's Telegram turn also queues the file there", async (t) => {
  const f = await setup(t);
  f.file("episode.mp4");
  await f.turn({
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  await f.eventTurn();
  const result = await f.share({ path: "episode.mp4" }, "turn-1");
  assert.equal(result.telegram, "queued");
  const queued = f.service.outbox.all(f.channel.id).filter((e) => e.kind === "file");
  assert.equal(queued.length, 1);
});

test("a completion run of a lead's follow-up on its member's result shares too", async (t) => {
  // The owner's case: the lead started the render in its follow-up turn.
  const f = await setup(t);
  f.file("episode.mp4");
  f.leadRequests.set("r1", { id: "r1", kind: "lead-request", parentAssistantId: f.id });
  await f.started("lead-request-result:r1", { kind: "member-result", requestId: "r1" });
  await f.wake();
  assert.equal((await f.share({ path: "episode.mp4" })).status, "shared");
  // It writes like that turn as well.
  assert.equal(await f.call("notes/render.md", { ctx: await f.wake("wake-1") }), true);
});

test("project folders share in a completion run on the turn's own grant", async (t) => {
  const f = await setup(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-share-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "cut.mp4"), "MP4");
  const project = await f.memory.register(folder);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [project.id], projectFiles: { [project.id]: "read" } },
    f.workflows.access.get(f.id).revision,
  );
  f.leadRequests.set("r1", { id: "r1", kind: "lead-request", parentAssistantId: f.id });
  await f.started("lead-request-result:r1", { kind: "member-result", requestId: "r1" });
  await f.wake();
  const result = await f.share({ projectId: project.id, path: "cut.mp4" });
  assert.equal(result.status, "shared");
  await assert.rejects(f.share({ projectId: "unknown", path: "cut.mp4" }), {
    status: 403,
  });
});

test("completion runs of other turns never share", async (t) => {
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "lead-request", requestId: "r1" },
    { kind: "hook" },
    { kind: "unknown" },
  ]) {
    const f = await setup(t);
    f.file("episode.mp4");
    await f.turn(origin);
    await f.wake();
    await assert.rejects(
      f.share({ path: "episode.mp4" }),
      { status: 403 },
      JSON.stringify(origin),
    );
    assert.deepEqual(f.sent(), []);
  }
  // A follow-up that only claims a member's result, without AgentPier's request.
  const g = await setup(t);
  g.file("episode.mp4");
  g.leadRequests.set("r1", { id: "r1", kind: "lead-request", parentAssistantId: g.id });
  await g.turn({ kind: "member-result", requestId: "r1" });
  await g.wake();
  await assert.rejects(g.share({ path: "episode.mp4" }), { status: 403 });
  // A run that is no completion of the turn's own command, or a newer request.
  const h = await setup(t);
  h.file("episode.mp4");
  await h.turn({ kind: "owner" });
  await h.wake();
  await assert.rejects(h.share({ path: "episode.mp4" }, "made-up"), { status: 403 });
  await h.turn({ kind: "owner" }, { exec: false });
  await assert.rejects(h.share({ path: "episode.mp4" }), { status: 403 });
  assert.deepEqual([...g.sent(), ...h.sent()], []);
});
