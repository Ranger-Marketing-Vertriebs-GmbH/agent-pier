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

test("a call of the unacknowledged turn's own run confirms the turn", async (t) => {
  const f = await setup(t);
  const attemptId = await f.unacknowledged();
  // Another run of the session proves nothing.
  await assert.rejects(f.share("other-run"), forbidden);
  assert.equal(f.assistants.ledger.getAttempt(attemptId).state, "uncertain");
  assert.equal((await f.share(attemptId)).status, "shared");
  const attempt = f.assistants.ledger.getAttempt(attemptId);
  assert.equal(attempt.state, "running");
  assert.equal(attempt.unconfirmed, undefined);
});

test("a call never confirms a send to an earlier Gateway or a reviewed turn", async (t) => {
  const f = await setup(t);
  const earlier = await f.unacknowledged("earlier-generation");
  await assert.rejects(f.share(earlier), forbidden);
  assert.equal(f.assistants.ledger.getAttempt(earlier).state, "uncertain");
  f.assistants.ledger.transition(earlier, "failed");
  const reviewed = await f.unacknowledged();
  f.assistants.ledger.review(reviewed);
  await assert.rejects(f.share(reviewed), forbidden);
  assert.equal(f.assistants.ledger.getAttempt(reviewed).state, "uncertain");
});
