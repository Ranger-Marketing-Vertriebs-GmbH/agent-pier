import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { MemoryFlushes } from "../../server/features/assistants/memory-flushes.js";

const telegram = (f, forwarded) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: f.channel.chatId,
  userId: f.channel.userId,
  forwarded,
});
// OpenClaw 2026.10.3 runs the pre-compaction flush in a detached internal session
// (resolveInternalSessionEffectsIdentity) and reports the source run's phase.
const flushKey = (agentId, run = "95e977b6-0ee8-4bc0-a310-5a2cf14f5c17") =>
  `agent:${agentId}:internal-session-effects:${run}-21a903bbd7325dca`;
const phase = (runId, value, sessionKey = "session") => ({
  stream: "run_status",
  runId,
  sessionKey,
  data: { phase: value },
});

async function flushFixture(t) {
  const f = await workflowFixture(t);
  let now = 1000;
  f.assistants.memoryFlushes = new MemoryFlushes({ now: () => now });
  const guard = await nativeWriteGuard(t, f);
  const flush = (target, { toolName = "write", agentId = guard.agentId } = {}) =>
    guard.call(target, { toolName, ctx: { agentId, sessionKey: flushKey(agentId) } });
  return { ...f, ...guard, flush, advance: (ms) => (now += ms) };
}

test("the memory flush of an owner turn may append to the daily note only", async (t) => {
  const f = await flushFixture(t);
  const turn = await f.invocation("owner-flush", { kind: "owner" });
  const daily = "memory/2026-10-16.md";
  assert.equal(await f.flush(daily), false, "no flush reported for the session");
  f.assistants.memoryFlushes.observe(phase(turn.attemptId, "memory_flushing"));
  assert.equal(await f.flush(daily), true, "the owner turn's flush writes");
  assert.equal(await f.flush(`${f.root}/${f.id}/${daily}`), true, "absolute spelling");
  for (const target of [
    "MEMORY.md",
    "notes.md",
    "memory/notes.md",
    "memory/2026-10-16-1200.md",
    "memory/sub/2026-10-16.md",
    "AGENTS.md",
  ])
    assert.equal(await f.flush(target), false, `${target} is not the flush target`);
  for (const toolName of ["edit", "apply_patch"])
    assert.equal(await f.flush(daily, { toolName }), false, `${toolName} never flushes`);
  assert.equal(
    await f.flush(daily, { agentId: "ap-foreign" }),
    false,
    "another agent's flush session",
  );
  // The flush session is not the owner's session: ordinary writes stay denied there.
  assert.equal(
    await f.call("MEMORY.md", {
      ctx: { agentId: f.agentId, sessionKey: `agent:${f.agentId}:cron:job:run:r1` },
    }),
    false,
  );
  f.assistants.memoryFlushes.observe(phase(turn.attemptId, "preparing_context"));
  assert.equal(await f.flush(daily), false, "the flush ended");
  // A flush report is trusted only for a bounded time.
  f.assistants.memoryFlushes.observe(phase(turn.attemptId, "memory_flushing"));
  f.advance(11 * 60000);
  assert.equal(await f.flush(daily), false, "a stale flush report");
});

test("a flush is admitted only for the source session's current owner run", async (t) => {
  const f = await flushFixture(t);
  const daily = "memory/2026-10-16.md";
  const owner = await f.invocation("owner-run", { kind: "owner" });
  f.assistants.memoryFlushes.observe(phase("another-run", "memory_flushing"));
  assert.equal(await f.flush(daily), false, "a different run of the session");
  f.assistants.memoryFlushes.observe(phase(owner.attemptId, "memory_flushing", "other"));
  assert.equal(await f.flush(daily), false, "another session with no owner turn");
  f.assistants.ledger.transition(owner.attemptId, "completed");
  f.assistants.memoryFlushes.clear();

  for (const [name, origin] of [
    ["forwarded", telegram(f, true)],
    ["lead-request", { kind: "lead-request", requestId: "r1" }],
    ["reminder", { kind: "reminder" }],
    ["team-member", { kind: "team-member" }],
  ]) {
    const turn = await f.invocation(`${name}-flush`, origin);
    f.assistants.memoryFlushes.observe(phase(turn.attemptId, "memory_flushing"));
    assert.equal(await f.flush(daily), false, `${name} turns never flush memory`);
    f.assistants.ledger.transition(turn.attemptId, "completed");
    f.assistants.memoryFlushes.clear();
  }

  const direct = await f.invocation("telegram-flush", telegram(f, false));
  f.assistants.memoryFlushes.observe(phase(direct.attemptId, "memory_flushing"));
  assert.equal(await f.flush(daily), true, "the paired Telegram chat's own turn");
  f.assistants.ledger.transition(direct.attemptId, "completed");
  assert.equal(await f.flush(daily), false, "no active turn, no routine: no flush");
});
