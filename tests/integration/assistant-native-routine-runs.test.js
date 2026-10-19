import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import {
  delegationTools,
  profileTools,
  routineTeamTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { withRoutineResults } from "../../server/features/assistants/routine-results.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";

// OpenClaw's tool policy globs: `*` is the only wildcard.
const matches = (name) =>
  routineTools.some((pattern) =>
    new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
    ).test(name),
  );
const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};
// A job as #192 created it: isolated, tool-less, light context, Telegram only.
function legacy(f, binding) {
  const job = [...f.jobs.values()].find((j) => j.id === binding.nativeId);
  f.jobs.set(job.id, {
    ...job,
    sessionTarget: "isolated",
    sessionKey: undefined,
    payload: {
      kind: "agentTurn",
      message: binding.definition.prompt,
      timeoutSeconds: 90,
      lightContext: true,
      toolsAllow: [],
    },
    delivery: { mode: "webhook", to: job.delivery.completionDestination.to },
  });
  return job.id;
}
const updates = (f) => f.calls.filter((c) => c.method === "cron.update");

test("a routine run gets exactly the agent's chat tools minus scheduling and most team tools", () => {
  for (const excluded of [
    "agentpier_routine",
    "agentpier_reminder",
    ...delegationTools.filter((tool) => !routineTeamTools.includes(tool)),
    "cron",
  ])
    assert.equal(matches(excluded), false, excluded);
  // A lead's routine asks its members and delegates read-only tasks.
  for (const included of routineTeamTools) assert.equal(matches(included), true);
  // OpenClaw intersects the cap with the agent's tools.allow: the result follows
  // the agent's capabilities, shell level and MCP bindings without a job rewrite.
  const effective = (agent, writeGuard = true) =>
    profileTools(agent, true, true, writeGuard, {}, ["github__*"]).filter(matches);
  const base = { capabilities: everything, shell: "approval" };
  assert.deepEqual(effective(base), [
    "session_status",
    // A lead asks and delegates read-only from its routine (TeamBridge.routineRun).
    ...routineTeamTools,
    "memory_search",
    "memory_get",
    "read",
    "write",
    "edit",
    // Project folders, read-only unless the owner marked the routine "May write".
    "agentpier_workspace",
    // A routine run hands its owner files too (agent-shares.js).
    "agentpier_share_file",
    "web_search",
    "web_fetch",
    "browser",
    "view_image",
    "exec",
    "process",
    "github__*",
  ]);
  assert.deepEqual(
    effective({ capabilities: { ...everything, webSearch: false, memory: false } }),
    [
      "session_status",
      ...routineTeamTools,
      "agentpier_workspace",
      "agentpier_share_file",
      "web_fetch",
      "browser",
      "view_image",
      "github__*",
    ],
  );
  assert.equal(matches("github__create_issue"), true);
  // Writes follow the proven guard exactly as in chat.
  assert.equal(effective(base, false).includes("write"), false);
});

test("existing routine jobs are migrated once to tools and the chat commit; reminders stay tool-less", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  await f.reminders.create(f.id, {
    clientRequestId: "reminder-1",
    name: "Water",
    message: "Water the plants.",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Berlin" },
  });
  const reminderJob = [...f.jobs.values()].find((j) => j.payload.toolsAllow.length === 0);
  assert.equal(reminderJob.sessionTarget, "isolated");
  assert.equal(reminderJob.payload.lightContext, true);
  const jobId = legacy(f, f.reminders.bindings.get(routine.id));

  await f.routines.reconcile();
  const [update] = updates(f);
  assert.equal(update.input.id, jobId);
  const job = f.jobs.get(jobId);
  assert.equal(job.sessionTarget, "current");
  assert.equal(job.sessionKey, "session");
  assert.deepEqual(job.payload.toolsAllow, routineTools);
  assert.equal(job.payload.lightContext, false);
  assert.equal(job.payload.timeoutSeconds, 300);
  assert.equal(job.delivery.mode, "announce");
  assert.equal(job.enabled, true, "the schedule and state are untouched");
  assert.deepEqual(job.schedule, f.input.trigger);
  assert.deepEqual(f.jobs.get(reminderJob.id), reminderJob, "the reminder is untouched");

  // Converged jobs are left alone on the next start.
  await f.routines.reconcile();
  assert.equal(updates(f).length, 1);

  // A paused routine keeps its pause while it is migrated.
  const paused = await f.routines.update(f.id, routine.id, {
    enabled: false,
    revision: routine.revision,
  });
  legacy(f, f.reminders.bindings.get(paused.id));
  await f.routines.reconcile();
  assert.equal(f.jobs.get(jobId).enabled, false);
  assert.equal(f.jobs.get(jobId).payload.lightContext, false);
});

