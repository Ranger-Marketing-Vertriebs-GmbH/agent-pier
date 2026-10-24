import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationPrompt,
  directOwnerTurn,
  goalAgent,
  goalChat,
  goalTurn,
  ownerSource,
  refuseInGoalTurn,
  turnKind,
} from "../../server/features/assistants/goal-turns.js";

test("a continuation context is an owner turn with a goal marker", () => {
  const c = { kind: "owner", goal: { id: "g", anchorRequestId: "r", title: "Cut" } };
  assert.deepEqual(goalTurn(c), { id: "g", anchorRequestId: "r", title: "Cut" });
  assert.equal(goalTurn({ kind: "owner" }), null);
  assert.equal(goalTurn({ kind: "owner", goal: { id: "g" } }), null);
  assert.equal(directOwnerTurn(c), false);
  assert.equal(directOwnerTurn({ kind: "telegram" }), true);
  assert.equal(directOwnerTurn({ kind: "owner", forwarded: true }), false);
  assert.equal(directOwnerTurn({ kind: "user", userId: "u" }), false);
  assert.equal(turnKind(c), "goal-continuation");
  assert.equal(turnKind({ kind: "ssh-result" }), "ssh-result");
  const result = { ...c, result: { kind: "member-result", requestId: "lr" } };
  assert.equal(turnKind(result), "member-result");
  assert.deepEqual(goalTurn(result), c.goal);
});

test("only own agents and permanent members keep goals, in the owner's chats", () => {
  const own = { id: "a" },
    chat = { id: "c", assistantId: "a" };
  assert.equal(goalChat(own, chat), true);
  assert.equal(
    goalChat({ id: "a", teamMemberId: "m", lifetime: "permanent" }, chat),
    true,
  );
  assert.equal(goalChat({ id: "a", teamMemberId: "m", lifetime: "task" }, chat), false);
  assert.equal(
    goalChat({ id: "a", userAccess: { mode: "shared", members: [] } }, chat),
    false,
  );
  assert.equal(
    goalChat({ id: "a", userAccess: { mode: "own", members: [] } }, chat),
    false,
  );
  assert.equal(goalChat({ id: "a", archivedAt: "x" }, chat), false);
  assert.equal(goalChat(own, { ...chat, userId: "u" }), false);
  assert.equal(goalChat(own, { ...chat, archivedAt: "x" }), false);
});

test("a continuation's owner proofs read its anchor, never its own prompt", () => {
  const requests = {
    anchor: { id: "anchor", text: "@Scout render all shots" },
    cont: { id: "cont", text: "This is AgentPier, not the owner. @Scout" },
  };
  const contexts = {
    anchor: { kind: "owner" },
    cont: { kind: "owner", goal: { id: "g", anchorRequestId: "anchor", title: "T" } },
  };
  const teams = {
    ledger: { getRequest: (id) => requests[id] },
    context: (id) => contexts[id],
  };
  assert.deepEqual(ownerSource(teams, requests.cont), {
    request: requests.anchor,
    context: contexts.anchor,
    continuation: true,
  });
  assert.deepEqual(ownerSource(teams, requests.anchor), {
    request: requests.anchor,
    context: contexts.anchor,
    continuation: false,
  });
  contexts.anchor = { kind: "owner", forwarded: true };
  const lost = ownerSource(teams, requests.cont);
  assert.equal(lost.request.text, "");
  assert.equal(lost.context.kind, "unknown");
});

test("the continuation prompt says who speaks and how to end", () => {
  const text = continuationPrompt({
    title: "Review cut",
    done: "Playable cut",
    steps: "",
  });
  assert.match(text, /^This is AgentPier, not the owner\./);
  assert.match(text, /"Review cut"/);
  assert.match(text, /Done means: Playable cut/);
  assert.match(text, /Your open steps: none noted/);
  assert.match(text, /agentpier_goal with action "done"/);
  assert.match(text, /action "blocked"/);
});

test("owner-only actions refuse a continuation", () => {
  assert.throws(
    () =>
      refuseInGoalTurn({
        kind: "owner",
        goal: { id: "g", anchorRequestId: "r", title: "T" },
      }),
    (e) => e.key === "goalOwnerOnly" && e.status === 403,
  );
  refuseInGoalTurn({ kind: "owner" });
});

test("no agent is no goal agent", () => {
  assert.equal(goalAgent(undefined), false);
  assert.equal(goalAgent(null), false);
  assert.equal(goalChat(undefined, { id: "c", assistantId: "a" }), false);
});
