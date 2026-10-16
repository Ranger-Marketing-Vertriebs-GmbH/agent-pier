import test from "node:test";
import assert from "node:assert/strict";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  agentSshFixture,
  hostId,
  otherHostId,
  waitFor,
} from "../helpers/agent-ssh-fixture.js";

const owner = { kind: "owner", channel: "ui" };
const pending = (f, id = f.id) =>
  f.workflows.store
    .list(id)
    .find((a) => a.payload.action === "ssh" && a.state === "awaiting_approval");
const decide = (f, a, decision) =>
  f.workflows.decide(a.id, { decision, revision: a.revision }, owner);
const codeOf = async (promise) => toolError(await promise.catch((e) => e)).code;

async function approvalFixture(t) {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([
    { accessId: hostId, mode: "approval" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  return f;
}

test("Allow once within the hold returns the result in the same call", async (t) => {
  const f = await approvalFixture(t);
  const call = f.execute(f.ownTurn(), 'process.stdout.write("up 3 days")');
  const action = await waitFor(() => pending(f));
  assert.equal(action.payload.command, 'process.stdout.write("up 3 days")');
  assert.equal(action.payload.hostName, "opnsense");
  assert.equal(action.payload.username, "root");
  assert.equal(action.payload.originClass, "owner");
  assert.ok(action.expiresAt > Date.now() + 590000);
  await decide(f, action, "approve");
  const result = await call;
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "up 3 days");
  assert.equal(f.workflows.get(action.id).state, "completed");
  assert.ok(
    f.audit.some(
      (e) =>
        e.action === "ssh.executed" &&
        e.details.authorizedBy === "approval" &&
        e.details.actionId === action.id,
    ),
  );
  assert.ok(
    f.audit.some((e) => e.action === "assistant.answered" && e.details.kind === "ssh"),
  );
  await f.workflows.tick();
  assert.equal(f.followUps.length, 0, "a delivered result needs no follow-up");
  assert.equal(f.workflows.get(action.id).settled, true);
  assert.equal(JSON.stringify(f.audit).includes("up 3 days"), false);
});

test("Deny returns denied and runs nothing", async (t) => {
  const f = await approvalFixture(t);
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const action = await waitFor(() => pending(f));
  await decide(f, action, "decline");
  assert.deepEqual(await call, { status: "denied", actionId: action.id });
  assert.equal(f.catalog.connections, 0);
  assert.equal(f.audit.filter((e) => e.action === "ssh.executed").length, 0);
});

test("a late Allow once arrives as a follow-up that keeps the turn's class", async (t) => {
  const f = await approvalFixture(t);
  f.workflows.ssh.approvals.holdMs = 100;
  const result = await f.execute(f.ownTurn(), 'process.stdout.write("late output")');
  assert.equal(result.status, "awaiting_approval");
  assert.match(result.notice, /separate message/);
  const action = f.workflows.get(result.actionId);
  assert.equal(action.followUp, true);
  await decide(f, action, "approve");
  await waitFor(() => f.workflows.get(action.id).state === "completed");
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1);
  assert.deepEqual(f.followUps[0].context, { kind: "ssh-result", actionId: action.id });
  assert.match(f.followUps[0].input.text, /late output/);
  assert.match(f.followUps[0].input.text, /not a new owner instruction/);
  assert.equal(f.workflows.get(action.id).settled, true);
  // The follow-up turn may use a trusted host like the owner turn it continues.
  const followUp = f.turn(f.channel.conversationId, f.followUps[0].context);
  assert.equal(
    (await f.execute(followUp, "process.exit(0)", otherHostId)).status,
    "completed",
  );
  await f.workflows.tick();
  assert.equal(f.followUps.length, 1, "sent once");
});

test("an ssh-result turn of another agent's action inherits nothing", async (t) => {
  const f = await approvalFixture(t);
  const m = f.member();
  f.grant([{ accessId: otherHostId, mode: "trusted" }], m.id);
  f.workflows.ssh.approvals.holdMs = 50;
  const { actionId } = await f.execute(f.ownTurn(), "process.exit(0)");
  const forged = f.turn(m.conversationId, { kind: "ssh-result", actionId });
  assert.equal(
    await codeOf(f.execute(forged, "process.exit(0)", otherHostId)),
    "SSH_ORIGIN_REFUSED",
  );
});

test("an expired card ends the held call and can no longer be allowed", async (t) => {
  const f = await approvalFixture(t);
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const action = await waitFor(() => pending(f));
  f.workflows.store.patch(action.id, { expiresAt: Date.now() - 1 });
  await assert.rejects(decide(f, f.workflows.get(action.id), "approve"), { status: 409 });
  await f.workflows.tick();
  assert.deepEqual(await call, { status: "expired", actionId: action.id });
});

test("the decision re-checks the pinned host, the host and the grant", async (t) => {
  for (const [label, change, diagnostic] of [
    ["re-keyed", (f) => (f.catalog.rows.get(hostId).revision = "r2"), "ACCESS_CHANGED"],
    ["removed", (f) => f.catalog.rows.delete(hostId), "HOST_REMOVED"],
    [
      "ungranted",
      (f) => f.grant([{ accessId: otherHostId, mode: "trusted" }]),
      "ACCESS_CHANGED",
    ],
  ])
    await t.test(label, async (t) => {
      const f = await approvalFixture(t);
      const call = f.execute(f.ownTurn(), "process.exit(0)");
      const action = await waitFor(() => pending(f));
      change(f);
      const decided = await decide(f, action, "approve");
      assert.equal(decided.state, "cancelled");
      assert.equal(decided.diagnostic, diagnostic);
      assert.equal(await codeOf(call), "SSH_REVOKED");
      assert.equal(f.catalog.connections, 0);
    });
});

test("a re-prepared retry of the same tool call finds the same card", async (t) => {
  const f = await approvalFixture(t);
  const inv = f.ownTurn();
  const first = f.execute(inv, "process.exit(0)");
  const action = await waitFor(() => pending(f));
  const second = f.execute(inv, "process.exit(0)");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    f.workflows.store.list(f.id).filter((a) => a.payload.action === "ssh").length,
    1,
  );
  await decide(f, action, "decline");
  assert.equal((await first).status, "denied");
  assert.equal((await second).status, "denied");
});

