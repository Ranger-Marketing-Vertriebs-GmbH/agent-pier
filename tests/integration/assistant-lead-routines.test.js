import test from "node:test";
import assert from "node:assert/strict";
import { leadRoutineFixture as setup } from "../helpers/lead-routine-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const code = (key) => (error) => toolError(error).code === key;
const routineAudits = (f) => f.audits.filter((e) => e.details?.kind === "lead-routine");

test("a lead sets up, lists, edits, pauses and removes a routine on its permanent member", async (t) => {
  const f = await setup(t);
  const created = await f.create();
  assert.equal(created.member, "Member 1");
  assert.equal(created.memberId, f.permanent.id);
  assert.equal(created.mayWrite, false, "read-only by default");
  // Stored as the member's own routine with its provenance, run on the member.
  const binding = f.routines.bindings.get(created.id);
  assert.equal(binding.assistantId, f.member.id);
  assert.equal(binding.createdBy, "lead");
  assert.equal(binding.leadId, f.parent.id);
  assert.equal(binding.leadMemberId, f.permanent.id);
  const job = f.jobs.get(binding.nativeId);
  assert.equal(job.agentId, f.member.runtimeAgentId);
  assert.match(job.payload.message, /your lead agent set up for you/);
  assert.match(job.payload.message, /NO_REPLY/);
  // The owner sees who set it up in the member's settings.
  const [owned] = (await f.routines.list(f.member.id)).routines;
  assert.deepEqual(owned.createdBy, {
    kind: "lead",
    leadId: f.parent.id,
    leadName: f.parent.name,
  });
  const listed = await f.tool("list");
  assert.deepEqual(
    listed.routines.map((r) => [r.id, r.member, r.name]),
    [[created.id, "Member 1", "Inbox check"]],
  );
  // Edit name, task and schedule in place, then pause and resume.
  const edited = await f.tool("update", {
    id: created.id,
    revision: created.revision,
    name: "Morning inbox",
    prompt: "Report only urgent requests.",
    trigger: { kind: "cron", expr: "*/30 8-18 * * 1-5", tz: "Europe/Berlin" },
  });
  assert.equal(edited.name, "Morning inbox");
  assert.equal(f.jobs.get(binding.nativeId).name, "Morning inbox");
  assert.equal(f.jobs.get(binding.nativeId).schedule.expr, "*/30 8-18 * * 1-5");
  assert.match(f.jobs.get(binding.nativeId).payload.message, /Report only urgent/);
  const paused = await f.tool("update", {
    id: created.id,
    revision: edited.revision,
    enabled: false,
  });
  assert.equal(paused.enabled, false);
  assert.equal(f.jobs.get(binding.nativeId).enabled, false);
  const resumed = await f.tool("update", {
    id: created.id,
    revision: paused.revision,
    enabled: true,
  });
  assert.equal(resumed.enabled, true);
  // A stale revision conflicts.
  await assert.rejects(
    f.tool("update", { id: created.id, revision: paused.revision, enabled: false }),
    code("CONFLICT"),
  );
  assert.deepEqual(await f.tool("remove", { id: created.id }), { removed: true });
  assert.equal(f.jobs.size, 0);
  assert.deepEqual((await f.tool("list")).routines, []);
  assert.deepEqual(
    routineAudits(f).map((e) => [e.resourceId, e.details.change, e.details.by]),
    [
      [f.member.id, "create", "lead"],
      [f.member.id, "update", "lead"],
      [f.member.id, "update", "lead"],
      [f.member.id, "update", "lead"],
      [f.member.id, "remove", "lead"],
    ],
  );
  assert.deepEqual(routineAudits(f)[1].details.edited, ["name", "prompt", "trigger"]);
});

