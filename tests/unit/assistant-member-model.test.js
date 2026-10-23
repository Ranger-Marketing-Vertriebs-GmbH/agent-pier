import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import {
  effectiveModel,
  memberOverrides,
} from "../../server/features/assistants/team-presentation.js";

const first = { connectionId: "c", modelId: "m" },
  second = { connectionId: "x", modelId: "y" },
  third = { connectionId: "z", modelId: "w" };

function fixture(t, lifetime = "task") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-member-model-"));
  const store = new AssistantStore({ dataDir });
  const teams = new TeamStore({ store });
  const ledger = new RequestLedger(store.db);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const lead = store.createAssistant({
    name: "Lead",
    instructions: "Plan",
    model: first,
  });
  const chat = store.saveConversation({
    assistantId: lead.id,
    runtimeSessionKey: "agent:lead:test",
  });
  const request = ledger.accept(chat.id, { clientRequestId: "owner", text: "Team" });
  const attempt = ledger.recordAttempt(request.id);
  const proposal = teams.propose({
    operationId: "tool",
    parentAttemptId: attempt.id,
    objective: "Review",
    members: [{ name: "Scout", role: "Research", assignment: "Look around" }],
    origin: { kind: "owner" },
  });
  teams.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve", lifetime },
    { kind: "owner" },
  );
  const team = teams.reserve(proposal.id);
  const member = teams.member(team.memberIds[0]);
  const setLeadModel = (model) => {
    const current = store.getAssistant(lead.id);
    store.updateAssistant(lead.id, { model }, current.revision);
  };
  const finish = () => teams.setPhase(member.id, "queued", { phase: "completed" });
  return { store, teams, lead, member, setLeadModel, finish };
}

test("effectiveModel gives a temporary member its lead's model and leaves others alone", () => {
  const lead = { id: "lead", model: second };
  const task = { teamMemberId: "m", lifetime: "task", model: first };
  assert.deepEqual(effectiveModel(task, lead), second);
  assert.deepEqual(effectiveModel({ ...task, lifetime: "permanent" }, lead), first);
  assert.deepEqual(effectiveModel({ model: first }, lead), first);
  // Without a readable lead the member keeps the model it was created with.
  assert.deepEqual(effectiveModel(task, undefined), first);
});

test("a temporary member runs on its lead's current model", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.getAssistant(f.member.assistantId).model, first);
  f.setLeadModel(second);
  assert.deepEqual(f.store.getAssistant(f.member.assistantId).model, second);
  const listed = f.store.listAssistants().find((a) => a.id === f.member.assistantId);
  assert.deepEqual(listed.model, second);
  // The member's own revision does not change: nothing of its own was edited.
  assert.equal(f.store.getAssistant(f.member.assistantId).revision, 1);
});

test("a permanent member keeps its own model when the lead's model changes", (t) => {
  const f = fixture(t, "permanent");
  f.setLeadModel(second);
  assert.deepEqual(f.store.getAssistant(f.member.assistantId).model, first);
  assert.deepEqual(
    f.store.listAssistants().find((a) => a.id === f.member.assistantId).model,
    first,
  );
});

test("promotion freezes the lead's model of that moment into the member", (t) => {
  const f = fixture(t);
  f.setLeadModel(second);
  const done = f.finish();
  f.teams.promote(f.member.id, done.revision);
  f.setLeadModel(third);
  const agent = f.store.getAssistant(f.member.assistantId);
  assert.equal(agent.lifetime, "permanent");
  assert.deepEqual(agent.model, second);
  // The frozen model is the reference for "changed": nothing changed yet.
  const promoted = f.teams.member(f.member.id);
  assert.deepEqual(promoted.snapshot.model, second);
  assert.equal(memberOverrides(promoted, agent).model, false);
  const edited = f.store.updateAssistant(agent.id, { model: first }, agent.revision);
  assert.equal(memberOverrides(promoted, edited).model, true);
});

test("a temporary member that follows its lead reports no model override", (t) => {
  const f = fixture(t);
  f.setLeadModel(second);
  const task = f.store.getAssistant(f.member.assistantId);
  const overrides = memberOverrides(f.teams.member(f.member.id), task);
  assert.equal("model" in overrides, false);
  assert.equal(overrides.instructions, false);
});

test("effectiveModel keeps a temporary member's own model", () => {
  const lead = { id: "lead", model: second };
  const task = { teamMemberId: "m", lifetime: "task", model: first, ownModel: true };
  assert.deepEqual(effectiveModel(task, lead), first);
});

test("a lead-assigned model is not an owner override", () => {
  const member = {
    snapshot: { model: first, instructions: "Plan" },
    role: "Research",
    assignment: "Look around",
    leadModel: second,
  };
  const task = {
    teamMemberId: "m",
    lifetime: "task",
    model: second,
    ownModel: true,
    instructions: "Plan\n\nRole: Research\nAssignment: Look around",
  };
  assert.deepEqual(memberOverrides(member, task), { model: false, instructions: false });
  assert.equal(memberOverrides(member, { ...task, model: third }).model, true);
  // A permanent member compares against the lead's assignment too.
  const kept = { ...task, lifetime: "permanent" };
  assert.equal(memberOverrides(member, kept).model, false);
  assert.equal(memberOverrides({ ...member, leadModel: undefined }, kept).model, true);
});

test("the store marks a temporary member's model as its own only when one is set", (t) => {
  const f = fixture(t);
  const id = f.member.assistantId;
  // An unrelated edit writes the effective model back but does not make it own.
  f.setLeadModel(second);
  const renamed = f.store.updateAssistant(id, { name: "Scout 2" }, 1);
  assert.equal(renamed.ownModel, undefined);
  f.setLeadModel(third);
  assert.deepEqual(f.store.getAssistant(id).model, third);
  const own = f.store.updateAssistant(id, { model: first }, renamed.revision);
  assert.equal(own.ownModel, true);
  f.setLeadModel(second);
  assert.deepEqual(f.store.getAssistant(id).model, first);
  const back = f.store.updateAssistant(id, {}, own.revision, { followLead: true });
  assert.equal(back.ownModel, undefined);
  assert.deepEqual(f.store.getAssistant(id).model, second);
});