test("a routine follows its chat's conversation to a new native session", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.store.db
    .prepare("UPDATE conversations SET session_key=?, body=? WHERE id=?")
    .run(
      "session-2",
      JSON.stringify({ ...conversation, runtimeSessionKey: "session-2" }),
      conversation.id,
    );
  await f.routines.resync(f.id);
  const job = f.jobs.get(f.reminders.bindings.get(routine.id).nativeId);
  assert.equal(job.sessionKey, "session-2");
  assert.equal(updates(f).length, 1);
});

test("delivered results are badged in the chat, uncommitted ones and failures are kept", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, { ...f.input, telegram: true });
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  const complete = (runAtMs, event) =>
    f.reminders.complete(routine.id, { jobId, runAtMs, ...event });
  await complete(1000, {
    status: "ok",
    summary: "Lentil soup today.\n",
    deliveryStatus: "delivered",
  });
  // A replayed completion records nothing new.
  await complete(1000, {
    status: "ok",
    summary: "Lentil soup today.\n",
    deliveryStatus: "delivered",
  });
  await complete(5000, {
    status: "ok",
    summary: "Rice today.",
    deliveryStatus: "unknown",
  });
  await complete(9000, { status: "error" });
  await complete(12000, {
    status: "ok",
    summary: "NO_REPLY",
    deliveryStatus: "delivered",
  });
  const results = f.routines.results.forConversation(f.channel.conversationId);
  assert.deepEqual(
    results.map((r) => [r.runAtMs, r.status, r.committed ?? null, r.name]),
    [
      [1000, "ok", true, "Meal plan"],
      [5000, "ok", false, "Meal plan"],
      [9000, "error", null, "Meal plan"],
    ],
  );
  // Telegram receives each result, the failure notice, never the silent token.
  const sent = f.service.outbox.all(f.channel.id).map((e) => e.text);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(0, 2), ["Lentil soup today.\n", "Rice today."]);

  const history = withRoutineResults(
    [
      { id: "a", role: "assistant", text: "Lentil soup today.", timestamp: 500 },
      { id: "b", role: "user", text: "Thanks", timestamp: 2000 },
      { id: "c", role: "assistant", text: "Lentil soup today.", timestamp: 3000 },
    ],
    results,
  );
  assert.deepEqual(
    history.map((m) => [m.id, m.role, m.scheduled?.name ?? m.event ?? null]),
    [
      // An earlier identical reply is not the routine's result.
      ["a", "assistant", null],
      ["b", "user", null],
      ["c", "assistant", "Meal plan"],
      [`routine:${jobId}:5000`, "assistant", "Meal plan"],
      [`routine:${jobId}:9000`, "event", "routine-failed"],
    ],
  );
  assert.equal(history[3].text, "Rice today.");

  // Paused: a late completion reaches neither Telegram nor the chat.
  await f.routines.update(f.id, routine.id, { enabled: false, revision: 1 });
  await complete(20000, { status: "ok", summary: "Late", deliveryStatus: "delivered" });
  assert.equal(f.routines.results.forConversation(f.channel.conversationId).length, 3);
});

test("the conversation history carries the routine badge and survives a lost Gateway", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const jobId = f.reminders.bindings.get(routine.id).nativeId;
  await f.reminders.complete(routine.id, {
    jobId,
    runAtMs: 1000,
    status: "ok",
    summary: "Lentil soup today.",
    deliveryStatus: "delivered",
  });
  const service = {
    store: f.store,
    ledger: f.store.db && f.assistants.ledger,
    runtime: {
      generation: 1,
      client: {
        ready: true,
        call: async () => ({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Lentil soup today." }],
              timestamp: 2000,
              __openclaw: { id: "m1" },
            },
          ],
        }),
      },
    },
    routines: f.routines,
  };
  const live = await conversationHistory(service, f.channel.conversationId);
  assert.deepEqual(live.messages[0].scheduled, { name: "Meal plan" });
  service.runtime.client.ready = false;
  const cached = await conversationHistory(service, f.channel.conversationId);
  assert.equal(cached.stale, true);
  assert.deepEqual(cached.messages[0].scheduled, { name: "Meal plan" });
});

