import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { TeamResults } from "../../server/features/assistants/team-results.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { profileTools } from "../../server/features/assistants/native-capabilities.js";

// A parent with project access whose approved team has one running member turn.
async function setup(t, { origin = { kind: "owner" }, autonomous = false } = {}) {
  const f = await workflowFixture(t);
  const teams = new TeamStore({ store: f.store });
  f.assistants.teams = { store: teams };
  f.workflows.access.save(f.id, { ...f.policy, autonomous }, 0);
  const parentRequest = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team that fixes the build",
  });
  teams.recordContext(parentRequest.id, {
    ...(typeof origin === "function" ? origin(f) : origin),
    teamAllowed: true,
  });
  const parentAttempt = f.assistants.ledger.recordAttempt(parentRequest.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: parentAttempt.id,
    objective: "Fix the build",
    members: [{ name: "Coder", role: "Developer", assignment: "Fix the build" }],
  });
  f.assistants.ledger.transition(parentAttempt.id, "completed");
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const memberChat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: memberChat.id, phase: "running" });
  const sends = [],
    send = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    sends.push({ id, input, context });
    return send(id, input, context);
  };
  const context = { kind: "team-member", teamId: proposed.id, memberId: member.id };
  const turn = await f.assistants.send(
    memberChat.id,
    { clientRequestId: "assignment", text: member.assignment },
    context,
  );
  teams.recordContext(turn.request.id, context);
  const inv = (toolCallId = randomUUID()) => ({
    attemptId: turn.attempt.id,
    toolCallId,
    assertCurrent() {},
  });
  const request = (invocation = inv(), extra = {}) =>
    f.workflows.invoke(invocation, {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Fix the failing build",
      ...extra,
    });
  return {
    ...f,
    teams,
    team: teams.get(proposed.id),
    member,
    memberChat,
    turn,
    inv,
    request,
    sends,
  };
}
const approve = (f, a, origin = { kind: "owner", channel: "ui" }) =>
  f.workflows.decide(a.id, { revision: a.revision, decision: "approve" }, origin);

test("member coding requests on a parent grant always await an exact owner approval", async (t) => {
  const f = await setup(t, { autonomous: true });
  const a = await f.request();
  assert.equal(a.state, "awaiting_approval");
  assert.equal(a.assistantId, f.id);
  assert.equal(a.requestedBy, f.member.id);
  assert.equal(a.onBehalfOf, f.id);
  assert.equal(a.teamId, f.team.id);
  assert.equal(a.memberName, "Coder");
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.workflows.get(a.id).state, "awaiting_approval");
  assert.ok(f.workflows.list(f.id).actions.some((x) => x.id === a.id));
  // Only coding requests and their status are open to members.
  for (const action of ["catalog", "actions", "memory_search", "memory_read"])
    await assert.rejects(
      f.workflows.invoke(f.inv(), { action, projectId: f.project.id, id: "x" }),
      { status: 403 },
    );
  await assert.rejects(
    f.workflows.invoke(f.inv(), {
      action: "memory_write",
      projectId: f.project.id,
      title: "Note",
      content: "Text",
    }),
    { status: 403 },
  );
  await assert.rejects(
    f.workflows.invoke(f.inv(), { action: "coding_cancel", id: a.id }),
    { status: 403 },
  );
});

test("a project the parent was not granted is refused without an action", async (t) => {
  const f = await setup(t);
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 1);
  await assert.rejects(f.request(), { status: 403 });
  assert.equal(f.workflows.store.list().length, 0);
});

test("a grant revoked between request and approval fails closed without a start", async (t) => {
  const f = await setup(t);
  const before = await f.request();
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 1);
  await assert.rejects(approve(f, before), { status: 403 });
  assert.equal(f.workflows.get(before.id).state, "failed");
  assert.equal(f.workflows.get(before.id).diagnostic, "GRANT_REVOKED");
  f.workflows.access.save(f.id, f.policy, 2);
  const after = await f.request();
  await approve(f, after);
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 3);
  await f.workflows.tick();
  assert.equal(f.workflows.get(after.id).state, "failed");
  assert.equal(f.workflows.get(after.id).diagnostic, "GRANT_REVOKED");
  f.workflows.access.save(f.id, f.policy, 4);
  const changed = await f.request();
  await approve(f, changed);
  f.profile.revision++;
  await f.workflows.tick();
  assert.equal(f.workflows.get(changed.id).diagnostic, "GRANT_REVOKED");
  assert.equal(f.starts.length, 0);
});

