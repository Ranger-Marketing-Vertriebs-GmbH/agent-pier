import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// "Pause agents and update" (runtime-update-resolution.js) on the real agent, ledger,
// channel and action stores, with a fake Gateway, team service, sign-in and cron.
async function fixture(t, { login = false, routine = false, failAbort = null } = {}) {
  const f = await workflowFixture(t);
  const paths = runtimePaths(f.dataDir);
  fs.mkdirSync(paths.state, { recursive: true });
  writePrivate(paths.config, { cron: { enabled: true } });
  writePrivate(path.join(paths.root, "runtime.json"), {
    version: "old",
    nodeVersion: "n",
  });
  const calls = [];
  // The routine run is still running when the resolution ends, then ends: waited for.
  let routineRuns = routine ? 3 : 0;
  const client = {
    ready: true,
    async call(method, input) {
      calls.push({ method, input });
      if (method === "config.get") return { hash: "h", config: readJSON(paths.config) };
      if (method === "config.patch") {
        const config = readJSON(paths.config);
        config.cron.enabled = JSON.parse(input.raw).cron.enabled;
        writePrivate(paths.config, config);
        return {};
      }
      if (method === "cron.status")
        return { enabled: readJSON(paths.config).cron.enabled };
      if (method === "agents.list") return { agents: [] };
      if (method === "sessions.abort" && input.runId === failAbort)
        throw Object.assign(Error("unavailable"), { code: "UNAVAILABLE" });
      if (["sessions.describe", "sessions.abort", "wizard.cancel"].includes(method))
        return {};
      assert.fail(method);
    },
  };
  const runtime = {
    paths,
    client,
    generation: 1,
    running: true,
    status() {
      return { availability: this.running ? "ready" : "disabled" };
    },
    async stop() {
      this.running = false;
    },
    async start() {
      this.generation++;
      this.running = true;
    },
  };
  const a = f.assistants;
  Object.assign(a, {
    runtime,
    locks: new Map(),
    reconcile: async () => {},
    config: { reset() {} },
    gatewayEvents: { ready() {} },
  });
  // A team with one running member, stopped as the owner's team stop does.
  const team = {
    id: "team-1",
    phase: "running",
    revision: 3,
    createdAt: "2026-10-29T10:00:00.000Z",
    parentAssistantId: f.id,
    parentConversationId: f.channel.conversationId,
  };
  const member = { id: "member-1", teamId: team.id, phase: "running", attemptId: null };
  const teamStops = [];
  const assistantTeams = {
    store: { members: () => [member], list: () => [team] },
    async stop(id) {
      teamStops.push(id);
      member.phase = "stopping";
      member.stopRequested = true;
      await a.runtime.client.call("sessions.abort", {
        key: "member",
        runId: member.attemptId,
      });
    },
    scheduler: {
      async observe(id) {
        assert.equal(id, member.id);
        const attempt = a.ledger.getAttempt(member.attemptId);
        if (["completed", "failed", "cancelled"].includes(attempt.state))
          member.phase = attempt.state;
      },
      results: {
        async collect(id) {
          if (member.phase === "cancelled")
            Object.assign(team, { phase: "cancelled", revision: team.revision + 1 });
          assert.equal(id, team.id);
        },
      },
    },
  };
  const audit = [];
  const loginAttempt = {
    id: "login-1",
    status: "awaiting_user",
    startedAt: "2026-10-30T08:00:00.000Z",
  };
  let loginCancels = 0;
  Object.assign(f.services, {
    assistantRuntime: runtime,
    assistantTeams,
    assistantModelLogin: login
      ? {
          attempt: loginAttempt,
          async cancel() {
            loginCancels++;
          },
        }
      : undefined,
    assistantReminders: {
      webhook: { jobs: [] },
      async runningJobs() {
        if (routineRuns <= 0) return [];
        routineRuns--;
        return [
          {
            id: "job-1",
            agentId: "main",
            state: { runningAtMs: Date.parse("2026-10-30T09:00:00.000Z") },
          },
        ];
      },
    },
    audit: { append: (event) => audit.push(auditEvent(event)) },
  });
  // Channel workers stay off: the test reads exactly what the resolution wrote. Any
  // Telegram call would be a send.
  f.service.resume = () => {};
  const telegram = [];
  const telegramCall = f.client.call;
  f.client.call = async (...args) => {
    telegram.push(args[0]);
    return telegramCall(...args);
  };
  const send = async (key) =>
    (await a.send(f.channel.conversationId, { clientRequestId: key, text: key })).attempt;
  // A running turn, a turn of unknown outcome and the team member's running turn.
  const running = await send("running");
  a.ledger.transition(running.id, "running", { runtimeRunId: "run-1" });
  const uncertain = await send("uncertain");
  a.ledger.transition(uncertain.id, "uncertain");
  member.attemptId = (await send("member")).id;
  a.ledger.transition(member.attemptId, "running", { runtimeRunId: "run-member" });
  // The incident: a Telegram input stuck in model_reviewed, one still queued and a
  // notice waiting to be sent.
  const stuck = f.service.ledger.accept(f.channel, telegramMessage(1, "stuck"));
  f.service.ledger.patch(stuck.id, {
    state: "model_reviewed",
    diagnostic: "MODEL_OUTCOME_REVIEWED",
  });
  const queued = f.service.ledger.accept(f.channel, telegramMessage(2, "queued"));
  const notice = f.service.outbox.enqueue({
    key: "notice-1",
    source: {
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    },
    kind: "reminder",
    text: "Reminder",
  });
  // Agent actions: one approved but not started, one of unknown outcome, a coding run.
  const action = (key, state, payload, extra = {}) =>
    f.workflows.store.reserve({
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      attemptId: null,
      origin: { kind: "owner" },
      key,
      state,
      payload,
      ...extra,
    });
  const memory = {
    action: "memory_write",
    projectId: f.project.id,
    title: "Note",
    content: "x",
  };
  const approved = action("approved", "approved", memory);
  const unknown = action("unknown", "unknown", { ...memory, title: "Other" });
  const run = await f.services.pipelines.start({}, { id: "run-coding" });
  const coding = action(
    "coding",
    "running",
    { action: "coding_start", task: "Fix" },
    { runId: run.id },
  );
  const updates = new RuntimeUpdates({
    dataDir: f.dataDir,
    runtime,
    maintenance: new AssistantMaintenance(f.services),
    stage: async () => ({ version: "target", nodeVersion: "n" }),
    migrate: async () => {},
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
  });
  await updates.stage();
  const confirm = async () =>
    (await updates.blockerPreview()).map(({ id, revision }) => ({ id, revision }));
  return {
    f,
    a,
    calls,
    audit,
    team,
    member,
    teamStops,
    running,
    uncertain,
    stuck,
    queued,
    notice,
    approved,
    unknown,
    coding,
    updates,
    confirm,
    loginCancels: () => loginCancels,
    telegram,
  };
}