test("a routine run's exec approval is shown in its chat and offered in its Telegram chat", async (t) => {
  const f = routineFixture(t);
  f.store.updateAssistant(
    f.id,
    { shell: "approval" },
    f.store.getAssistant(f.id).revision,
  );
  const routine = await f.routines.create(f.id, { ...f.input, telegram: true });
  const binding = f.reminders.bindings.get(routine.id);
  const agent = f.store.getAssistant(f.id);
  f.assistants.routines = f.routines;
  const approvals = new ExecApprovals({ a: f.assistants });
  for (const sessionKey of [
    `agent:${agent.runtimeAgentId}:cron:${binding.nativeId}`,
    `agent:${agent.runtimeAgentId}:cron:${binding.nativeId}:run:abc`,
  ])
    assert.deepEqual(approvals.attribute({ agentId: agent.runtimeAgentId, sessionKey }), {
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      origin: {
        kind: "telegram",
        channelId: f.channel.id,
        chatId: f.channel.chatId,
        userId: f.channel.userId,
      },
    });
  for (const sessionKey of [
    `agent:${agent.runtimeAgentId}:cron:other-job`,
    `agent:ap-other:cron:${binding.nativeId}`,
    `agent:${agent.runtimeAgentId}:cron:${binding.nativeId}:extra`,
  ])
    assert.deepEqual(
      approvals.attribute({ agentId: agent.runtimeAgentId, sessionKey }),
      { reason: "UNKNOWN_SESSION" },
      sessionKey,
    );
  // A paused routine's run is no longer attributed.
  await f.routines.update(f.id, routine.id, { enabled: false, revision: 1 });
  assert.deepEqual(
    approvals.attribute({
      agentId: agent.runtimeAgentId,
      sessionKey: `agent:${agent.runtimeAgentId}:cron:${binding.nativeId}`,
    }),
    { reason: "UNKNOWN_SESSION" },
  );
});

test("a routine's own run may write in its workspace; reminders, check-ins and other sessions may not", async (t) => {
  const f = routineFixture(t);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: true } },
    f.store.getAssistant(f.id).revision,
  );
  const routine = await f.routines.create(f.id, f.input);
  const reminder = await f.reminders.create(f.id, {
    clientRequestId: "reminder-1",
    name: "Water",
    message: "Water the plants.",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Berlin" },
  });
  // A check-in binding with its own native job, as NativeHeartbeats keeps it.
  new NativeHeartbeats({ reminders: f.reminders });
  const { binding: checkIn } = f.reminders.bindings.reserve(
    f.id,
    "heartbeat:1",
    { assistantId: f.id, channelId: f.channel.id },
    {},
    { kind: "heartbeat" },
  );
  f.reminders.bindings.patch(checkIn.id, { state: "bound", nativeId: "job-heartbeat" });
  f.assistants.routines = f.routines;
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: { store: { context: () => null } },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const agent = () => f.store.getAssistant(f.id);
  const nativeId = (id) => f.reminders.bindings.get(id).nativeId;
  const write = (job, { who = agent().runtimeAgentId, toolName = "write" } = {}) =>
    bridge.toolPolicy({
      agentId: who,
      sessionKey: `agent:${agent().runtimeAgentId}:cron:${job}:run:r1`,
      toolName,
      path: "memory/news-sent.md",
    }).allow;
  assert.equal(write(nativeId(routine.id)), true);
  assert.equal(write(nativeId(routine.id), { toolName: "edit" }), true);
  assert.equal(write(nativeId(reminder.id)), false, "a reminder's run");
  assert.equal(write("job-heartbeat"), false, "a check-in's run");
  assert.equal(write("unknown-job"), false);
  // Another agent (a member) never borrows the routine's run.
  const member = f.store.createAssistant({
    name: "Member",
    model: { connectionId: "test", modelId: "fixture" },
    capabilities: { memory: true, reminders: true },
  });
  assert.equal(write(nativeId(routine.id), { who: member.runtimeAgentId }), false);
  // The owner's chat session without a running owner turn stays read-only.
  assert.equal(
    bridge.toolPolicy({
      agentId: agent().runtimeAgentId,
      sessionKey: "session",
      toolName: "write",
      path: "memory/news-sent.md",
    }).allow,
    false,
  );
  // Memory or routines switched off, or the routine paused: no writes.
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: false, reminders: true } },
    agent().revision,
  );
  assert.equal(write(nativeId(routine.id)), false);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: true } },
    agent().revision,
  );
  await f.routines.update(f.id, routine.id, { enabled: false, revision: 1 });
  assert.equal(write(nativeId(routine.id)), false);
});