test("Telegram approves a member request only from the parent's exact chat", async (t) => {
  // A team started in AgentPier notifies the parent's bound Telegram chat.
  const f = await setup(t);
  const target = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  const audit = [];
  f.services.audit.append = (record) => audit.push(record);
  const a = await f.request();
  const notice = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.kind === "action-approval");
  assert.ok(notice.text.includes("Coder"));
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return { message_id: sends.length, chat: { id: 42 } };
  };
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  const handle = sends[0].input.reply_markup.inline_keyboard[0][0].callback_data;
  const update = (user) => ({
    update_id: 2,
    callback_query: {
      id: "callback",
      data: handle,
      from: { id: user, is_bot: false },
      message: { message_id: 1, chat: { id: 42, type: "private" } },
    },
  });
  await assert.rejects(approve(f, a, { ...target, chatId: "43" }), { status: 403 });
  await f.service.teamActions.receive(f.channel.id, update(43));
  assert.equal(f.workflows.get(a.id).state, "awaiting_approval");
  await f.service.teamActions.receive(f.channel.id, update(42));
  assert.equal(f.workflows.get(a.id).state, "approved");
  await f.workflows.tick();
  assert.equal(f.starts.length, 1);
  // Every decision on the member's request is audited against the parent.
  const decided = audit.filter((r) => r.details.actionId === a.id);
  assert.deepEqual(
    decided.map((r) => [r.outcome, r.details.channel, r.resourceId]),
    [
      ["failure", "telegram", f.id],
      ["success", "telegram", f.id],
    ],
  );
});

test("Telegram member approvals follow a Telegram-started team and link to its task", async (t) => {
  const f = await setup(t, {
    origin: (f) => ({
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    }),
  });
  const c = f.service.store.get(f.channel.id);
  f.service.store.write({ ...c, appUrl: "https://pier.example" }, c.revision);
  const a = await f.request();
  const notice = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.kind === "action-approval");
  assert.equal(notice.source.actionId, a.id);
  assert.equal(notice.chatId, "42");
  assert.equal(notice.link.url, `https://pier.example/agents/${f.id}/teams/${f.team.id}`);
  await approve(f, a, {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  });
  assert.equal(f.workflows.get(a.id).state, "approved");
});

test("pending and running member requests never hold the team open; outcomes follow up", async (t) => {
  const f = await setup(t);
  let emitted = 0;
  f.services.assistantRoutines = {
    emit: async () => {
      emitted++;
      return [];
    },
  };
  const a = await f.request();
  await approve(f, a);
  await f.workflows.tick();
  const running = f.workflows.get(a.id);
  assert.equal(running.state, "running");
  // Members can follow their own request.
  const status = await f.workflows.invoke(f.inv(), { action: "coding_status", id: a.id });
  assert.equal(status.run.id, running.runId);
  const uncertain = await f.request();
  f.workflows.store.patch(uncertain.id, { state: "unknown" });
  f.assistants.ledger.transition(f.turn.attempt.id, "completed");
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  const results = new TeamResults({ teams: f.teams, assistants: f.assistants });
  await results.collect(f.team.id);
  const team = f.teams.get(f.team.id);
  assert.equal(team.phase, "completed");
  const runs = team.resultBatch[0].codingRuns;
  assert.deepEqual(
    runs.map((r) => [r.actionId, r.state, r.pending, r.runId]),
    [
      [a.id, "running", true, running.runId],
      [uncertain.id, "unknown", true, undefined],
    ],
  );
  await results.dispatch(f.team.id);
  const synthesis = f.sends.find((s) =>
    s.input.clientRequestId.startsWith("team-result:"),
  );
  assert.ok(synthesis.input.text.includes(running.runId));
  assert.match(synthesis.input.text, /Still pending: Coder: /);
  // The parent can start another team while the run continues.
  assert.ok(f.teams.list(f.id).every((x) => x.phase !== "running"));
  f.runs.get(running.runId).status = "completed";
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "completed");
  const member = f.sends.filter(
    (s) => s.input.clientRequestId === `coding-result:${a.id}`,
  );
  assert.equal(member.length, 1);
  assert.equal(member[0].id, f.memberChat.id);
  assert.equal(member[0].context.kind, "coding-result");
  assert.ok(member[0].input.text.includes(running.runId));
  const parent = f.sends.filter(
    (s) => s.input.clientRequestId === `coding-followup:${a.id}`,
  );
  assert.equal(parent.length, 1);
  assert.equal(parent[0].id, f.channel.conversationId);
  assert.deepEqual(parent[0].context, { kind: "coding-result", teamId: f.team.id });
  assert.ok(f.workflows.get(a.id).settled);
  assert.equal(emitted, 0, "member runs never trigger the parent's routines");
});

