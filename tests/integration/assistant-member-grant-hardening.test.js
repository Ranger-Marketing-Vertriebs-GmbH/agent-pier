import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { mirrorLeadMemory } from "../../server/features/assistants/member-memory.js";
import {
  personalCapabilities,
  personalShell,
} from "../../server/features/assistants/native-capabilities.js";

const pending = (f) =>
  f.workflows.store
    .list(f.channel.assistantId)
    .filter((a) => a.payload.action === "member_grant" && a.payload.approval);
const owner = { kind: "owner", channel: "ui" };
const decide = (f, a, decision = "approve") =>
  f.workflows.decide(a.id, { revision: a.revision, decision }, owner);

test("a shell grant approved after the setting went off or the team ended fails closed", async (t) => {
  for (const end of ["setting", "team"]) {
    const f = await memberGrantFixture(t, { memberShellSsh: true });
    await f.call({ grants: { shell: "approval" } });
    const [card] = pending(f);
    if (end === "setting") {
      // Written without the service hook, so the card still waits.
      const policy = f.teams.policy(f.id);
      f.teams.writePolicy(f.id, { memberShellSsh: false }, policy.revision);
    } else f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
    const decided = await decide(f, f.workflows.store.get(card.id));
    assert.equal(decided.state, "failed", end);
    assert.equal(f.workflows.store.get(card.id).diagnostic, "GRANT_REVOKED");
    assert.equal(personalShell(f.agent()), "off", end);
  }
});

test("switching the setting off latches: grants and cards go, switching on restores nothing", async (t) => {
  const f = await memberGrantFixture(t, {
    memberShellSsh: true,
    grants: { webSearch: true, shell: "approval" },
  });
  assert.equal(personalShell(f.agent()), "approval");
  await f.call({ grants: { ssh: true } });
  const [card] = pending(f);
  let policy = f.teams.policy(f.id);
  f.teams.writePolicy(f.id, { memberShellSsh: false }, policy.revision);
  await f.grants.settingOff(f.id);
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.teams.member(f.member.id).grants.shell, undefined);
  assert.equal(personalCapabilities(f.agent()).webSearch, true);
  const cancelled = f.workflows.store.get(card.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.chatNotes.result.state, "cancelled");
  policy = f.teams.policy(f.id);
  f.teams.writePolicy(f.id, { memberShellSsh: true }, policy.revision);
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.agent().inherited.ssh, false);
});

test("revoking shell cancels the pending card with a notice, and an ended member's card is withdrawn", async (t) => {
  const f = await memberGrantFixture(t, { memberShellSsh: true });
  await f.call({ grants: { shell: "approval" } });
  const [first] = pending(f);
  await f.call({ grants: { shell: "approval" }, revoke: true });
  const revoked = f.workflows.store.get(first.id);
  assert.equal(revoked.state, "cancelled");
  // Not settled yet: the tick still sends the result notice, then settles it.
  assert.notEqual(revoked.settled, true);
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(first.id).settled, true);
  await f.call({ grants: { ssh: true } });
  const second = pending(f).find((a) => a.id !== first.id);
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(second.id).state, "cancelled");
});

test("a lead cannot grant another lead's member, and a member cannot call grant", async (t) => {
  const f = await memberGrantFixture(t);
  const other = f.store.createAssistant({
    name: "Other",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: "other-session",
  });
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: "other",
    text: "Grant",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(
    f.grants.grant(
      { attemptId: attempt.id, toolCallId: "x", assertCurrent() {} },
      { memberId: f.member.id, grants: { webSearch: true } },
    ),
    { key: "teamGrantMemberEnded" },
  );
  const bridge = new TeamBridge({
    assistants: {
      store: f.store,
      ledger: f.assistants.ledger,
      runtime: { client: { ready: true }, status: () => ({}) },
    },
    teams: {},
  });
  bridge.closed = false;
  const turn = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "member",
    text: "Go",
  });
  const memberAttempt = f.assistants.ledger.recordAttempt(turn.id);
  assert.throws(
    () =>
      bridge.valid({
        action: "grant",
        attemptId: memberAttempt.id,
        sessionKey: "member-session",
        agentId: f.agent().runtimeAgentId,
        generation: 1,
      }),
    { status: 403 },
  );
});

