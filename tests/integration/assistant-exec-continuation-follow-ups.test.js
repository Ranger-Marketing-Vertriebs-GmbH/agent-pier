import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execContinuationFixture } from "../helpers/exec-continuation-fixture.js";
import { continuationSource } from "../../server/features/assistants/exec-continuation.js";
import { execEvidence } from "../../server/features/assistants/team-plugin/exec-processes.js";

// AGENTPIER-261: a lead's follow-ups on its members' results and the owner's own
// direct messages that arrive while a background command runs do not end its
// completion run's rights to write; anything else does. (Sharing a file with the
// owner needs no such proof: assistant-owner-shares.test.js.)
async function setup(t, options) {
  const f = await execContinuationFixture(t, options);
  const leadRequests = new Map();
  f.assistants.teams.store.find = (id) => leadRequests.get(id) || null;
  for (const id of ["r1", "r2", "r3"])
    leadRequests.set(id, { id, kind: "lead-request", parentAssistantId: f.id });
  const input = (runId = "wake-1") => ({
    agentId: f.agentId,
    sessionKey: "session",
    toolCallId: randomUUID(),
    action: "workspace",
    runId,
    exec: execEvidence("session", runId),
  });
  // A native write of the completion run.
  const write = () =>
    f.call("notes/render.md", {
      ctx: { agentId: f.agentId, sessionKey: "session", runId: "wake-1" },
    });
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
  const sources = () => f.writes().map(([, source]) => source);
  return { ...f, input, write, followUp, render, sources };
}

test("the owner's own messages after the render do not end its writes", async (t) => {
  // The owner decided: his newer direct message keeps the command's follow-up.
  for (const kind of ["owner", "telegram"]) {
    const f = await setup(t);
    const source = await f.render();
    await f.turn(
      {
        kind,
        channelId: f.channel.id,
        chatId: f.channel.chatId,
        userId: f.channel.userId,
      },
      { exec: false },
    );
    await f.followUp("r2");
    await f.wake();
    assert.equal(await f.write(), true, kind);
    // It keeps the render turn's rights, not the later message's.
    assert.deepEqual(f.sources(), [source], kind);
  }
});

test("forwarded content, reminders, hooks and lead tasks after the render end it", async (t) => {
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "reminder" },
    { kind: "hook" },
    { kind: "routine" },
    { kind: "lead-request", requestId: "r2" },
    { kind: "unknown" },
  ]) {
    const f = await setup(t);
    await f.render();
    await f.turn(origin, { exec: false });
    await f.wake();
    assert.equal(await f.write(), false, JSON.stringify(origin));
    assert.deepEqual(f.sources(), []);
  }
});

test("a restricted user's message after the render ends it", async (t) => {
  const userAccess = {
    mode: "shared",
    members: [{ userId: "anna", level: "chat" }],
    released: [],
  };
  for (const later of [{ kind: "user", userId: "anna" }, { kind: "owner" }]) {
    const f = await setup(t, { userAccess });
    await f.turn({ kind: "user", userId: "anna" });
    await f.turn(later, { exec: false });
    await f.wake();
    // On a user agent only the latest turn may continue, as before.
    assert.equal(await f.write(), false, JSON.stringify(later));
  }
});

test("a clock step back never hides newer forwarded content", async (t) => {
  const f = await setup(t);
  await f.render();
  const owner = await f.turn({ kind: "owner", forwarded: true }, { exec: false });
  await f.followUp("r2");
  // The clock stepped back before the forwarded message: by its time it looks older
  // than the render's turn, by its row it is newer.
  const past = new Date(Date.now() - 3600000).toISOString();
  const { requestId } = f.assistants.ledger.getAttempt(owner);
  f.assistants.ledger.db
    .prepare("UPDATE requests SET created_at=? WHERE id=?")
    .run(past, requestId);
  await f.wake();
  assert.equal(await f.write(), false);
  assert.deepEqual(f.sources(), []);
});

test("two proven follow-ups after the render still let it write", async (t) => {
  const f = await setup(t);
  const source = await f.render();
  await f.followUp("r2");
  await f.followUp("r3");
  await f.wake();
  assert.equal(await f.write(), true);
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
