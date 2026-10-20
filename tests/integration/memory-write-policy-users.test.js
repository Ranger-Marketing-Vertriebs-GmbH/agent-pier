import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import {
  MemoryFlushes,
  flushDates,
} from "../../server/features/assistants/memory-flushes.js";
import { MemoryNotes } from "../../server/features/assistants/memory-notes.js";
import { directOrigin } from "../../server/features/assistants/memory-write-policy.js";

const [today] = flushDates(Date.now());
const shared = {
  mode: "shared",
  members: [
    { userId: "anna", level: "chat" },
    { userId: "ben", level: "chat" },
  ],
  released: [],
};

// The fixture's agent as a user agent with memory, the plugin's write guard live, and
// a second chat (Ben's) on the same agent beside the fixture's own (Anna's).
async function usersFixture(t, userAccess) {
  const f = await workflowFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    userAccess,
    capabilities: { memory: true, reminders: false },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  f.assistants.memoryNotes = new MemoryNotes(f.store.db);
  f.assistants.memoryFlushes = new MemoryFlushes();
  f.assistants.changed = () => {};
  const origins = new Map();
  const context = f.assistants.teams.store.context;
  f.assistants.teams.store.context = (id) => origins.get(id) || context(id);
  const guard = await nativeWriteGuard(t, f);
  const other = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "session-ben",
  });
  // A turn in Ben's chat with the given origin.
  const benTurn = async (key, origin) => {
    const sent = await f.assistants.send(other.id, { clientRequestId: key, text: "Hi" });
    origins.set(sent.request.id, origin);
    return sent.attempt;
  };
  const notes = (conversationId) =>
    f.assistants.memoryNotes.forConversation(conversationId).map((n) => n.reason);
  return { ...f, ...guard, other, benTurn, notes };
}

test("directOrigin admits the owner, his Telegram chat and a user's own turn", () => {
  for (const kind of ["owner", "telegram", "user"]) {
    assert.equal(directOrigin({ kind }), true, kind);
    assert.equal(directOrigin({ kind, forwarded: true }), false, kind);
  }
  for (const kind of ["reminder", "lead-request", "team-member", undefined])
    assert.equal(directOrigin({ kind }), false, String(kind));
});

test("a user's own turn may write memory", async (t) => {
  const own = { ...shared, mode: "own", members: [shared.members[0]] };
  const f = await usersFixture(t, own);
  await f.invocation("anna", { kind: "user", userId: "anna" });
  assert.equal(await f.call("MEMORY.md"), true);
  assert.equal(await f.call("memory/notes.md", { toolName: "edit" }), true);
  // An own agent's write leaves no note: it is hers alone.
  assert.deepEqual(f.notes(f.channel.conversationId), []);
});

test("a forwarded user origin may not", async (t) => {
  const f = await usersFixture(t, shared);
  await f.invocation("fwd", { kind: "user", userId: "anna", forwarded: true });
  assert.equal(await f.call("MEMORY.md"), false);
  assert.deepEqual(f.notes(f.channel.conversationId), ["forwarded"]);
});

// A pre-compaction flush in Anna's turn (or another origin's), with its session context.
async function flushTurn(f, origin = { kind: "user", userId: "anna" }) {
  const turn = await f.invocation("anna", origin);
  f.assistants.memoryFlushes.observe({
    stream: "run_status",
    runId: turn.attemptId,
    sessionKey: "session",
    data: { phase: "memory_flushing" },
  });
  return {
    agentId: f.agentId,
    sessionKey: `agent:${f.agentId}:internal-session-effects:${turn.attemptId}-21a903bbd7325dca`,
    runId: turn.attemptId,
  };
}

test("a flush in a user turn on her own agent writes today's note", async (t) => {
  const own = { ...shared, mode: "own", members: [shared.members[0]] };
  const f = await usersFixture(t, own);
  const ctx = await flushTurn(f);
  assert.equal(await f.call(today, { ctx }), true);
  assert.equal(
    await f.call("MEMORY.md", { ctx }),
    false,
    "the flush writes its note only",
  );
});