test("members reserved before grants existed get nothing", async (t) => {
  const f = await memberGrantFixture(t);
  const record = f.teams.member(f.member.id);
  f.teams.write(record, { grants: undefined });
  assert.deepEqual(Object.values(personalCapabilities(f.agent())).filter(Boolean), []);
});

test("a member's reminders are capped per team and noted in the lead's chat", async (t) => {
  const f = await memberGrantFixture(t, { grants: { reminders: true } });
  const turn = () => {
    const request = f.assistants.ledger.accept(f.memberChat.id, {
      clientRequestId: randomUUID(),
      text: "Go",
    });
    f.teams.recordContext(request.id, {
      kind: "team-member",
      teamId: f.member.teamId,
      memberId: f.member.id,
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: randomUUID(), assertCurrent() {} };
  };
  const created = [];
  const reminders = {
    kind: "reminder",
    bindings: { list: () => created },
  };
  const { NativeReminders } =
    await import("../../server/features/assistants/native-reminders.js");
  Object.setPrototypeOf(reminders, NativeReminders.prototype);
  reminders.assistants = f.assistants;
  reminders.create = async (id, input, origin, assertCurrent, metadata) => {
    created.push({
      assistantId: id,
      key: input.clientRequestId,
      state: "bound",
      ...metadata,
    });
    return { status: "ready" };
  };
  const input = {
    action: "create",
    name: "Check",
    message: "Look",
    schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
  };
  for (let n = 0; n < 5; n++) await reminders.invoke(turn(), input);
  assert.equal(created.length, 5);
  assert.equal(created[0].createdBy.teamId, f.member.teamId);
  await assert.rejects(async () => reminders.invoke(turn(), input), {
    key: "memberReminderLimit",
  });
  const notes = f.workflows.store
    .list(f.channel.assistantId)
    .filter((a) => a.payload.action === "member_reminder");
  assert.equal(notes.length, 5);
  assert.equal(notes[0].conversationId, f.channel.conversationId);
  const audit = f.audits.filter((a) => a.details.kind === "member-reminder");
  assert.equal(audit.length, 5);
  assert.ok(!JSON.stringify(audit).includes("Look"));
});

test("promotion removes the lead's memory copy from the member's workspace", async (t) => {
  const f = teamFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "member-promote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  f.assistants.config.workspaces = root;
  const { team } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  let member = f.service.store.members(team.id)[0];
  const agent = f.store.getAssistant(member.assistantId);
  fs.mkdirSync(path.join(root, agent.id), { recursive: true });
  fs.mkdirSync(path.join(root, agent.parentAssistantId), { recursive: true });
  fs.writeFileSync(path.join(root, agent.parentAssistantId, "MEMORY.md"), "Lead facts");
  await mirrorLeadMemory(root, agent, true);
  assert.ok(fs.existsSync(path.join(root, agent.id, "MEMORY.md")));
  f.complete(f.service.store.member(member.id).attemptId);
  await f.service.reconcile();
  member = f.service.store.member(member.id);
  assert.equal(member.phase, "completed");
  await f.service.lifecycle("promote", member.id, member.revision);
  assert.equal(fs.existsSync(path.join(root, agent.id, "MEMORY.md")), false);
});

test("a task member's shell request is never allowed always", async (t) => {
  const f = await memberGrantFixture(t, {
    memberShellSsh: true,
    grants: { shell: "approval" },
  });
  const { decideExec } =
    await import("../../server/features/assistants/exec-decisions.js");
  const calls = [];
  const w = {
    a: {
      store: f.store,
      runtime: { client: { ready: true, call: async (m) => calls.push(m) } },
    },
    exec: { deciding: new Set() },
  };
  const action = {
    id: "exec-1",
    assistantId: f.member.assistantId,
    payload: { action: "exec", approvalId: "a1", allowedDecisions: ["allow-always"] },
  };
  await assert.rejects(decideExec(w, action, "allow-always"), { status: 400 });
  assert.deepEqual(calls, []);
});