const aborts = (calls) => calls.filter((c) => c.method === "sessions.abort");

test("the preview names every blocker with its agent, age, link and revision", async (t) => {
  const s = await fixture(t, { routine: true });
  const items = await s.updates.blockerPreview();
  const kinds = items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, [
    "channel_input",
    "channel_input",
    "channel_notice",
    "chat_turn",
    "chat_turn",
    "chat_turn",
    "routine_run",
    "team_task",
    "workflow",
    "workflow",
    "workflow",
  ]);
  const turn = items.find((i) => i.id === `chat_turn:${s.running.id}`);
  assert.equal(turn.code, "ASSISTANT_WORK");
  assert.deepEqual(turn.agent, { id: s.f.id, name: "Home" });
  assert.equal(turn.resolution, "stop");
  assert.equal(turn.link, `/agents/${s.f.id}/chats/${s.f.channel.conversationId}`);
  assert.ok(Date.parse(turn.since) > 0);
  assert.equal(
    items.find((i) => i.id === `chat_turn:${s.uncertain.id}`).resolution,
    "review",
  );
  const input = items.find((i) => i.id === `channel_input:${s.stuck.id}`);
  assert.equal(input.code, "CHANNEL_WORK");
  assert.equal(
    input.link,
    `/agents/${s.f.id}/settings?tab=channels&page=telegram-activity`,
  );
  assert.equal(input.resolution, "close");
  assert.equal(items.find((i) => i.kind === "routine_run").resolution, "wait");
  assert.equal(items.find((i) => i.kind === "team_task").resolution, "cancel");
  // Nothing internal reaches the browser, and the preview changes nothing.
  for (const item of items) assert.equal("ref" in item, false);
  assert.deepEqual(aborts(s.calls), []);
  assert.equal(s.a.ledger.getAttempt(s.running.id).state, "running");
});

