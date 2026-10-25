import test from "node:test";
import assert from "node:assert/strict";
import { assistantActivity } from "../../server/features/assistants/assistant-activity.js";

const agent = (id, extra = {}) => ({ id, name: id, archivedAt: null, ...extra });
const chat = (id, assistantId, extra = {}) => ({
  id,
  assistantId,
  archivedAt: null,
  ...extra,
});
const row = (conversationId, attemptState, reviewedAt = null) => ({
  conversationId,
  requestId: `r-${conversationId}`,
  requestState: attemptState,
  attemptId: `a-${conversationId}`,
  attemptState,
  reviewedAt,
});
const derive = (input) =>
  assistantActivity({
    assistants: [agent("home")],
    conversations: [chat("c", "home")],
    latest: [],
    awaiting: {},
    teams: [],
    members: [],
    ...input,
  });

test("an agent without requests, approvals or teams is idle", () => {
  assert.deepEqual(derive({}).home, {
    state: "idle",
    reason: null,
    label: null,
    pendingApprovals: 0,
    team: null,
  });
});

for (const state of ["pending", "accepted", "running"])
  test(`an unreviewed ${state} attempt means working`, () => {
    const entry = derive({ latest: [row("c", state)] }).home;
    assert.equal(entry.state, "working");
    assert.equal(entry.reason, "attempt");
    assert.equal(entry.label, "status.running");
  });

for (const state of ["uncertain", "interrupted"])
  test(`an unreviewed ${state} attempt needs attention`, () => {
    const entry = derive({ latest: [row("c", state)] }).home;
    assert.deepEqual(
      [entry.state, entry.reason, entry.label],
      ["attention", "attempt", `status.${state}`],
    );
  });

test("a reviewed uncertain attempt and a failed attempt leave the agent idle", () => {
  assert.equal(
    derive({ latest: [row("c", "uncertain", "2026-10-11")] }).home.state,
    "idle",
  );
  assert.equal(derive({ latest: [row("c", "failed")] }).home.state, "idle");
  assert.equal(derive({ latest: [row("c", "completed")] }).home.state, "idle");
});

test("attempts in archived conversations are ignored", () => {
  const entry = derive({
    conversations: [chat("c", "home", { archivedAt: "2026-10-11" })],
    latest: [row("c", "uncertain")],
  }).home;
  assert.equal(entry.state, "idle");
});

test("pending approvals sum own actions, team coding requests and team proposals", () => {
  const entry = derive({
    awaiting: { home: { own: 1, team: 2 } },
    teams: [{ id: "t", parentAssistantId: "home", phase: "awaiting_approval" }],
  }).home;
  assert.deepEqual(entry, {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals: 4,
    team: "awaiting",
  });
  const actionsOnly = derive({ awaiting: { home: { own: 1, team: 0 } } }).home;
  assert.equal(actionsOnly.label, "team.states.awaiting_approval");
});

test("a team member whose outcome is unknown waits for the lead's owner", () => {
  const member = (id, phase, extra = {}) => ({
    id,
    assistantId: id,
    teamId: "t",
    parentAssistantId: "home",
    phase,
    ...extra,
  });
  const entry = derive({
    assistants: [agent("home"), agent("m1"), agent("m2"), agent("m3"), agent("m4")],
    teams: [{ id: "t", parentAssistantId: "home", phase: "running" }],
    members: [
      member("m1", "provisioning_uncertain"),
      member("m2", "uncertain"),
      member("m3", "running"),
      member("m4", "uncertain", { archivedAt: "x" }),
    ],
  }).home;
  assert.equal(entry.pendingApprovals, 2);
  assert.equal(entry.state, "waiting");
});

test("attention outranks waiting, waiting outranks working", () => {
  const awaiting = { home: { own: 1, team: 0 } };
  assert.equal(
    derive({ awaiting, latest: [row("c", "uncertain")] }).home.state,
    "attention",
  );
  assert.equal(
    derive({ awaiting, latest: [row("c", "accepted")] }).home.state,
    "waiting",
  );
});

test("an active own team makes the parent work and is reported as team state", () => {
  const entry = derive({
    teams: [
      { id: "t", parentAssistantId: "home", phase: "running" },
      {
        id: "old",
        parentAssistantId: "home",
        phase: "awaiting_approval",
        archivedAt: "x",
      },
    ],
  }).home;
  assert.deepEqual(entry, {
    state: "working",
    reason: "team",
    label: "teamActive.working",
    pendingApprovals: 0,
    team: "active",
  });
  const done = derive({
    teams: [{ id: "t", parentAssistantId: "home", phase: "completed" }],
  });
  assert.equal(done.home.state, "idle");
  assert.equal(done.home.team, null);
});

test("the agent's own attempt outranks its team for the working reason", () => {
  const entry = derive({
    latest: [row("c", "accepted")],
    teams: [{ id: "t", parentAssistantId: "home", phase: "running" }],
  }).home;
  assert.deepEqual([entry.reason, entry.team], ["attempt", "active"]);
});

test("member phases map to working, queued and attention", () => {
  const member = (phase) =>
    derive({
      assistants: [
        agent("home"),
        agent("m", { teamMemberId: "m", parentAssistantId: "home" }),
      ],
      members: [{ id: "m", assistantId: "m", teamId: "t", phase }],
    }).m;
  for (const phase of ["provisioning", "admitting", "running", "stopping"])
    assert.deepEqual([member(phase).state, member(phase).reason], ["working", "member"]);
  assert.deepEqual(
    [member("queued").state, member("queued").reason],
    ["working", "queued"],
  );
  assert.equal(member("queued").label, "team.states.queued");
  for (const phase of ["uncertain", "provisioning_uncertain"])
    assert.deepEqual(
      [member(phase).state, member(phase).label],
      ["attention", `team.states.${phase}`],
    );
  for (const phase of ["ready", "completed", "failed", "cancelled"])
    assert.equal(member(phase).state, "idle");
});

test("archived agents are omitted and archived members are ignored", () => {
  const result = derive({
    assistants: [agent("home"), agent("gone", { archivedAt: "x" }), agent("m")],
    members: [{ id: "m", assistantId: "m", phase: "running", archivedAt: "x" }],
  });
  assert.equal(result.gone, undefined);
  assert.equal(result.m.state, "idle");
});

test("an agent the running Gateway refused needs attention before anything else", () => {
  const entry = derive({
    assistants: [agent("home", { degraded: true })],
    latest: [row("c", "running")],
  }).home;
  assert.equal(entry.state, "attention");
  assert.equal(entry.reason, "degraded");
  assert.equal(entry.label, "status.degraded");
});
