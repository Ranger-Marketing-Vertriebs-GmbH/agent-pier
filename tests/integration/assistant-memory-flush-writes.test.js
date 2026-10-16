import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import {
  MemoryFlushes,
  flushDates,
} from "../../server/features/assistants/memory-flushes.js";

const telegram = (f, forwarded) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: f.channel.chatId,
  userId: f.channel.userId,
  forwarded,
});
// OpenClaw 2026.10.3 runs the pre-compaction flush in a detached internal session
// `<prefix><runId>-<sha16>` (resolveInternalSessionEffectsIdentity), reports that
// run id to the hook and the source run's phase on the source session.
const runA = "95e977b6-0ee8-4bc0-a310-5a2cf14f5c17",
  runB = "5f08b3e6-5b4a-47e1-ba9d-02ad108f78c4";
const flushKey = (agentId, run = runA) =>
  `agent:${agentId}:internal-session-effects:${run}-21a903bbd7325dca`;
const phase = (runId, value, sessionKey = "session") => ({
  stream: "run_status",
  runId,
  sessionKey,
  data: { phase: value },
});
const [today, yesterday] = flushDates(Date.now());

async function flushFixture(t) {
  const f = await workflowFixture(t);
  let now = Date.now();
  f.assistants.memoryFlushes = new MemoryFlushes({ now: () => now });
  const guard = await nativeWriteGuard(t, f);
  const warnings = [];
  guard.bridge.warn = (line) => warnings.push(line);
  const flush = (
    target,
    { toolName = "write", agentId = guard.agentId, run = runA, runId = run } = {},
  ) =>
    guard.call(target, {
      toolName,
      ctx: { agentId, sessionKey: flushKey(agentId, run), runId },
    });
  const report = (runId, value = "memory_flushing", key) =>
    f.assistants.memoryFlushes.observe(phase(runId, value, key));
  return { ...f, ...guard, flush, report, warnings, advance: (ms) => (now += ms) };
}

test("the memory flush of an owner turn may append to the daily note only", async (t) => {
  const f = await flushFixture(t);
  const turn = await f.invocation("owner-flush", { kind: "owner" });
  assert.equal(await f.flush(today), false, "no flush reported for the session");
  f.report(turn.attemptId);
  assert.equal(await f.flush(today), true, "the owner turn's flush writes");
  assert.equal(await f.flush(`${f.root}/${f.id}/${today}`), true, "absolute spelling");
  for (const target of [
    "MEMORY.md",
    "notes.md",
    "memory/notes.md",
    today.replace(".md", "-1200.md"),
    today.replace("memory/", "memory/sub/"),
    "memory/2026-01-01.md",
    "AGENTS.md",
  ])
    assert.equal(await f.flush(target), false, `${target} is not the flush target`);
  for (const toolName of ["edit", "apply_patch"])
    assert.equal(await f.flush(today, { toolName }), false, `${toolName} never flushes`);
  assert.equal(
    await f.flush(today, { agentId: "ap-foreign" }),
    false,
    "another agent's flush session",
  );
  // The key must name the run the hook reports.
  assert.equal(await f.flush(today, { runId: runB }), false, "another run id");
  assert.equal(await f.flush(today, { runId: null }), false, "no run id");
  // The flush belongs to the first internal session that wrote for it.
  assert.equal(await f.flush(today, { run: runB }), false, "a second flush session");
  assert.ok(f.warnings.length > 0, "refused flush writes are logged");
  // The flush session is not the owner's session: ordinary writes stay denied there.
  assert.equal(
    await f.call("MEMORY.md", {
      ctx: { agentId: f.agentId, sessionKey: `agent:${f.agentId}:cron:job:run:r1` },
    }),
    false,
  );
  f.report(turn.attemptId, "preparing_context");
  assert.equal(await f.flush(today), false, "the flush ended");
  // A flush report is trusted only for a bounded time.
  f.report(turn.attemptId);
  f.advance(11 * 60000);
  assert.equal(await f.flush(today), false, "a stale flush report");
});

test("just after midnight a flush may still write yesterday's note", async (t) => {
  const f = await flushFixture(t);
  const turn = await f.invocation("owner-late", { kind: "owner" });
  f.report(turn.attemptId);
  assert.equal(await f.flush(yesterday), true);
  const [older] = flushDates(Date.now() - 2 * 86400000);
  assert.equal(await f.flush(older), false, "an older day note");
});

test("a flush is admitted only for the source session's current owner run", async (t) => {
  const f = await flushFixture(t);
  const owner = await f.invocation("owner-run", { kind: "owner" });
  f.report("another-run");
  assert.equal(await f.flush(today), false, "a different run of the session");
  f.assistants.ledger.transition(owner.attemptId, "completed");
  f.assistants.memoryFlushes.clear();

  for (const [name, origin] of [
    ["forwarded", telegram(f, true)],
    ["lead-request", { kind: "lead-request", requestId: "r1" }],
    ["reminder", { kind: "reminder" }],
    ["team-member", { kind: "team-member" }],
  ]) {
    const turn = await f.invocation(`${name}-flush`, origin);
    f.report(turn.attemptId);
    assert.equal(await f.flush(today), false, `${name} turns never flush memory`);
    f.assistants.ledger.transition(turn.attemptId, "completed");
    f.assistants.memoryFlushes.clear();
  }

  const direct = await f.invocation("telegram-flush", telegram(f, false));
  f.report(direct.attemptId);
  assert.equal(await f.flush(today), true, "the paired Telegram chat's own turn");
  f.assistants.ledger.transition(direct.attemptId, "completed");
  assert.equal(await f.flush(today), false, "no active turn, no routine: no flush");
});

test("a flush reported for a session without an owner turn is refused", async (t) => {
  const f = await flushFixture(t);
  // The agent's owner turn runs in its chat; the flush is reported elsewhere.
  const owner = await f.invocation("owner-elsewhere", { kind: "owner" });
  f.report(owner.attemptId, "memory_flushing", "other");
  assert.equal(await f.flush(today), false);
  f.report(owner.attemptId, "memory_flushing", `agent:${f.agentId}:telegram:direct`);
  assert.equal(await f.flush(today), false, "an own session without a turn");
});

test("a routine run's flush writes like the routine itself", async (t) => {
  const f = await flushFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: true } },
    agent.revision,
  );
  const routineKey = `agent:${f.agentId}:cron:job-1:run:r1`;
  f.assistants.routines = { runOrigin: (_a, key) => key === routineKey };
  f.report("routine-run", "memory_flushing", routineKey);
  assert.equal(await f.flush(today), true);
  f.assistants.memoryFlushes.clear();
  f.report("other-run", "memory_flushing", `agent:${f.agentId}:cron:job-2:run:r1`);
  assert.equal(await f.flush(today, { run: runB }), false, "not a routine's run");
});