test("a flush in a user turn on a shared agent never reaches the shared memory", async (t) => {
  const f = await usersFixture(t, shared);
  const ctx = await flushTurn(f);
  // Her chat stays private: its summary is refused, and her chat says so.
  assert.equal(await f.call(today, { ctx }), false);
  assert.deepEqual(f.notes(f.channel.conversationId), ["flush"]);
  assert.deepEqual(f.notes(f.other.id), []);
});

test("a flush in the owner's own chat with a shared agent never reaches the shared memory", async (t) => {
  for (const kind of ["owner", "telegram"]) {
    const f = await usersFixture(t, shared);
    const ctx = await flushTurn(f, { kind });
    // The users read this memory: the owner's private chat is not summarised into it.
    assert.equal(await f.call(today, { ctx }), false, kind);
    assert.deepEqual(f.notes(f.channel.conversationId), ["flush"], kind);
    assert.deepEqual(f.notes(f.other.id), [], kind);
  }
});

test("a shared agent's memory write leaves an applies-to-everyone note only in the writing user's chat", async (t) => {
  const f = await usersFixture(t, shared);
  await f.invocation("anna", { kind: "user", userId: "anna" });
  await f.benTurn("ben", { kind: "user", userId: "ben" });
  assert.equal(await f.call("MEMORY.md"), true);
  assert.equal(await f.call("memory/notes.md"), true);
  // USER.md stays the owner's, and a write outside memory is no shared memory.
  assert.equal(await f.call("USER.md"), false);
  assert.equal(await f.call("notes.md"), true);
  assert.deepEqual(f.notes(f.channel.conversationId), ["shared-write"]);
  assert.deepEqual(f.notes(f.other.id), []);
  assert.equal(
    await f.call("MEMORY.md", { ctx: { agentId: f.agentId, sessionKey: "session-ben" } }),
    true,
  );
  assert.deepEqual(f.notes(f.other.id), ["shared-write"]);
  assert.deepEqual(f.notes(f.channel.conversationId), ["shared-write"]);
});

// The owner changes who the agent serves while a turn still runs.
function reassign(f, userAccess) {
  const body = { ...f.store.storedAssistant(f.id) };
  if (userAccess) body.userAccess = userAccess;
  else delete body.userAccess;
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
}

test("a user's turn no longer writes memory once she is not one of the agent's users", async (t) => {
  const f = await usersFixture(t, shared);
  await f.benTurn("ben", { kind: "user", userId: "ben" });
  const ctx = { ctx: { agentId: f.agentId, sessionKey: "session-ben" } };
  assert.equal(await f.call("MEMORY.md", ctx), true);
  reassign(f, { mode: "own", members: [shared.members[0]], released: [] });
  assert.equal(await f.call("MEMORY.md", ctx), false);
  assert.equal(await f.call("memory/notes.md", ctx), false);
  assert.deepEqual(f.notes(f.other.id), ["shared-write", "not-owner"]);
});

test("a user origin on an agent without users writes no memory", async (t) => {
  const f = await usersFixture(t, shared);
  reassign(f, null);
  await f.invocation("anna", { kind: "user", userId: "anna" });
  assert.equal(await f.call("MEMORY.md"), false);
  assert.deepEqual(f.notes(f.channel.conversationId), ["not-owner"]);
});

test("a flush in the turn of a user who left the agent is refused", async (t) => {
  const own = { ...shared, mode: "own", members: [shared.members[0]] };
  const f = await usersFixture(t, own);
  const ctx = await flushTurn(f);
  reassign(f, { ...own, members: [shared.members[1]] });
  assert.equal(await f.call(today, { ctx }), false);
  assert.deepEqual(f.notes(f.channel.conversationId), ["flush"]);
});
