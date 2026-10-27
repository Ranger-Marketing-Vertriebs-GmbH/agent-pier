import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execContinuationFixture } from "../helpers/exec-continuation-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { continuationSource } from "../../server/features/assistants/exec-continuation.js";
import { execEvidence } from "../../server/features/assistants/team-plugin/exec-processes.js";

// AGENTPIER-261: a lead's follow-ups on its members' results that arrive while a
// background command runs do not end its completion run's rights; anything else does.
async function setup(t) {
  const f = await execContinuationFixture(t);
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const leadRequests = new Map();
  f.assistants.teams.store.find = (id) => leadRequests.get(id) || null;
  for (const id of ["r1", "r2", "r3"])
    leadRequests.set(id, { id, kind: "lead-request", parentAssistantId: f.id });
  const target = path.join(f.workspaces, f.id, "episode.mp4");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "MP4");
  const input = (runId = "wake-1") => ({
    agentId: f.agentId,
    sessionKey: "session",
    toolCallId: randomUUID(),
    action: "share_file",
    runId,
    exec: execEvidence("session", runId),
  });
  const share = async () => {
    const { ticket } = await f.bridge.prepare(input());
    return f.bridge.invoke({
      ticket,
      action: "share_file",
      input: { path: "episode.mp4" },
    });
  };
  // AgentPier's follow-up on lead request `id`, ended in `state` (or left running).
  const followUp = async (id, state = "completed") => {
    const { attemptId } = await f.invocation(`lead-request-result:${id}`, {
      kind: "member-result",
      requestId: id,
    });
    if (state !== "running") f.assistants.ledger.transition(attemptId, state);
    return attemptId;
  };
  // The lead's render, started in its follow-up on r1.
  const render = async () => {
    const { attemptId } = await f.invocation("lead-request-result:r1", {
      kind: "member-result",
      requestId: "r1",
    });
    await f.exec(attemptId);
    f.assistants.ledger.transition(attemptId, "completed");
    return attemptId;
  };
  const sources = () =>
    f.audits
      .filter((e) => e.action === "assistant.sent")
      .map((e) => e.details.sourceAttemptId);
  return { ...f, input, share, followUp, render, sources };
}

test("an owner message between the render and a later follow-up ends the share", async (t) => {
  const f = await setup(t);
  await f.render();
  await f.turn({ kind: "owner" }, { exec: false });
  await f.followUp("r2");
  await f.wake();
  await assert.rejects(f.share(), { status: 403 });
  assert.deepEqual(f.sources(), []);
});

test("a clock step back never hides a newer owner message", async (t) => {
  const f = await setup(t);
  await f.render();
  const owner = await f.turn({ kind: "owner" }, { exec: false });
  await f.followUp("r2");
  // The clock stepped back before the owner's message: by its time it looks older
  // than the render's turn, by its row it is newer.
  const past = new Date(Date.now() - 3600000).toISOString();
  const { requestId } = f.assistants.ledger.getAttempt(owner);
  f.assistants.ledger.db
    .prepare("UPDATE requests SET created_at=? WHERE id=?")
    .run(past, requestId);
  await f.wake();
  await assert.rejects(f.share(), { status: 403 });
  assert.deepEqual(f.sources(), []);
});

test("two proven follow-ups after the render still let it share", async (t) => {
  const f = await setup(t);
  const source = await f.render();
  await f.followUp("r2");
  await f.followUp("r3");
  await f.wake();
  assert.equal((await f.share()).status, "shared");
  assert.deepEqual(f.sources(), [source]);
});

test("a later follow-up that still runs is no continuation", async (t) => {
  const f = await setup(t);
  await f.render();
  await f.followUp("r2", "running");
  await f.wake();
  // The session is bound to the running follow-up: the completion continues nothing.
  assert.equal(continuationSource(f.bridge, f.input()), null);
});

test("a Telegram turn's render reaches Telegram after a later follow-up", async (t) => {
  const f = await setup(t);
  const source = await f.turn({
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  await f.followUp("r2");
  await f.wake();
  const result = await f.share();
  assert.equal(result.telegram, "queued");
  assert.deepEqual(f.sources(), [source]);
  const queued = f.service.outbox.all(f.channel.id).filter((e) => e.kind === "file");
  assert.equal(queued.length, 1);
});
