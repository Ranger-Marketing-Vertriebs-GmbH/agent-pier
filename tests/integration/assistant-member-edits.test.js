import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import {
  MemberEdits,
  editedInstructions,
  replacedInstructions,
} from "../../server/features/assistants/member-edits.js";
import { publicTeam } from "../../server/features/assistants/team-service.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import {
  extraSection,
  memberInstructions,
  memberOverrides,
} from "../../server/features/assistants/team-presentation.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

async function setup(t) {
  const f = await memberGrantFixture(t);
  const changed = [];
  const edits = new MemberEdits({
    teams: f.teams,
    assistants: f.assistants,
    audit: f.services.audit,
    onChanged: (member) => changed.push(member.id),
  });
  const update = async (input, inv) =>
    edits.update(inv || (await f.invocation(randomUUID())), {
      memberId: f.member.id,
      ...input,
    });
  return { ...f, edits, update, changed };
}

test("a lead renames and re-briefs its member; the next turn runs with it", async (t) => {
  const f = await setup(t);
  const before = f.agent();
  const result = await f.update({
    name: "Scout Two",
    role: "Reviewer",
    assignment: "Review the draft",
    extraInstructions: "Answer in German.",
  });
  assert.deepEqual(result.changed, ["name", "role", "assignment", "extraInstructions"]);
  const member = f.teams.member(f.member.id);
  assert.equal(member.name, "Scout Two");
  assert.equal(member.role, "Reviewer");
  const agent = f.agent();
  assert.equal(agent.name, "Scout Two");
  // The lead's snapshot stays; role, assignment and the extra section follow it.
  assert.ok(agent.instructions.startsWith(member.snapshot.instructions));
  assert.match(agent.instructions, /Role: Reviewer\nAssignment: Review the draft/);
  assert.match(agent.instructions, /Answer in German\./);
  assert.equal(agent.instructions, memberInstructions(member.snapshot, member));
  // A new revision: the member's next turn re-applies its profile.
  assert.equal(agent.revision, before.revision + 1);
  assert.deepEqual(f.changed, [f.member.id]);
  // The lead's edit is not an owner override.
  assert.equal(memberOverrides(member, agent).instructions, false);
  // Visible: the team card history, both chats and an audit with field names only.
  assert.deepEqual(member.grantLog.at(-1).edited, [
    "name",
    "role",
    "assignment",
    "extraInstructions",
  ]);
  for (const [owner, chat] of [
    [f.member.assistantId, f.memberChat.id],
    [f.channel.assistantId, f.channel.conversationId],
  ]) {
    const [note] = actionNotes(f.workflows.store.list(owner), chat);
    assert.equal(note.event, "member-update");
    assert.equal(note.memberName, "Scout Two");
    assert.equal(note.previousName, "Scout");
  }
  const audit = f.audits.at(-1);
  assert.equal(audit.details.kind, "member-edit");
  assert.deepEqual(audit.details.edited, [
    "name",
    "role",
    "assignment",
    "extraInstructions",
  ]);
  for (const text of ["Reviewer", "Review the draft", "German", "Scout Two"])
    assert.ok(!JSON.stringify(audit).includes(text), text);
});

test("a lead edits the current instructions, so the owner's own text survives", async (t) => {
  const f = await setup(t);
  const agent = f.agent();
  const owned = `Owner rule first.\n\n${agent.instructions}\n\nOwner rule last.`;
  f.store.updateAssistant(agent.id, { instructions: owned }, agent.revision);
  assert.equal(
    memberOverrides(f.teams.member(f.member.id), f.agent()).instructions,
    true,
  );
  await f.update({ role: "Editor", extraInstructions: "Cite sources." });
  const text = f.agent().instructions;
  assert.ok(text.startsWith("Owner rule first."));
  assert.match(text, /Owner rule last\./);
  assert.match(text, /^Role: Editor$/m);
  assert.doesNotMatch(text, /^Role: Research$/m);
  assert.match(text, /^Assignment: Look around$/m);
  assert.match(text, /Cite sources\./);
  // A second edit replaces the lead's section instead of adding another.
  await f.update({ extraInstructions: "Cite two sources." });
  const again = f.agent().instructions;
  assert.equal(again.match(/Additional instructions from your lead/g).length, 1);
  assert.match(again, /Cite two sources\./);
  assert.doesNotMatch(again, /Cite sources\./);
  // The lead's edits are not owner overrides; the owner's next edit is one again.
  assert.equal(
    memberOverrides(f.teams.member(f.member.id), f.agent()).instructions,
    false,
  );
  const current = f.agent();
  f.store.updateAssistant(current.id, { instructions: "Owner again." }, current.revision);
  assert.equal(
    memberOverrides(f.teams.member(f.member.id), f.agent()).instructions,
    true,
  );
  // Without Role and Assignment lines the lead's ones are appended.
  await f.update({ role: "Writer", assignment: "Write it" });
  assert.equal(
    f.agent().instructions,
    "Owner again.\n\nRole: Writer\nAssignment: Write it",
  );
});

