import test from "node:test";
import assert from "node:assert/strict";
import {
  foreignOrigin,
  ownerRun,
  ownerTurn,
} from "../../server/features/assistants/owner-runs.js";
import { flushWrite } from "../../server/features/assistants/memory-write-policy.js";
import { flushDates } from "../../server/features/assistants/memory-flushes.js";

// AGENTPIER-276: every run of the owner's own chat with their agent works on its
// standing grants, unless its content came from someone else.
const agent = { id: "a1", runtimeAgentId: "ap-a1" };
const chat = { id: "c1", assistantId: "a1" };
function bridge({ who = agent, conversation = chat, latest = { kind: "owner" } } = {}) {
  return {
    agentOf: () => who,
    assistants: {
      store: {
        conversationOfSession: () => conversation,
        getConversation: () => conversation,
      },
      ledger: {
        latestRequest: () => (latest ? { id: "r1" } : null),
        getRequest: () => ({ conversationId: conversation?.id }),
      },
    },
    teams: { store: { context: () => latest } },
  };
}
const input = { agentId: "ap-a1", sessionKey: "session" };

test("a run of the owner's chat without a turn works for them after their own turns", () => {
  for (const latest of [
    null,
    { kind: "owner" },
    { kind: "telegram" },
    { kind: "reminder" },
    { kind: "routine" },
    { kind: "member-result", requestId: "q" },
    { kind: "unknown" },
  ])
    assert.deepEqual(
      ownerRun(bridge({ latest }), input),
      { agent, conversation: chat },
      JSON.stringify(latest),
    );
});

test("someone else's content, a user agent or another chat keep their limits", () => {
  for (const latest of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "member-report" },
    { kind: "peer-result" },
    { kind: "lead-request" },
    { kind: "team-member" },
  ]) {
    assert.equal(foreignOrigin(latest), true, JSON.stringify(latest));
    assert.equal(ownerRun(bridge({ latest }), input), null, JSON.stringify(latest));
  }
  const userAgent = { ...agent, userAccess: { mode: "own", members: [] } };
  assert.equal(ownerRun(bridge({ who: userAgent }), input), null);
  assert.equal(
    ownerRun(bridge({ conversation: { ...chat, userId: "anna" } }), input),
    null,
  );
  assert.equal(
    ownerRun(bridge({ conversation: { ...chat, assistantId: "b" } }), input),
    null,
  );
  // The agent's Telegram bot for other people runs in sessions of no owner chat.
  assert.equal(ownerRun(bridge({ conversation: null }), input), null);
  assert.equal(ownerRun(bridge({ who: { ...agent, archivedAt: "x" } }), input), null);
  assert.equal(ownerRun(bridge({ who: { ...agent, teamMemberId: "m" } }), input), null);
  assert.equal(
    ownerTurn({ ...agent, teamMemberId: "m" }, chat, { kind: "owner" }),
    false,
  );
});

const run = "95e977b6-0ee8-4bc0-a310-5a2cf14f5c17";
const [today] = flushDates(Date.now());
const flush = {
  agentId: "ap-a1",
  sessionKey: `agent:ap-a1:internal-session-effects:${run}-21a903bbd7325dca`,
  toolName: "write",
  path: today,
  runId: run,
};
// A bridge whose one reported flush interrupts a turn (or a run without one).
function flushBridge({ origin, bound = true, latest = { kind: "owner" } }) {
  const base = bridge({ latest });
  const attempt = { id: run, runtimeRunId: run, requestId: "r1" };
  return {
    ...base,
    now: () => Date.now(),
    warn: () => {},
    assistants: {
      ...base.assistants,
      memoryFlushes: {
        active: () => [{ sessionKey: "session", runId: run }],
        pin: () => true,
      },
    },
    noteShared() {},
    bound: () => (bound ? [attempt] : []),
    turn: () => ({ attempt, parent: agent, origin, current: true }),
    routineWrite: () => false,
  };
}

test("the memory flush of any owner run keeps the agent's notes", () => {
  // AGENTPIER-276: these flushes were refused (FLUSH_ORIGIN, FLUSH_UNREPORTED).
  assert.equal(flushWrite(flushBridge({ origin: { kind: "reminder" } }), flush), true);
  assert.equal(flushWrite(flushBridge({ origin: { kind: "unknown" } }), flush), true);
  assert.equal(flushWrite(flushBridge({ bound: false }), flush), true);
  // Someone else's content still never flushes into the agent's memory.
  const forwarded = { kind: "owner", forwarded: true };
  assert.equal(flushWrite(flushBridge({ origin: forwarded }), flush), false);
  assert.equal(
    flushWrite(flushBridge({ bound: false, latest: forwarded }), flush),
    false,
  );
});
