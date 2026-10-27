import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// A turn whose sessions.send acknowledgement timed out while the Gateway already ran
// it (2026-10-27: a member's task with a lead's write share). Its first project call
// was prepared while the send was still under way, waited for the admission lock the
// send held, and met the turn unconfirmed once the send timed out; every later call
// was refused as FORBIDDEN and the member gave up.
async function setup(t) {
  const f = await leadShareFixture(t);
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: f.assistants.teams,
    generation: () => 1,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const agentOf = (assistantId) => f.store.getAssistant(assistantId).runtimeAgentId;
  const sessionOf = (chatId) => f.store.getConversation(chatId).runtimeSessionKey;
  // conversation-turns.js after a sessions.send timeout.
  const timedOut = (attemptId) =>
    f.assistants.ledger.transition(attemptId, "uncertain", {
      unconfirmed: "send",
      generation: null,
      code: "TIMEOUT",
    });
  // The send's admission lock: the call runs once the send gave up waiting.
  const sendTimesOutFirst = (attemptId) => {
    const admit = f.assistants.admit;
    f.assistants.admit = async (fn) => {
      f.assistants.admit = admit;
      timedOut(attemptId);
      return fn();
    };
  };
  // As the plugin prepares and invokes a call, naming its tool call's run.
  const prepare = async (who, action, runId) =>
    bridge.prepare({
      agentId: agentOf(who.assistantId),
      sessionKey: sessionOf(who.chatId),
      toolCallId: randomUUID(),
      action,
      ...(runId ? { runId } : {}),
    });
  const filesList = async (who, runId) => {
    const { ticket } = await prepare(who, "workspace", runId);
    return bridge.invoke({
      ticket,
      action: "workspace",
      input: { action: "files_list", projectId: f.folderProject.id },
    });
  };
  const owner = { assistantId: f.lead, chatId: f.channel.conversationId };
  const member = { assistantId: f.member.assistantId, chatId: f.memberChat.id };
  return { ...f, bridge, timedOut, sendTimesOutFirst, prepare, filesList, owner, member };
}
const code = (key) => (error) => toolError(error).code === key;

test("a member's call that waited out the send's timeout proves its own run", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  const { inv } = await f.task();
  f.sendTimesOutFirst(inv.attemptId);
  const listed = await f.filesList(f.member, inv.attemptId);
  assert.equal(listed.access, "write");
  const attempt = f.assistants.ledger.getAttempt(inv.attemptId);
  assert.equal(attempt.state, "running");
  assert.equal(attempt.unconfirmed, undefined);
  // The member's report to its lead now gets its ticket.
  assert.ok((await f.prepare(f.member, "report", inv.attemptId)).ticket);
});

test("an owner's call that waited out the send's timeout proves its own run", async (t) => {
  const f = await setup(t);
  const turn = await f.turn(f.channel.conversationId);
  f.sendTimesOutFirst(turn.attemptId);
  assert.equal((await f.filesList(f.owner, turn.attemptId)).access, "write");
  assert.equal(f.assistants.ledger.getAttempt(turn.attemptId).state, "running");
});

test("an unproven unconfirmed turn is told to wait, not refused for good", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  const { inv } = await f.task();
  // Prepared while live, started after the send timed out, without its run.
  f.sendTimesOutFirst(inv.attemptId);
  await assert.rejects(f.filesList(f.member), code("TURN_UNCONFIRMED"));
  await assert.rejects(f.prepare(f.member, "report"), code("TURN_UNCONFIRMED"));
  // Another turn's run proves nothing for this one, nor confirms that turn.
  const other = await f.turn(f.channel.conversationId);
  f.timedOut(other.attemptId);
  await assert.rejects(
    f.prepare(f.member, "report", other.attemptId),
    code("TURN_UNCONFIRMED"),
  );
  assert.equal(f.assistants.ledger.getAttempt(other.attemptId).state, "uncertain");
  assert.equal(f.assistants.ledger.getAttempt(inv.attemptId).state, "uncertain");
  // A reviewed turn is over: no proof revives it, and the refusal is final.
  f.assistants.ledger.review(inv.attemptId);
  await assert.rejects(f.prepare(f.member, "report"), code("FORBIDDEN"));
  await assert.rejects(f.prepare(f.member, "report", inv.attemptId), code("FORBIDDEN"));
  assert.equal(f.assistants.ledger.getAttempt(inv.attemptId).state, "uncertain");
});

test("a turn that failed or ended stays refused as FORBIDDEN", async (t) => {
  const f = await setup(t);
  const turn = await f.turn(f.channel.conversationId);
  f.assistants.ledger.transition(turn.attemptId, "failed");
  await assert.rejects(f.filesList(f.owner, turn.attemptId), code("FORBIDDEN"));
  // A plain uncertain turn (a lost connection) has no unconfirmed send.
  const lost = await f.turn(f.channel.conversationId);
  f.assistants.ledger.transition(lost.attemptId, "uncertain");
  await assert.rejects(f.filesList(f.owner, lost.attemptId), code("FORBIDDEN"));
});
