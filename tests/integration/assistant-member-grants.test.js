import test from "node:test";
import assert from "node:assert/strict";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import {
  personalCapabilities,
  personalShell,
  personalSkills,
} from "../../server/features/assistants/native-capabilities.js";

const setup = memberGrantFixture;

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

test("a grant beyond the lead, or for an archived member, is refused", async (t) => {
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
  f.teams.write(f.teams.member(f.member.id), {
    phase: "completed",
    archivedAt: "2026-10-17",
  });
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