test("pausing agents resolves each confirmed blocker without resending and activates", async (t) => {
  const s = await fixture(t, { routine: true });
  const outbox = s.f.service.outbox.get(s.notice.id);
  const status = await s.updates.activate({
    resolveBlockers: true,
    items: await s.confirm(),
  });
  assert.equal(status.phase, "complete");
  assert.equal(status.currentVersion, "target");
  assert.deepEqual(status.blockers, []);
  assert.equal(s.a.maintenance, false);
  // Running turns were stopped through the Gateway; the unknown one reviewed.
  assert.equal(s.a.ledger.getAttempt(s.running.id).state, "cancelled");
  assert.ok(s.a.ledger.getAttempt(s.uncertain.id).reviewedAt);
  assert.equal(s.a.ledger.getAttempt(s.member.attemptId).state, "cancelled");
  const runs = aborts(s.calls).map((c) => c.input.runId);
  for (const id of ["run-1", "run-member", s.uncertain.id])
    assert.ok(runs.includes(id), id);
  // The team was stopped through its own stop and ended cancelled.
  assert.deepEqual(s.teamStops, ["team-1"]);
  assert.equal(s.member.phase, "cancelled");
  assert.equal(s.team.phase, "cancelled");
  // Telegram: inputs and the notice closed, nothing sent or handed to the agent.
  assert.equal(s.f.service.ledger.get(s.stuck.id).state, "reviewed");
  assert.deepEqual(
    [
      s.f.service.ledger.get(s.queued.id).state,
      s.f.service.ledger.get(s.queued.id).diagnostic,
    ],
    ["reviewed", "RUNTIME_UPDATE_CLOSED"],
  );
  const closed = s.f.service.outbox.get(s.notice.id);
  assert.equal(closed.state, "reviewed");
  assert.deepEqual(closed.remoteMessageIds, outbox.remoteMessageIds);
  assert.equal(s.f.service.outbox.pending(s.f.channel.id).length, 0);
  assert.deepEqual(s.telegram, []);
  // No input was handed to the agent: only the fixture's own three turns were sent.
  assert.deepEqual(
    s.f.sent.map((input) => input.text),
    ["running", "uncertain", "member"],
  );
  // Agent actions: cancelled, reviewed, and the coding run cancelled in its pipeline.
  const store = s.f.workflows.store;
  assert.equal(store.get(s.approved.id).state, "cancelled");
  assert.equal(store.get(s.unknown.id).state, "reviewed");
  assert.equal(store.get(s.coding.id).state, "cancelled");
  assert.equal(s.f.runs.get("run-coding").status, "cancelled");
  // Every forced resolution is audited with via: "runtime-update".
  const forced = s.audit.filter((e) => e.details.via === "runtime-update");
  assert.ok(
    forced.every((e) => e.details.kind === "runtime-update" && e.outcome === "success"),
  );
  const byItem = (item) =>
    forced.filter((e) => e.details.item === item).map((e) => e.details.result);
  assert.deepEqual(byItem("chat_turn").sort(), ["cancelled", "cancelled", "reviewed"]);
  assert.deepEqual(byItem("team_task"), ["cancelled"]);
  assert.deepEqual(byItem("channel_input"), ["closed", "closed"]);
  assert.deepEqual(byItem("channel_notice"), ["closed"]);
  assert.deepEqual(byItem("workflow").sort(), ["cancelled", "cancelled", "reviewed"]);
  assert.ok(
    forced.some(
      (e) => e.action === "assistant.cancelled" && e.details.entryId === s.running.id,
    ),
  );
  // The routine run could only be waited for: it is never audited as resolved.
  assert.equal(byItem("routine_run").length, 0);
  // The scheduler is on again.
  assert.equal(readJSON(runtimePaths(s.f.dataDir).config).cron.enabled, true);
});