test("only the lead's own permanent members, in the owner's own turn", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.create({ memberId: f.temporary.id }),
    code("ROUTINE_MEMBER_NOT_PERMANENT"),
  );
  await assert.rejects(f.create({ memberId: "someone-else" }), code("NOT_FOUND"));
  for (const context of [
    { kind: "owner", forwarded: true },
    { kind: "member-result", requestId: "r" },
    { kind: "routine" },
  ])
    await assert.rejects(
      f.create({}, f.turn("Please set up a routine on Member 1", context)),
      code("ROUTINE_OWNER_TURN"),
      context.kind,
    );
  // Another lead never reaches this member or its routines.
  const created = await f.create();
  const other = f.store.createAssistant({
    name: "Other lead",
    instructions: "Other",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: `other-${other.id}`,
  });
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Set up a routine on Member 1",
  });
  f.service.store.recordContext(request.id, { kind: "owner" });
  const inv = {
    attemptId: f.assistants.ledger.recordAttempt(request.id).id,
    toolCallId: crypto.randomUUID(),
    assertCurrent() {},
  };
  await assert.rejects(
    f.tool(
      "create",
      {
        memberId: f.permanent.id,
        name: "X",
        prompt: "Y",
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      },
      inv,
    ),
    code("NOT_FOUND"),
  );
  await assert.rejects(f.tool("remove", { id: created.id }, inv), code("NOT_FOUND"));
  assert.deepEqual((await f.tool("list", {}, inv)).routines, []);
  // A member with routines switched off is refused.
  const member = f.store.getAssistant(f.member.id);
  f.store.updateAssistant(
    member.id,
    { capabilities: { ...member.capabilities, reminders: false } },
    member.revision,
  );
  await assert.rejects(f.create(), code("ROUTINE_MEMBER_OFF"));
});

test("schedules are checked like the agent's own routines, with a minimum interval and a cap", async (t) => {
  const f = await setup(t);
  for (const [trigger, expected] of [
    [{ kind: "cron", expr: "*/5 * * * *", tz: "UTC" }, "ROUTINE_TOO_FREQUENT"],
    [{ kind: "cron", expr: "0,10 9 * * *", tz: "UTC" }, "ROUTINE_TOO_FREQUENT"],
    [{ kind: "cron", expr: "0 9 * * * *", tz: "UTC" }, "INVALID_INPUT"],
    [{ kind: "cron", expr: "0 9 * * *", tz: "Not/AZone" }, "INVALID_INPUT"],
    [{ kind: "at", at: "2030-01-01T09:00" }, "INVALID_TIME"],
    [{ kind: "event", eventKind: "manual" }, "INVALID_INPUT"],
  ])
    await assert.rejects(f.create({ trigger }), code(expected), JSON.stringify(trigger));
  // The lead never sets the owner's "May write".
  await assert.rejects(f.create({ writes: true }), code("INVALID_INPUT"));
  await f.create({ trigger: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" } });
  await f.create({ trigger: { kind: "at", at: "2030-01-01T09:00:00+01:00" } });
  for (let n = 0; n < 3; n++) await f.create({ name: `Check ${n}` });
  await assert.rejects(f.create({ name: "One more" }), code("ROUTINE_MEMBER_LIMIT"));
});

test("at 'On request' the owner's own message must name the member", async (t) => {
  const f = await setup(t);
  const policy = f.service.store.policy(f.parent.id);
  f.service.store.savePolicy(f.parent.id, { usage: "onRequest" }, policy.revision);
  await assert.rejects(
    f.create({}, f.turn("Set up a daily inbox check")),
    code("ROUTINE_NOT_REQUESTED"),
  );
  const created = await f.create({}, f.turn("Let Member 1 check the inbox every day"));
  assert.equal(created.member, "Member 1");
});

test("a lead routine writes only with the owner's switch or an autonomous lead", async (t) => {
  const f = await setup(t);
  const created = await f.create();
  const binding = () => f.routines.bindings.get(created.id);
  assert.equal(f.routines.writable(binding()), false);
  // The owner's switch in the member's routine settings.
  const owner = await f.routines.update(f.member.id, created.id, {
    writes: true,
    revision: created.revision,
  });
  assert.equal(owner.writes, true);
  assert.equal(f.routines.writable(binding()), true);
  assert.equal((await f.tool("list")).routines[0].mayWrite, true);
  await f.routines.update(f.member.id, created.id, {
    writes: false,
    revision: owner.revision,
  });
  assert.equal(f.routines.writable(binding()), false);
  // Autonomous team usage counts as the owner's standing permission, read live.
  const policy = f.service.store.policy(f.parent.id);
  f.service.store.savePolicy(f.parent.id, { usage: "autonomous" }, policy.revision);
  assert.equal(f.routines.writable(binding()), true);
  assert.equal(f.routines.lead.writeReason(binding()), "autonomous");
});