test("a lead may rewrite the whole instructions; the owner can read what was replaced", async (t) => {
  const f = await setup(t);
  const agent = f.agent();
  f.store.updateAssistant(agent.id, { instructions: "Owner text." }, agent.revision);
  const result = await f.update({ instructions: "Only review the tests." });
  assert.deepEqual(result.changed, ["instructions"]);
  assert.equal(f.agent().instructions, "Only review the tests.");
  const member = f.teams.member(f.member.id);
  // The record keeps only a reference; the owner reads the text on its own route.
  assert.ok(!JSON.stringify(member).includes("Owner text."));
  const { replaced } = member.grantLog.at(-1);
  assert.equal(replacedInstructions(f.teams, member.id, replaced).text, "Owner text.");
  assert.equal(memberOverrides(member, f.agent()).instructions, false);
  assert.deepEqual(f.audits.at(-1).details.edited, ["instructions"]);
  assert.ok(!JSON.stringify(f.audits.at(-1)).includes("Owner text"));
  await assert.rejects(f.update({ instructions: "A", extraInstructions: "B" }), {
    status: 400,
  });
});

test("edits are refused for a member that is not the lead's or no longer reachable", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.update({}), { status: 400 });
  await assert.rejects(f.update({ name: "" }), { status: 400 });
  await assert.rejects(f.update({ role: "x".repeat(201) }), { status: 400 });
  await assert.rejects(f.update({ prompt: "x" }), { status: 400 });
  // A finished member with a chat stays editable; an archived one does not.
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  assert.equal((await f.update({ role: "Done" })).changed[0], "role");
  f.teams.write(f.teams.member(f.member.id), { archivedAt: "2026-10-17" });
  await assert.rejects(f.update({ role: "Again" }), { key: "teamGrantMemberEnded" });
  f.teams.write(f.teams.member(f.member.id), { archivedAt: undefined });
  // Another lead's turn, in the same store, cannot edit this member.
  const other = f.store.createAssistant({
    name: "Other",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: "o",
  });
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: "o",
    text: "x",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(
    f.update(
      { role: "Hijack" },
      { attemptId: attempt.id, toolCallId: "x", assertCurrent() {} },
    ),
    { key: "teamGrantMemberEnded" },
  );
  assert.equal(f.teams.member(f.member.id).role, "Done");
  // A permanent member of the lead stays editable; an archived one does not.
  f.teams.write(f.teams.member(f.member.id), { lifetime: "permanent" });
  assert.equal((await f.update({ role: "Again" })).status, "updated");
  f.teams.write(f.teams.member(f.member.id), { archivedAt: "2026-10-18" });
  await assert.rejects(f.update({ role: "Third" }), { key: "teamGrantMemberEnded" });
});

test("a lead re-briefs its permanent member; the owner's next chat runs with it", async (t) => {
  const f = await setup(t);
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  const kept = f.teams.member(f.member.id);
  f.teams.promote(kept.id, kept.revision);
  const result = await f.update({ instructions: "New handbook" });
  assert.equal(result.status, "updated");
  assert.equal(f.agent().instructions, "New handbook");
  const member = f.teams.member(f.member.id);
  assert.equal(member.lifetime, "permanent");
  const entry = member.grantLog.at(-1);
  assert.equal(entry.by, "lead");
  assert.deepEqual(entry.edited, ["instructions"]);
  assert.ok(replacedInstructions(f.teams, member.id, entry.replaced).text);
  const [note] = actionNotes(
    f.workflows.store.list(f.channel.assistantId),
    f.channel.conversationId,
  );
  assert.equal(note.event, "member-update");
  // Its task chat, still there, gets the note too.
  const [own] = actionNotes(
    f.workflows.store.list(f.member.assistantId),
    f.memberChat.id,
  );
  assert.equal(own.event, "member-update");
});

