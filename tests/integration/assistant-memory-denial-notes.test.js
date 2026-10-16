import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import {
  MemoryFlushes,
  flushDates,
} from "../../server/features/assistants/memory-flushes.js";
import { MemoryNotes } from "../../server/features/assistants/memory-notes.js";

const [today] = flushDates(Date.now());

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
  assert.deepEqual(f.notes(), ["forwarded"], "one note for the turn");
  assert.equal(f.changes() - before, 1, "the chat is told once");
  // A refused write outside memory is not a memory note.
  f.assistants.ledger.transition(forwarded.attemptId, "completed");
  const lead = await f.invocation("lead", { kind: "lead-request", requestId: "r1" });
  assert.equal(await f.call("notes.md"), false);
  assert.deepEqual(f.notes(), ["forwarded"]);
  assert.equal(await f.call("MEMORY.md"), false);
  assert.deepEqual(f.notes(), ["forwarded", "lead-request"]);
  f.assistants.ledger.transition(lead.attemptId, "completed");
  // The owner's own turn writes and leaves no note.
  const owner = await f.invocation("owner", { kind: "owner" });
  assert.equal(await f.call("MEMORY.md"), true);
  assert.deepEqual(f.notes(), ["forwarded", "lead-request"]);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  // Scheduled and other automatic turns are named as such.
  const scheduled = await f.invocation("scheduled", { kind: "reminder" });
  assert.equal(await f.call("MEMORY.md"), false);
  assert.deepEqual(f.notes(), ["forwarded", "lead-request", "automatic"]);
  // A refused flush of the conversation's run is noted as such.
  f.assistants.memoryFlushes.observe({
    stream: "run_status",
    runId: scheduled.attemptId,
    sessionKey: "session",
    data: { phase: "memory_flushing" },
  });
  const flush = (run = crypto.randomUUID()) => ({
    agentId: f.agentId,
    sessionKey: `agent:${f.agentId}:internal-session-effects:${run}-21a903bbd7325dca`,
    runId: run,
  });
  const ctx = flush();
  assert.equal(await f.call(today, { ctx }), false);
  assert.equal(await f.call(today, { ctx }), false);
  assert.deepEqual(f.notes(), ["forwarded", "lead-request", "automatic", "flush"]);
});

test("a refused flush the Gateway never reported is still noted in the owner's chat", async (t) => {
  const f = await notesFixture(t);
  const warnings = [];
  f.bridge.warn = (line) => warnings.push(line);
  // A runtime that no longer sends run_status memory_flushing: nothing admits the
  // flush, but the agent's single owner turn shows that its note was not saved.
  const owner = await f.invocation("owner", { kind: "owner" });
  const run = crypto.randomUUID();
  const ctx = {
    agentId: f.agentId,
    sessionKey: `agent:${f.agentId}:internal-session-effects:${run}-21a903bbd7325dca`,
    runId: run,
  };
  assert.equal(await f.call(today, { ctx }), false);
  assert.deepEqual(f.notes(), ["flush"]);
  assert.equal(warnings.length, 1, "and the refusal is logged");
  assert.match(warnings[0], /FLUSH_UNREPORTED/);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  // Without exactly one owner turn there is no conversation to tell.
  const other = { ...ctx, sessionKey: ctx.sessionKey.replace(run, crypto.randomUUID()) };
  assert.equal(await f.call(today, { ctx: other }), false);
  assert.deepEqual(f.notes(), ["flush"]);
});

test("a refused flush of a reported routine or other session never lands in the owner's chat", async (t) => {
  const f = await notesFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: true } },
    agent.revision,
  );
  const routineKey = `agent:${f.agentId}:cron:job-1:run:r1`;
  f.assistants.routines = { runOrigin: (_a, key) => key === routineKey };
  // The owner's turn runs in its chat while other sessions of the agent flush.
  await f.invocation("owner", { kind: "owner" });
  const flushCtx = () => {
    const run = crypto.randomUUID();
    return {
      agentId: f.agentId,
      sessionKey: `agent:${f.agentId}:internal-session-effects:${run}-21a903bbd7325dca`,
      runId: run,
    };
  };
  for (const source of [routineKey, `agent:${f.agentId}:telegram:someone`]) {
    f.assistants.memoryFlushes.clear();
    f.assistants.memoryFlushes.observe({
      stream: "run_status",
      runId: "source-run",
      sessionKey: source,
      data: { phase: "memory_flushing" },
    });
    // Refused (an old day note), and not attributed to the owner's conversation.
    assert.equal(await f.call("memory/2020-01-01.md", { ctx: flushCtx() }), false);
    assert.deepEqual(f.notes(), [], source);
  }
});