test("the same tool call with another command never reuses the card", async (t) => {
  const f = await approvalFixture(t);
  const inv = f.ownTurn();
  const first = f.execute(inv, "process.exit(0)");
  const action = await waitFor(() => pending(f));
  await assert.rejects(f.execute(inv, "process.exit(1)"), { status: 409 });
  await decide(f, action, "decline");
  assert.equal((await first).status, "denied");
});

test("a fourth open approval is refused", async (t) => {
  const f = await approvalFixture(t);
  const calls = [1, 2, 3].map(() => f.execute(f.ownTurn(), "process.exit(0)"));
  await waitFor(
    () =>
      f.workflows.store.list(f.id).filter((a) => a.state === "awaiting_approval")
        .length === 3,
  );
  assert.equal(
    await codeOf(f.execute(f.ownTurn(), "process.exit(0)")),
    "SSH_APPROVAL_LIMIT",
  );
  for (const a of f.workflows.store
    .list(f.id)
    .filter((x) => x.state === "awaiting_approval"))
    await decide(f, a, "decline");
  await Promise.all(calls);
});

test("two decisions at once run the command once", async (t) => {
  const f = await approvalFixture(t);
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const action = await waitFor(() => pending(f));
  const outcomes = await Promise.allSettled([
    decide(f, action, "approve"),
    decide(f, action, "approve"),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(outcomes.find((o) => o.status === "rejected").reason.status, 409);
  assert.equal((await call).status, "completed");
  assert.equal(f.audit.filter((e) => e.action === "ssh.executed").length, 1);
});

test("a command interrupted by a restart is never run again", async (t) => {
  const f = await approvalFixture(t);
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const action = await waitFor(() => pending(f));
  f.workflows.store.patch(action.id, { state: "executing" });
  // What AgentPier's next start does to every executing action.
  new AssistantActionStore(f.store.db);
  assert.equal(f.workflows.get(action.id).state, "unknown");
  assert.equal(await codeOf(call), "SSH_REVOKED");
  await f.workflows.tick();
  assert.equal(f.workflows.get(action.id).settled, true);
  assert.equal(f.followUps.length, 0);
  assert.equal(f.catalog.connections, 0);
});

test("a member's approval in a lead's task waits in both chats", async (t) => {
  const f = await approvalFixture(t);
  const m = f.member();
  f.grant([{ accessId: hostId, mode: "approval" }], m.id);
  const call = f.execute(
    f.turn(m.conversationId, {
      kind: "lead-request",
      requestId: "r1",
      leadAssistantId: f.id,
    }),
    "process.exit(0)",
  );
  const action = await waitFor(() => pending(f, m.id));
  assert.equal(action.leadAssistantId, f.id);
  assert.equal(action.memberName, "Scout");
  assert.equal(action.payload.originClass, "delegated");
  assert.ok(
    f.workflows.list(f.id, { delegated: true }).actions.some((a) => a.id === action.id),
  );
  const counts = f.workflows.store.awaitingCounts();
  assert.equal(counts[m.id].own, 1);
  assert.equal(counts[f.id].team, 1);
  await decide(f, action, "decline");
  assert.equal((await call).status, "denied");
});