test("stopping a team withdraws pending member requests and frees the parent", async (t) => {
  const f = await setup(t);
  const audit = [];
  f.services.audit.append = (record) => audit.push(record);
  const service = new TeamService({
    assistants: f.assistants,
    store: f.teams,
    autoStart: false,
    audit: f.services.audit,
  });
  t.after(() => service.close());
  f.assistants.teams = service;
  const a = await f.request();
  await service.stop(f.team.id);
  const withdrawn = f.workflows.get(a.id);
  assert.equal(withdrawn.state, "declined");
  assert.equal(withdrawn.diagnostic, "TEAM_STOPPED");
  assert.deepEqual(
    audit.map((r) => [
      r.outcome,
      r.details.decision,
      r.details.requestedBy,
      r.details.teamId,
    ]),
    [["success", "decline", f.member.id, f.team.id]],
  );
  await assert.rejects(approve(f, a), { status: 409 });
  await assert.rejects(f.request(), { status: 403 });
  f.teams.write(f.teams.member(f.member.id), { phase: "cancelled" });
  await new TeamResults({ teams: f.teams, assistants: f.assistants }).collect(f.team.id);
  assert.equal(f.teams.get(f.team.id).phase, "cancelled");
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "next-team",
    text: "Build a team that reviews the fix",
  });
  f.teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const next = f.teams.propose({
    operationId: "next",
    parentAttemptId: f.assistants.ledger.recordAttempt(request.id).id,
    objective: "Review the fix",
    members: [{ name: "Reviewer", role: "Review", assignment: "Review the fix" }],
  });
  assert.equal(next.phase, "approved");
});

test("unexpected authorization errors on a tick never leave an action re-authorizing", async (t) => {
  const f = await setup(t);
  const authorize = f.workflows.authorize.bind(f.workflows);
  const states = [];
  for (const status of [400, 500]) {
    const a = await f.request();
    await approve(f, a);
    f.workflows.authorize = () => {
      throw Object.assign(Error("unexpected"), { status });
    };
    await f.workflows.tick();
    f.workflows.authorize = authorize;
    states.push(f.workflows.get(a.id).state);
  }
  assert.deepEqual(states, ["failed", "unknown"]);
  assert.equal(f.starts.length, 0);
});

test("members keep no memory-write, reminder or routine tools", async (t) => {
  const f = await setup(t);
  const member = f.store.getAssistant(f.member.assistantId);
  const tools = profileTools(member, true, true, true);
  assert.deepEqual(tools, ["session_status", "agentpier_workspace"]);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const prepare = (action) =>
    bridge.prepare({
      agentId: member.runtimeAgentId,
      sessionKey: "member-session",
      toolCallId: randomUUID(),
      action,
    });
  for (const action of ["reminder", "routine", "propose"])
    assert.throws(() => prepare(action), { status: 403 });
  const { ticket } = prepare("workspace");
  await assert.rejects(
    bridge.invoke({
      ticket,
      action: "workspace",
      input: {
        action: "memory_write",
        projectId: f.project.id,
        title: "Note",
        content: "Text",
      },
    }),
    { status: 403 },
  );
  const coding = prepare("workspace");
  const a = await bridge.invoke({
    ticket: coding.ticket,
    action: "workspace",
    input: {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Through the bridge",
    },
  });
  assert.equal(a.requestedBy, f.member.id);
  assert.equal(a.state, "awaiting_approval");
});

