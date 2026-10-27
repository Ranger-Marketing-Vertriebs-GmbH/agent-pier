import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execContinuationFixture } from "../helpers/exec-continuation-fixture.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// A turn whose sessions.send acknowledgement timed out (a Gateway just restarted)
// still runs. A project or share call of that very run proves it, as a frame of
// the run would (run-confirmation.js), so its tools work instead of FORBIDDEN.
async function setup(t) {
  const f = await execContinuationFixture(t);
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const target = path.join(f.workspaces, f.id, "renders/episode.mp4");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "MP4");
  // As the plugin prepares and invokes a share, naming the run of its tool call.
  const share = async (runId) => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "share_file",
      runId,
    });
    return f.bridge.invoke({
      ticket,
      action: "share_file",
      input: { path: "renders/episode.mp4" },
    });
  };
  // conversation-turns.js after a sessions.send timeout.
  const unacknowledged = async (generation = null) => {
    const { attemptId } = await f.invocation(randomUUID(), { kind: "owner" });
    f.assistants.ledger.transition(attemptId, "uncertain", {
      unconfirmed: "send",
      generation,
      code: "TIMEOUT",
    });
    return attemptId;
  };
  return { ...f, share, unacknowledged };
}
const forbidden = (error) => toolError(error).code === "FORBIDDEN";
// An unproven unacknowledged send: retryable after a short wait, not FORBIDDEN.
const unconfirmed = (error) => toolError(error).code === "TURN_UNCONFIRMED";

test("a call of the unacknowledged turn's own run confirms the turn", async (t) => {
  const f = await setup(t);
  const attemptId = await f.unacknowledged();
  // Another run of the session proves nothing.
  await assert.rejects(f.share("other-run"), unconfirmed);
  assert.equal(f.assistants.ledger.getAttempt(attemptId).state, "uncertain");
  assert.equal((await f.share(attemptId)).status, "shared");
  const attempt = f.assistants.ledger.getAttempt(attemptId);
  assert.equal(attempt.state, "running");
  assert.equal(attempt.unconfirmed, undefined);
});

test("a call never confirms a send to an earlier Gateway or a reviewed turn", async (t) => {
  const f = await setup(t);
  const earlier = await f.unacknowledged("earlier-generation");
  await assert.rejects(f.share(earlier), unconfirmed);
  assert.equal(f.assistants.ledger.getAttempt(earlier).state, "uncertain");
  f.assistants.ledger.transition(earlier, "failed");
  const reviewed = await f.unacknowledged();
  f.assistants.ledger.review(reviewed);
  await assert.rejects(f.share(reviewed), forbidden);
  assert.equal(f.assistants.ledger.getAttempt(reviewed).state, "uncertain");
});

// A call that started while its turn was live re-checks the turn on every step (a
// coding session wait polls once a second for up to 100 s). A slow Gateway whose
// sessions.send acknowledgement times out meanwhile leaves the turn unconfirmed, not
// over: the running call stays current, while a new call still needs proof.
async function runningCall(t) {
  const f = await setup(t);
  const { attemptId } = await f.invocation(randomUUID(), { kind: "owner" });
  const bind = async () =>
    (
      await f.bridge.prepare({
        agentId: f.agentId,
        sessionKey: "session",
        toolCallId: randomUUID(),
        action: "share_file",
      })
    ).ticket;
  const invoke = (ticket) =>
    f.bridge.invoke({
      ticket,
      action: "share_file",
      input: { path: "renders/episode.mp4" },
    });
  const ticket = await bind();
  await invoke(ticket);
  // The call's per-step check (TeamBridge.invoke assertCurrent).
  const { assertCurrent } = f.bridge.tickets.get(ticket).invocation;
  return { ...f, attemptId, bind, invoke, assertCurrent };
}

test("a running call outlives a send acknowledgement that timed out", async (t) => {
  const f = await runningCall(t);
  // Prepared while the turn was live, but not started yet.
  const prepared = await f.bind();
  f.assistants.ledger.transition(f.attemptId, "uncertain", {
    unconfirmed: "send",
    generation: null,
    code: "TIMEOUT",
  });
  f.assertCurrent();
  // Nothing proved the run: the turn stays unconfirmed, and no call starts on it.
  assert.equal(f.assistants.ledger.getAttempt(f.attemptId).state, "uncertain");
  await assert.rejects(f.bind(), unconfirmed);
  await assert.rejects(async () => f.invoke(prepared), unconfirmed);
  // A reviewed turn is over for the running call too.
  f.assistants.ledger.review(f.attemptId);
  assert.throws(f.assertCurrent, forbidden);
});

test("a plain uncertain turn ends a running call", async (t) => {
  // A lost Gateway connection (markOutstandingUnknown) leaves no unconfirmed send.
  const lost = await runningCall(t);
  lost.assistants.ledger.transition(lost.attemptId, "uncertain");
  assert.throws(lost.assertCurrent, forbidden);
  // An AgentPier restart forgets an unconfirmed send (RequestLedger.forgetUnconfirmed).
  const restarted = await runningCall(t);
  restarted.assistants.ledger.transition(restarted.attemptId, "uncertain", {
    unconfirmed: "send",
    generation: null,
    code: "TIMEOUT",
  });
  restarted.assistants.ledger.forgetUnconfirmed();
  assert.throws(restarted.assertCurrent, forbidden);
});
