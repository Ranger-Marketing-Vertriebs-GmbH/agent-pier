import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-team-"));
  const store = new AssistantStore({ dataDir });
  const teams = new TeamStore({ store });
  const ledger = new RequestLedger(store.db);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const parent = store.createAssistant({
    name: "Planner",
    instructions: "Plan carefully",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = store.saveConversation({
    assistantId: parent.id,
    runtimeSessionKey: "agent:parent:test",
  });
  const request = ledger.accept(chat.id, {
    clientRequestId: "owner",
    text: "Plan a team",
  });
  const attempt = ledger.recordAttempt(request.id);
  const input = {
    operationId: "tool1",
    parentAttemptId: attempt.id,
    objective: "Plan software",
    members: Array.from({ length: 4 }, (_, n) => ({
      name: `Member ${n}`,
      role: "Reviewer",
      assignment: `Review ${n}`,
    })),
    origin: { kind: "owner" },
  };
  return { store, teams, parent, chat, request, attempt, ledger, input, dataDir };
}
test("a proposal reserves nothing before approval and duplicate operations cannot create another team", (t) => {
  const f = fixture(t);
  const p = f.teams.propose(f.input);
  assert.equal(p.phase, "awaiting_approval");
  assert.equal(f.store.listAssistants().length, 1);
  assert.equal(f.teams.propose(f.input).id, p.id);
  assert.throws(() => f.teams.propose({ ...f.input, objective: "Different" }), {
    status: 409,
  });
  assert.throws(() => f.teams.reserve(p.id), { status: 409 });
  f.teams.decide(
    p.id,
    { revision: p.revision, decision: "approve", lifetime: "task" },
    { kind: "owner" },
  );
  const team = f.teams.reserve(p.id);
  assert.equal(team.memberIds.length, 4);
  assert.equal(f.store.listAssistants().length, 5);
  assert.equal(f.teams.reserve(p.id).memberIds.length, 4);
  assert.throws(() => f.teams.propose({ ...f.input, operationId: "other" }), {
    status: 409,
  });
  assert.throws(
    () =>
      f.teams.decide(
        p.id,
        { revision: p.revision, decision: "approve" },
        { kind: "owner" },
      ),
    { status: 409 },
  );
});
test("snapshots survive parent edits and task members cannot acquire delegation grants", (t) => {
  const f = fixture(t);
  f.teams.savePolicy(f.parent.id, { autonomous: true }, 1);
  const p = f.teams.propose(f.input);
  assert.equal(p.phase, "approved");
  const team = f.teams.reserve(p.id);
  const member = f.teams.member(team.memberIds[0]);
  const a = f.store.getAssistant(member.assistantId);
  f.store.updateAssistant(
    f.parent.id,
    { instructions: "Different", model: { connectionId: "x", modelId: "y" } },
    1,
  );
  assert.deepEqual(a.model, { connectionId: "c", modelId: "m" });
  assert.ok(a.instructions.includes("Plan carefully"));
  assert.deepEqual(a.serviceGrants, []);
  assert.equal(member.snapshot.parentRevision, 1);
  assert.throws(() => f.teams.savePolicy(a.id, { autonomous: true }, 1), { status: 409 });
  assert.throws(() => f.store.updateAssistant(a.id, { lifetime: "permanent" }, 1), {
    status: 400,
  });
  assert.throws(() => f.teams.promote(member.id, member.revision), { status: 409 });
});
test("fifth member and competing approvals do not allocate profiles or exceed parent capacity", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.teams.propose({ ...f.input, members: [...f.input.members, f.input.members[0]] }),
    { status: 400 },
  );
  const p = f.teams.propose(f.input);
  assert.throws(() => f.teams.propose({ ...f.input, operationId: "second" }), {
    status: 409,
  });
  assert.equal(f.store.listAssistants().length, 1);
  assert.throws(
    () => f.teams.decide(p.id, { revision: 1, decision: "approve" }, { kind: "model" }),
    { status: 403 },
  );
  f.teams.decide(p.id, { revision: 1, decision: "decline" }, { kind: "owner" });
  assert.equal(f.teams.get(p.id).phase, "declined");
});
test("one request authorization admits one proposal and rejects later policy revision edits", (t) => {
  const f = fixture(t);
  f.teams.recordContext(f.request.id, { kind: "owner", teamAllowed: true });
  const p = f.teams.propose(f.input);
  assert.equal(p.phase, "approved");
  f.teams.reserve(p.id);
  assert.throws(() => f.teams.savePolicy(f.parent.id, { maxMembers: 8 }, 0), {
    status: 409,
  });
  const saved = f.teams.savePolicy(f.parent.id, { maxMembers: 8 }, 1);
  assert.equal(saved.revision, 2);
  assert.throws(() => f.teams.saveSettings({ hostMaxConcurrent: 4 }, 1), { status: 409 });
});
test("completed member promotion and archive preserve identity and reject later active chat work", (t) => {
  const f = fixture(t);
  f.teams.savePolicy(f.parent.id, { autonomous: true }, 1);
  const p = f.teams.reserve(f.teams.propose(f.input).id);
  let m = f.teams.member(p.memberIds[0]);
  m = f.teams.setPhase(m.id, "queued", { phase: "completed" });
  const c = f.store.saveConversation({
    assistantId: m.assistantId,
    runtimeSessionKey: "agent:member:chat",
  });
  f.teams.setPhase(m.id, "completed", { conversationId: c.id });
  m = f.teams.member(m.id);
  assert.equal(f.store.getAssistant(m.assistantId).instructionsSource, undefined);
  const promoted = f.teams.promote(m.id, m.revision);
  assert.equal(promoted.lifetime, "permanent");
  // The team lead wrote these instructions; the owner must review them.
  let agent = f.store.getAssistant(m.assistantId);
  assert.equal(agent.instructionsSource, "model");
  agent = f.store.updateAssistant(agent.id, { name: "Renamed" }, agent.revision);
  assert.equal(agent.instructionsSource, "model", "unrelated edits confirm nothing");
  agent = f.store.updateAssistant(
    agent.id,
    { name: agent.name, instructions: agent.instructions, model: agent.model },
    agent.revision,
  );
  assert.equal(
    agent.instructionsSource,
    "model",
    "resaving unchanged text confirms nothing",
  );
  const edited = f.store.updateAssistant(
    agent.id,
    { instructions: `${agent.instructions}\nOwner edit.` },
    agent.revision,
  );
  assert.equal(edited.instructionsSource, "owner", "rewriting the text confirms");
  // Flag it again to exercise the explicit review action.
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...edited, instructionsSource: "model" }), edited.id);
  const confirmed = f.store.updateAssistant(
    agent.id,
    { confirmInstructions: true },
    edited.revision,
  );
  assert.equal(confirmed.instructionsSource, "owner", "an explicit review confirms");
  assert.equal("confirmInstructions" in confirmed, false);
  assert.equal(confirmed.instructions, edited.instructions);
  assert.throws(
    () => f.store.updateAssistant(agent.id, { confirmInstructions: false }, 1),
    { status: 400 },
  );
  const archived = f.teams.archive(m.id, promoted.revision);
  assert.ok(archived.archivedAt);
  const restored = f.teams.restore(m.id, archived.revision);
  assert.equal(restored.conversationId, c.id);
  assert.equal(restored.archivedAt, null);
  const r = f.ledger.accept(c.id, { clientRequestId: "new", text: "Continue" });
  f.ledger.recordAttempt(r.id);
  assert.throws(() => f.teams.archive(m.id, restored.revision), { status: 409 });
});
test("reopening an existing assistant database retains team mappings and decisions", (t) => {
  const f = fixture(t);
  const p = f.teams.propose(f.input);
  const second = new AssistantStore({ dataDir: f.dataDir });
  t.after(() => second.close());
  const teams = new TeamStore({ store: second });
  assert.equal(teams.get(p.id).parentAssistantId, f.parent.id);
  teams.decide(p.id, { revision: 1, decision: "decline" }, { kind: "owner" });
  assert.equal(f.teams.get(p.id).phase, "declined");
});
test("archiving and restoring a team updates member visibility without replacing definitions", (t) => {
  const f = fixture(t);
  f.teams.recordContext(f.request.id, { kind: "owner", teamAllowed: true });
  const team = f.teams.reserve(f.teams.propose(f.input).id);
  for (const m of f.teams.members(team.id)) f.teams.write(m, { phase: "completed" });
  const done = f.teams.write(f.teams.get(team.id), { phase: "completed" });
  const archived = f.teams.archive(team.id, done.revision);
  assert.ok(f.teams.members(team.id).every((m) => m.archivedAt));
  f.teams.restore(team.id, archived.revision);
  assert.ok(f.teams.members(team.id).every((m) => !m.archivedAt));
  assert.equal(f.store.listAssistants().length, 5);
});
test("an explicit owner request in plain words authorizes exactly one team", (t) => {
  const f = fixture(t);
  const turn = (id, text, context) => {
    const request = f.ledger.accept(f.chat.id, { clientRequestId: id, text });
    f.teams.recordContext(request.id, context);
    return f.ledger.recordAttempt(request.id);
  };
  const propose = (attempt, extra, operationId = "op") => {
    const p = f.teams.propose({
      ...f.input,
      origin: undefined,
      operationId,
      parentAttemptId: attempt.id,
      ...extra,
    });
    const phase = p.phase,
      authorization = p.authorization;
    if (p.phase === "approved") f.teams.write(p, { phase: "completed" });
    else f.teams.write(p, { phase: "declined" });
    return { phase, authorization };
  };
  const text = "Stell bitte ein Team zusammen,\n das die Release Notes prüft";
  const asked = { ownerRequestedTeam: true, ownerRequestQuote: "ein team ZUSAMMEN, das" };
  const owner = turn("plain", text, { kind: "owner", teamAllowed: false });
  const first = propose(owner, asked, "first");
  assert.equal(first.phase, "approved");
  assert.deepEqual(first.authorization, {
    kind: "task",
    requestId: f.ledger.getAttempt(owner.id).requestId,
    source: "ownerRequest",
    ownerRequestQuote: "ein team ZUSAMMEN, das",
  });
  assert.equal(propose(owner, asked, "second").phase, "awaiting_approval");
  assert.equal(f.teams.policy(f.parent.id).autonomous, false);
  assert.equal(f.teams.policy(f.parent.id).revision, 1);
  const quote = (ownerRequestQuote) => ({ ownerRequestedTeam: true, ownerRequestQuote });
  const cases = [
    [{ kind: "owner" }, quote("Release Notes schreiben")],
    [{ kind: "owner" }, quote("bitte")],
    [{ kind: "owner" }, quote("ein Team")],
    [{ kind: "owner" }, quote("bitte"), "Fass die Seite bitte zusammen"],
    [{ kind: "owner" }, quote("das die Release Notes")],
    [{ kind: "owner" }, { ownerRequestedTeam: false, ownerRequestQuote: "ein Team" }],
    [
      { kind: "owner" },
      { ownerRequestedTeam: false, ownerRequestQuote: "x".repeat(301) },
    ],
    [{ kind: "owner" }, { ownerRequestedTeam: true }],
    [{ kind: "telegram", forwarded: true }, asked],
    [{ kind: "scheduled" }, asked],
    [{ kind: "team-member", teamId: "t", memberId: "m" }, asked],
    [{ kind: "team-result", teamId: "t" }, asked],
    [{ kind: "unknown" }, { ...asked, origin: { kind: "owner" } }],
  ];
  for (const [n, [context, extra, said = text]] of cases.entries())
    assert.equal(
      propose(turn(`case-${n}`, said, { ...context, teamAllowed: false }), extra).phase,
      "awaiting_approval",
      JSON.stringify([context, extra.ownerRequestQuote?.slice(0, 30)]),
    );
  const compound = turn("compound", "Bau mir ein Rechercheteam für X", {
    kind: "owner",
    teamAllowed: false,
  });
  assert.equal(propose(compound, quote("Bau mir ein Rechercheteam")).phase, "approved");
  const voice = turn("voice", "Bau ein Team, das die Rechnungen sortiert", {
    kind: "telegram",
    forwarded: false,
    teamAllowed: false,
  });
  assert.equal(propose(voice, quote("Bau ein Team")).phase, "approved");
  const command = turn("command", "/team Review", { kind: "owner", teamAllowed: true });
  assert.equal(propose(command, {}).authorization.source, "command");
  const box = turn("checkbox", "Review", { kind: "owner", teamAllowed: true });
  assert.equal(propose(box, quote("x".repeat(30))).authorization.source, "checkbox");
  // An unusable quote is ignored: the proposal asks for approval instead of failing.
  assert.equal(
    f.teams.propose({
      ...f.input,
      operationId: "long",
      ...asked,
      ownerRequestQuote: "x".repeat(301),
    }).phase,
    "awaiting_approval",
  );
});
