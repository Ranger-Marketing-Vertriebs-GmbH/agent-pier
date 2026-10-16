import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { MemoryFlushes } from "../../server/features/assistants/memory-flushes.js";
import { MemoryNotes } from "../../server/features/assistants/memory-notes.js";

async function notesFixture(t) {
  const f = await workflowFixture(t);
  f.assistants.memoryNotes = new MemoryNotes(f.store.db);
  f.assistants.memoryFlushes = new MemoryFlushes();
  let changes = 0;
  f.assistants.changed = () => changes++;
  const guard = await nativeWriteGuard(t, f);
  // The plugin's guard report announces a change of its own first.
  for (let n = 0; n < 100 && !changes; n++) await new Promise((r) => setTimeout(r, 10));
  const notes = () =>
    f.assistants.memoryNotes
      .forConversation(f.channel.conversationId)
      .map((n) => n.reason);
  return { ...f, ...guard, notes, changes: () => changes };
}

test("a refused memory write leaves one quiet chat note per turn and reason", async (t) => {
  const f = await notesFixture(t);
  const forwarded = await f.invocation("forwarded", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    forwarded: true,
  });
  const before = f.changes();
  assert.equal(await f.call("MEMORY.md"), false);
  assert.equal(await f.call("memory/notes.md", { toolName: "edit" }), false);
  assert.deepEqual(f.notes(), ["not-owner"], "one note for the turn");
  assert.equal(f.changes() - before, 1, "the chat is told once");
  // A refused write outside memory is not a memory note.
  f.assistants.ledger.transition(forwarded.attemptId, "completed");
  const lead = await f.invocation("lead", { kind: "lead-request", requestId: "r1" });
  assert.equal(await f.call("notes.md"), false);
  assert.deepEqual(f.notes(), ["not-owner"]);
  assert.equal(await f.call("MEMORY.md"), false);
  assert.deepEqual(f.notes(), ["not-owner", "lead-request"]);
  f.assistants.ledger.transition(lead.attemptId, "completed");
  // The owner's own turn writes and leaves no note.
  const owner = await f.invocation("owner", { kind: "owner" });
  assert.equal(await f.call("MEMORY.md"), true);
  assert.deepEqual(f.notes(), ["not-owner", "lead-request"]);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  // A refused flush of the conversation's run is noted as such.
  const scheduled = await f.invocation("scheduled", { kind: "reminder" });
  f.assistants.memoryFlushes.observe({
    stream: "run_status",
    runId: scheduled.attemptId,
    sessionKey: "session",
    data: { phase: "memory_flushing" },
  });
  const flushCtx = {
    agentId: f.agentId,
    sessionKey: `agent:${f.agentId}:internal-session-effects:${crypto.randomUUID()}-ab`,
  };
  assert.equal(await f.call("memory/2026-10-16.md", { ctx: flushCtx }), false);
  assert.equal(await f.call("memory/2026-10-16.md", { ctx: flushCtx }), false);
  assert.deepEqual(f.notes(), ["not-owner", "lead-request", "flush"]);
});
