import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { publicTeam } from "../../server/features/assistants/team-service.js";
import { memberOverrides } from "../../server/features/assistants/team-presentation.js";

const usable = { local: { connection: "Local", models: { qwen: "Qwen" } } };

// A team fixture whose models resolve like AssistantModels: a lease or a refusal.
function setup(t) {
  const f = teamFixture(t);
  const leases = { taken: 0, released: 0 };
  f.assistants.models.resolve = async ({ connectionId, modelId }) => {
    // The lead's own model stays usable, as in every other team test.
    if (connectionId === "c") return { display: {}, release() {} };
    const model = usable[connectionId]?.models[modelId];
    if (!model) throw assistantProblem("provider");
    leases.taken++;
    return {
      display: { connection: usable[connectionId].connection, model },
      release: () => leases.released++,
    };
  };
  return { ...f, leases };
}

const qwen = { connectionId: "local", modelId: "qwen" };
const member = (name, extra = {}) => ({
  name,
  role: "Review",
  assignment: `Review as ${name}`,
  ...extra,
});

test("a lead gives one new member its own model; the other follows the lead", async (t) => {
  const f = setup(t);
  const { team, parent } = await f.proposal({
    members: [member("Quinn", { model: qwen }), member("Lee")],
  });
  assert.equal(team.phase, "queued");
  // The owner reads the chosen model by its names on the proposal.
  const shown = publicTeam(team).members;
  assert.deepEqual(shown[0].model, qwen);
  assert.deepEqual(shown[0].modelLabel, { connection: "Local", model: "Qwen" });
  assert.equal(shown[1].model, undefined);
  const [own, follows] = f.service.store.members(team.id);
  const quinn = f.store.getAssistant(own.assistantId);
  assert.deepEqual(quinn.model, qwen);
  assert.equal(quinn.ownModel, true);
  // The lead's choice is the member's baseline, not an owner override.
  assert.deepEqual(own.leadModel, qwen);
  assert.equal(memberOverrides(own, quinn).model, false);
  const lee = f.store.getAssistant(follows.assistantId);
  assert.equal(lee.ownModel, undefined);
  assert.equal(follows.leadModel, undefined);
  assert.deepEqual(lee.model, parent.model);
  // A later lead model change moves only the member that follows it.
  const lead = f.store.getAssistant(parent.id);
  const next = { connectionId: "c", modelId: "other" };
  f.store.updateAssistant(parent.id, { model: next }, lead.revision);
  assert.deepEqual(f.store.getAssistant(own.assistantId).model, qwen);
  assert.deepEqual(f.store.getAssistant(follows.assistantId).model, next);
  assert.equal(f.leases.taken, f.leases.released);
});

test("an unusable or malformed model rejects the whole proposal before storing it", async (t) => {
  const f = setup(t);
  const before = f.store.listAssistants().length;
  for (const model of [
    { connectionId: "local", modelId: "missing" },
    { connectionId: "gone", modelId: "qwen" },
  ])
    await assert.rejects(
      f.proposal({ members: [member("Lee"), member("Quinn", { model })] }),
      { key: "provider" },
    );
  for (const model of [
    { connectionId: "local" },
    { connectionId: "local", modelId: 7 },
    { ...qwen, extra: true },
    { connectionId: "x".repeat(201), modelId: "qwen" },
    "local/qwen",
    null,
  ])
    await assert.rejects(f.proposal({ members: [member("Quinn", { model })] }), {
      status: 400,
    });
  assert.equal(f.service.store.list().length, 0);
  // Only the parents the fixture created for each attempt; no member.
  const agents = f.store.listAssistants();
  assert.equal(agents.length - before, 8);
  assert.ok(agents.every((a) => !a.teamMemberId));
});

test("the model belongs to the proposal; the lead cannot set its label", async (t) => {
  const f = setup(t);
  const forged = { connection: "Free", model: "Cheap" };
  const { team, attempt } = await f.proposal({
    allowed: false,
    members: [member("Quinn", { model: qwen, modelLabel: forged }), member("Lee")],
  });
  assert.equal(team.phase, "awaiting_approval");
  assert.deepEqual(team.members[0].modelLabel, { connection: "Local", model: "Qwen" });
  // A forged label without a model is dropped as well.
  assert.equal(team.members[1].modelLabel, undefined);
  const retry = (members) =>
    f.service.propose(
      { attemptId: attempt.id, toolCallId: "call", assertCurrent() {} },
      { objective: "Review", members },
    );
  const same = await retry([member("Quinn", { model: { ...qwen } }), member("Lee")]);
  assert.equal(same.id, team.id);
  // Another model, or none, is another proposal under the same call.
  await assert.rejects(retry([member("Quinn"), member("Lee")]), { status: 409 });
  usable.local.models.llama = "Llama";
  t.after(() => delete usable.local.models.llama);
  await assert.rejects(
    retry([member("Quinn", { model: { ...qwen, modelId: "llama" } }), member("Lee")]),
    { status: 409 },
  );
});
