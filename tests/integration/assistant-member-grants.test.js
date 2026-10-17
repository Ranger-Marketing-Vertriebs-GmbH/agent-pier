import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { MemberGrants } from "../../server/features/assistants/member-grant-requests.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import {
  personalCapabilities,
  personalShell,
  personalSkills,
} from "../../server/features/assistants/native-capabilities.js";

const caps = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};

// A lead with every capability, Telegram paired, and one running task member.
async function setup(t, { memberShellSsh = false } = {}) {
  const f = await workflowFixture(t);
  const lead = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: caps, shell: "approval", skills: ["weather"] },
    lead.revision,
  );
  const teams = new TeamStore({ store: f.store, sshGranted: () => true });
  if (memberShellSsh) teams.savePolicy(f.id, { memberShellSsh: true }, 1);
  const audits = [];
  f.services.audit.append = (event) => audits.push(event);
  const synced = [];
  const grants = new MemberGrants({
    teams,
    assistants: f.assistants,
    audit: f.services.audit,
    onChanged: (member) => synced.push(member.id),
  });
  f.assistants.teams = { store: teams, grants };
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [{ name: "Scout", role: "Research", assignment: "Look around" }],
  });
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const memberChat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: memberChat.id, phase: "running" });
  // A tool call of the lead in an owner turn.
  const call = async (input) =>
    grants.grant(await f.invocation(randomUUID()), { memberId: member.id, ...input });
  const agent = () => f.store.getAssistant(member.assistantId);
  return { ...f, teams, grants, member, memberChat, call, agent, audits, synced };
}

test("a lead grants a running member more within its own capabilities, visibly", async (t) => {
  const f = await setup(t);
  assert.equal(personalCapabilities(f.agent()).browser, false);
  const result = await f.call({ grants: { browser: true, skills: ["weather"] } });
  assert.equal(result.status, "granted");
  assert.deepEqual(result.granted, ["browser", "skills"]);
  assert.equal(personalCapabilities(f.agent()).browser, true);
  assert.deepEqual(personalSkills(f.agent()), ["weather"]);
  const record = f.teams.member(f.member.id);
  assert.equal(record.grantLog.at(-1).by, "lead");
  assert.deepEqual(record.grantLog.at(-1).granted, ["browser", "skills"]);
  assert.deepEqual(f.synced, [f.member.id]);
  // Audited without content, and noted in the member's chat and the lead's.
  const audit = f.audits.at(-1);
  assert.equal(audit.details.kind, "member-grant");
  assert.deepEqual(audit.details.grants, ["browser", "skills"]);
  assert.ok(!JSON.stringify(audit).includes("Scout"));
  for (const conversation of [f.memberChat.id, f.channel.conversationId]) {
    const owner =
      conversation === f.memberChat.id ? f.member.assistantId : f.channel.assistantId;
    const [note] = actionNotes(f.workflows.store.list(owner), conversation);
    assert.equal(note.event, "member-grant");
    assert.deepEqual(note.granted, ["browser", "skills"]);
    assert.equal(note.memberName, "Scout");
  }
});

test("a grant beyond the lead, or for a member that ended, is refused", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.call({ grants: { skills: ["himalaya"] } }), {
    key: "teamGrantNotHeld",
  });
  await assert.rejects(f.call({ grants: { shell: "approval" } }), {
    key: "teamGrantNotHeld",
  });
  await assert.rejects(f.call({ mcpServers: ["github"] }), {
    key: "teamMcpServerNotBound",
  });
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  await assert.rejects(f.call({ grants: { browser: true } }), {
    key: "teamGrantMemberEnded",
  });
  assert.equal(personalCapabilities(f.agent()).browser, false);
});

test("shell and SSH granted later wait for the owner's approval", async (t) => {
  const f = await setup(t, { memberShellSsh: true });
  const result = await f.call({
    grants: { shell: "approval", ssh: true, browser: true },
  });
  assert.equal(result.status, "approval_requested");
  assert.deepEqual(result.granted, ["browser"]);
  assert.deepEqual(result.pending, ["shell", "ssh"]);
  assert.equal(personalShell(f.agent()), "off");
  const [action] = f.workflows
    .list(f.channel.assistantId)
    .actions.filter(
      (a) => a.payload.action === "member_grant" && a.state === "awaiting_approval",
    );
  assert.deepEqual(action.payload.grants, { shell: "approval", ssh: true });
  assert.equal(action.payload.memberName, "Scout");
  const approved = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(approved.state, "completed");
  assert.equal(personalShell(f.agent()), "approval");
  assert.equal(f.agent().inherited.ssh, true);
  assert.equal(f.teams.member(f.member.id).grantLog.at(-1).by, "owner");
});

test("a declined shell grant changes nothing, and a lead revokes at any time", async (t) => {
  const f = await setup(t, { memberShellSsh: true });
  await f.call({ grants: { shell: "approval" } });
  const [action] = f.workflows
    .list(f.channel.assistantId)
    .actions.filter(
      (a) => a.payload.action === "member_grant" && a.state === "awaiting_approval",
    );
  await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "decline" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(personalCapabilities(f.agent()).webSearch, true);
  const revoked = await f.call({ grants: { webSearch: true }, revoke: true });
  assert.equal(revoked.status, "revoked");
  assert.equal(personalCapabilities(f.agent()).webSearch, false);
  assert.equal(f.teams.member(f.member.id).grantLog.at(-1).revoked[0], "webSearch");
});
