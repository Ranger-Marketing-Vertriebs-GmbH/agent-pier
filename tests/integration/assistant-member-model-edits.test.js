import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { MemberEdits } from "../../server/features/assistants/member-edits.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import { memberOverrides } from "../../server/features/assistants/team-presentation.js";
import { validateMemberModel } from "../../server/features/assistants/member-models.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

const usable = {
  local: { connection: "Local", models: { qwen: "Qwen", llama: "Llama" } },
  test: { connection: "Test", models: { fixture: "Fixture" } },
};

// Models like AssistantModels.resolve: a lease for a usable model, else a refusal.
function models() {
  const leases = { taken: 0, released: 0 };
  return {
    leases,
    async resolve({ connectionId, modelId }) {
      const model = usable[connectionId]?.models[modelId];
      if (!model) throw assistantProblem("provider");
      leases.taken++;
      return {
        display: { connection: usable[connectionId].connection, model },
        release: () => leases.released++,
      };
    },
  };
}

async function setup(t) {
  const f = await memberGrantFixture(t);
  f.assistants.models = models();
  const edits = new MemberEdits({
    teams: f.teams,
    assistants: f.assistants,
    audit: f.services.audit,
  });
  const update = async (input) =>
    edits.update(await f.invocation(randomUUID()), { memberId: f.member.id, ...input });
  const notes = () => [
    ...actionNotes(f.workflows.store.list(f.member.assistantId), f.memberChat.id),
    ...actionNotes(
      f.workflows.store.list(f.channel.assistantId),
      f.channel.conversationId,
    ),
  ];
  return { ...f, update, notes };
}

const qwen = { connectionId: "local", modelId: "qwen" };

test("a lead moves its permanent member to another model; the next turn runs on it", async (t) => {
  const f = await setup(t);
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  const kept = f.teams.member(f.member.id);
  f.teams.promote(kept.id, kept.revision);
  const before = f.agent();
  const result = await f.update({ model: qwen, role: "Reviewer" });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.changed, ["role", "model"]);
  const agent = f.agent();
  assert.deepEqual(agent.model, qwen);
  assert.equal(agent.revision, before.revision + 1);
  const member = f.teams.member(f.member.id);
  assert.deepEqual(member.leadModel, qwen);
  // The lead's assignment is the baseline, not an owner override.
  assert.equal(memberOverrides(member, agent).model, false);
  const entry = member.grantLog.at(-1);
  assert.deepEqual(entry.edited, ["role", "model"]);
  assert.deepEqual(entry.model, {
    from: { connection: "Test", model: "Fixture" },
    to: { connection: "Local", model: "Qwen" },
  });
  const notes = f.notes();
  assert.equal(notes.length, 2);
  for (const note of notes)
    assert.deepEqual(note.model, {
      from: { connection: "Test", model: "Fixture" },
      to: { connection: "Local", model: "Qwen" },
    });
  const audit = f.audits.at(-1);
  assert.deepEqual(audit.details.edited, ["role", "model"]);
  assert.deepEqual(audit.details.models, { from: before.model, to: qwen });
  assert.ok(!JSON.stringify(audit).includes("Qwen"));
  // Every lease taken for the check is given back.
  assert.equal(f.assistants.models.leases.taken, f.assistants.models.leases.released);
  // An owner change after it is an override again.
  const now = f.agent();
  f.store.updateAssistant(
    now.id,
    { model: { connectionId: "local", modelId: "llama" } },
    now.revision,
  );
  assert.equal(memberOverrides(f.teams.member(f.member.id), f.agent()).model, true);
});

test("a lead gives a task member its own model; a later lead model change leaves it", async (t) => {
  const f = await setup(t);
  assert.equal(f.agent().ownModel, undefined);
  await f.update({ model: qwen });
  const agent = f.agent();
  assert.deepEqual(agent.model, qwen);
  assert.equal(agent.ownModel, true);
  assert.equal(memberOverrides(f.teams.member(f.member.id), agent).model, false);
  const lead = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    lead.id,
    { model: { connectionId: "local", modelId: "llama" } },
    lead.revision,
  );
  assert.deepEqual(f.agent().model, qwen);
});

test("an unusable model is refused; nothing is stored and no note is written", async (t) => {
  const f = await setup(t);
  const before = f.agent();
  for (const model of [
    { connectionId: "local", modelId: "missing" },
    { connectionId: "gone", modelId: "qwen" },
  ])
    await assert.rejects(f.update({ model, role: "Reviewer" }), { key: "provider" });
  for (const model of [
    { connectionId: "local" },
    { connectionId: "local", modelId: 7 },
    { connectionId: "local", modelId: "qwen", extra: true },
    { connectionId: "x".repeat(201), modelId: "qwen" },
    "local/qwen",
  ])
    await assert.rejects(f.update({ model }), { status: 400 });
  const agent = f.agent();
  assert.equal(agent.revision, before.revision);
  assert.deepEqual(agent.model, before.model);
  assert.equal(f.teams.member(f.member.id).leadModel, undefined);
  assert.equal(f.teams.member(f.member.id).role, "Research");
  assert.equal(f.notes().length, 0);
});

test("the same model again is unchanged", async (t) => {
  const f = await setup(t);
  await f.update({ model: qwen });
  const revision = f.agent().revision;
  const result = await f.update({ model: { ...qwen } });
  assert.equal(result.status, "unchanged");
  assert.equal(f.agent().revision, revision);
  assert.equal(f.notes().length, 2);
});

test("validateMemberModel names the model and gives its lease back", async () => {
  const m = models();
  assert.deepEqual(await validateMemberModel(m, qwen), {
    ...qwen,
    display: { connection: "Local", model: "Qwen" },
  });
  assert.deepEqual(m.leases, { taken: 1, released: 1 });
  await assert.rejects(validateMemberModel(m, { connectionId: "local", modelId: "x" }), {
    key: "provider",
  });
  // An unknown connection (a plain 404 from the connections) is refused alike.
  const gone = {
    resolve: async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    },
  };
  await assert.rejects(validateMemberModel(gone, qwen), { key: "provider" });
});