test("a sign-in in progress is never cancelled and nothing else is touched", async (t) => {
  const s = await fixture(t, { login: true });
  const items = await s.updates.blockerPreview();
  const login = items.find((i) => i.kind === "login");
  assert.deepEqual(
    {
      code: login.code,
      resolution: login.resolution,
      link: login.link,
      since: login.since,
    },
    {
      code: "ACCOUNT_LOGIN",
      resolution: "none",
      link: "/connections?section=models&item=chatgpt",
      since: "2026-10-30T08:00:00.000Z",
    },
  );
  await assert.rejects(
    s.updates.activate({ resolveBlockers: true, items: await s.confirm() }),
    { code: "UPDATE_BLOCKED" },
  );
  assert.equal(s.loginCancels(), 0);
  assert.equal(s.calls.filter((c) => c.method === "wizard.cancel").length, 0);
  assert.deepEqual(aborts(s.calls), []);
  assert.equal(s.a.ledger.getAttempt(s.running.id).state, "running");
  assert.equal(s.f.service.ledger.get(s.stuck.id).state, "model_reviewed");
  assert.deepEqual(s.teamStops, []);
  assert.deepEqual(s.audit, []);
  const status = s.updates.status();
  assert.equal(status.phase, "staged");
  assert.equal(status.diagnostic, "UPDATE_BLOCKED");
  assert.ok(status.blockers.includes("ACCOUNT_LOGIN"));
  assert.ok(status.blockerItems.some((i) => i.id === login.id));
  assert.equal(s.a.maintenance, false);
});

test("an item that changed after the dialog opened leaves everything untouched", async (t) => {
  const s = await fixture(t);
  const confirmed = await s.confirm();
  // The stuck input moves on meanwhile: its revision no longer matches.
  s.f.service.ledger.patch(s.stuck.id, { state: "delivery_uncertain" });
  await assert.rejects(s.updates.activate({ resolveBlockers: true, items: confirmed }), {
    code: "UPDATE_BLOCKED",
  });
  assert.deepEqual(aborts(s.calls), []);
  assert.equal(s.f.service.ledger.get(s.stuck.id).state, "delivery_uncertain");
  assert.equal(s.f.service.ledger.get(s.queued.id).state, "queued");
  assert.equal(s.f.service.outbox.get(s.notice.id).state, "outbound");
  assert.equal(s.f.workflows.store.get(s.approved.id).state, "approved");
  assert.deepEqual(s.audit, []);
  const status = s.updates.status();
  assert.equal(status.diagnostic, "UPDATE_BLOCKED");
  const changed = status.blockerItems.find((i) => i.id === `channel_input:${s.stuck.id}`);
  assert.notEqual(changed.revision, confirmed.find((i) => i.id === changed.id).revision);
  // A work item the owner did not confirm at all is never touched either.
  await assert.rejects(
    s.updates.activate({
      resolveBlockers: true,
      items: (await s.confirm()).filter((i) => !i.id.startsWith("workflow:")),
    }),
    { code: "UPDATE_BLOCKED" },
  );
  assert.equal(s.a.ledger.getAttempt(s.running.id).state, "running");
  assert.deepEqual(s.audit, []);
});

test("an activation without resolution keeps refusing blockers and lists them", async (t) => {
  const s = await fixture(t);
  await assert.rejects(s.updates.activate(), { code: "UPDATE_BLOCKED" });
  const status = s.updates.status();
  assert.deepEqual(status.blockers, [
    "ASSISTANT_WORK",
    "TEAM_WORK",
    "CHANNEL_WORK",
    "WORKFLOW_WORK",
  ]);
  assert.equal(status.blockerItems.length, 10);
  assert.deepEqual(aborts(s.calls), []);
  assert.deepEqual(s.audit, []);
});

test("work that cannot be resolved is reported exactly, the rest stays resolved", async (t) => {
  const s = await fixture(t, { failAbort: "run-1" });
  await assert.rejects(
    s.updates.activate({ resolveBlockers: true, items: await s.confirm() }),
    { code: "UPDATE_BLOCKED" },
  );
  const status = s.updates.status();
  assert.equal(status.phase, "staged");
  assert.deepEqual(status.blockers, ["ASSISTANT_WORK"]);
  assert.deepEqual(
    status.blockerItems.map((i) => i.id),
    [`chat_turn:${s.running.id}`],
  );
  assert.equal(s.a.ledger.getAttempt(s.running.id).state, "running");
  assert.equal(s.f.service.ledger.get(s.stuck.id).state, "reviewed");
  const failed = s.audit.filter((e) => e.outcome === "failure");
  assert.deepEqual(
    failed.map((e) => [e.action, e.details.item, e.details.entryId]),
    [["assistant.cancelled", "chat_turn", s.running.id]],
  );
  assert.equal(s.a.maintenance, false);
});