test("a permanent member without a task chat still gets a history entry", async (t) => {
  const f = await setup(t);
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  const kept = f.teams.member(f.member.id);
  f.teams.promote(kept.id, kept.revision);
  f.teams.write(f.teams.member(f.member.id), { conversationId: undefined });
  await f.update({ role: "Archivist" });
  assert.equal(f.teams.member(f.member.id).grantLog.at(-1).edited[0], "role");
  assert.equal(
    actionNotes(f.workflows.store.list(f.channel.assistantId), f.channel.conversationId)
      .length,
    1,
  );
  assert.equal(
    actionNotes(f.workflows.store.list(f.member.assistantId), f.memberChat.id).length,
    0,
  );
});

test("a member cannot call the edit tool itself", async (t) => {
  const f = await setup(t);
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
  const attempt = f.assistants.ledger.recordAttempt(turn.id);
  assert.throws(
    () =>
      bridge.valid({
        action: "member_update",
        attemptId: attempt.id,
        sessionKey: "member-session",
        agentId: f.agent().runtimeAgentId,
        generation: 1,
      }),
    { status: 403 },
  );
});

test("the lead's composed block is found at line starts, last, and whole", () => {
  const member = { role: "dev", assignment: "Step one\nStep two" };
  const snapshot =
    "Role: dev\nAssignment: Step one\n\nRole: developer of tools is yours.\nLead rules.";
  const text = memberInstructions({ instructions: snapshot }, member);
  const role = editedInstructions(text, member, { role: "ops" });
  assert.equal(
    role,
    memberInstructions({ instructions: snapshot }, { ...member, role: "ops" }),
  );
  const both = editedInstructions(text, member, {
    role: "ops",
    assignment: "Only step three",
  });
  assert.equal(both, `${snapshot}\n\nRole: ops\nAssignment: Only step three`);
  // The extra section stays last, after the composed block.
  const extra = memberInstructions(
    { instructions: snapshot },
    { ...member, extraInstructions: "Be brief." },
  );
  assert.equal(
    editedInstructions(extra, member, { assignment: "Do it" }),
    memberInstructions(
      { instructions: snapshot },
      { ...member, assignment: "Do it", extraInstructions: "Be brief." },
    ),
  );
  // An owner-edited block is ambiguous: a fresh block goes before the lead's section.
  const owned = `Owner.\nRole: dev\nAssignment: Step one and more${extraSection("Be brief.")}`;
  assert.equal(
    editedInstructions(owned, member, { role: "ops" }),
    `Owner.\nRole: dev\nAssignment: Step one and more\n\nRole: ops\nAssignment: Step one\nStep two${extraSection("Be brief.")}`,
  );
});

test("replaced instructions stay out of records and lead views; the last five are kept", async (t) => {
  const f = await setup(t);
  for (let n = 0; n < 7; n++)
    await f.update({ instructions: `Version ${n} ${"x".repeat(5000)}` });
  const member = f.teams.member(f.member.id);
  assert.ok(JSON.stringify(member).length < 20000);
  assert.ok(!JSON.stringify(publicTeam(member)).includes("Version"));
  const kept = member.grantLog.filter((entry) => entry.replaced);
  assert.equal(kept.length, 5);
  assert.match(
    replacedInstructions(f.teams, member.id, kept.at(-1).replaced).text,
    /^Version 5 /,
  );
  const rows = f.teams.db
    .prepare(
      "SELECT COUNT(*) AS n FROM assistant_team_records WHERE kind='text' AND parent_id=?",
    )
    .get(member.id).n;
  assert.equal(rows, 5);
  assert.throws(() => replacedInstructions(f.teams, member.id, "unknown"), {
    status: 404,
  });
});

test("re-sending the extra section restores it after the owner removed it", async (t) => {
  const f = await setup(t);
  await f.update({ extraInstructions: "Cite sources." });
  const agent = f.agent();
  const without = agent.instructions.replace(/\n\n\[Additional[\s\S]*$/, "");
  f.store.updateAssistant(agent.id, { instructions: without }, agent.revision);
  const result = await f.update({ extraInstructions: "Cite sources." });
  assert.equal(result.status, "updated");
  assert.match(f.agent().instructions, /Cite sources\./);
});

test("a failed record write leaves the member's instructions as they were", async (t) => {
  const f = await setup(t);
  const before = f.agent();
  const write = f.teams.write.bind(f.teams);
  f.teams.write = () => {
    throw Object.assign(new Error("conflict"), { status: 409 });
  };
  await assert.rejects(f.update({ role: "Editor" }), { status: 409 });
  f.teams.write = write;
  assert.equal(f.agent().revision, before.revision);
  assert.equal(f.agent().instructions, before.instructions);
});