test("restart between approval and start recovers the member run without replay", async (t) => {
  const { AssistantWorkflows } =
    await import("../../server/features/assistants/assistant-workflows.js");
  const f = await setup(t);
  const a = await f.request();
  await approve(f, a);
  const executing = f.workflows.store.patch(a.id, { state: "executing" });
  await f.workflows.coding.start(executing);
  await f.workflows.close();
  const restarted = new AssistantWorkflows({ services: f.services, autoStart: false });
  t.after(() => restarted.close());
  assert.equal(restarted.get(a.id).state, "unknown");
  await restarted.tick();
  assert.equal(restarted.get(a.id).state, "running");
  assert.equal(restarted.get(a.id).requestedBy, f.member.id);
  assert.equal(f.starts.length, 1);
});

const followUps = (f, id) =>
  f.sends.filter((s) => s.input.clientRequestId === `coding-followup:${id}`);
const finishMember = (f) => {
  f.assistants.ledger.transition(f.turn.attempt.id, "completed");
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
};
test("a run that ends while results are collected is reported with its final state", async (t) => {
  const f = await setup(t);
  const a = await f.request();
  await approve(f, a);
  await f.workflows.tick();
  finishMember(f);
  const history = f.assistants.history.bind(f.assistants);
  f.assistants.history = async (id) => {
    // The run ends and its action settles while the member report is read.
    f.runs.get(f.workflows.get(a.id).runId).status = "completed";
    await f.workflows.tick();
    await f.workflows.tick();
    assert.ok(f.workflows.get(a.id).settled);
    return history(id);
  };
  await new TeamResults({ teams: f.teams, assistants: f.assistants }).collect(f.team.id);
  const [run] = f.teams.get(f.team.id).resultBatch[0].codingRuns;
  assert.equal(run.state, "completed");
  assert.equal(run.pending, undefined);
  assert.equal(run.runStatus, "completed");
});
test("pending member requests ending without a run still follow up to the parent", async (t) => {
  const f = await setup(t);
  const declined = await f.request(),
    expired = await f.request(),
    revoked = await f.request(),
    reviewed = await f.request();
  await approve(f, revoked);
  f.workflows.store.patch(reviewed.id, { state: "unknown" });
  finishMember(f);
  await new TeamResults({ teams: f.teams, assistants: f.assistants }).collect(f.team.id);
  const listed = f.teams.get(f.team.id).resultBatch[0].codingRuns;
  assert.ok(listed.every((r) => r.pending));
  await f.workflows.decide(
    declined.id,
    { revision: declined.revision, decision: "decline" },
    { kind: "owner", channel: "ui" },
  );
  f.workflows.store.patch(expired.id, { expiresAt: 0 });
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 1);
  const unknown = f.workflows.get(reviewed.id);
  await f.workflows.decide(
    reviewed.id,
    { revision: unknown.revision, decision: "review" },
    { kind: "owner", channel: "ui" },
  );
  await f.workflows.tick();
  await f.workflows.tick();
  const expected = [
    [declined, "declined"],
    [expired, "expired"],
    [revoked, "failed"],
    [reviewed, "reviewed"],
  ];
  for (const [action, state] of expected) {
    const current = f.workflows.get(action.id);
    assert.equal(current.state, state);
    const sent = followUps(f, action.id);
    assert.equal(sent.length, 1, state);
    assert.equal(sent[0].id, f.channel.conversationId);
    assert.ok(sent[0].input.text.includes(`"state":"${state}"`), state);
    assert.ok(current.settled, state);
  }
  assert.ok(followUps(f, revoked.id)[0].input.text.includes("GRANT_REVOKED"));
  assert.equal(
    f.sends.filter((s) => s.input.clientRequestId.startsWith("coding-result:")).length,
    0,
    "no run, no member result",
  );
  assert.equal(f.starts.length, 0);
});
