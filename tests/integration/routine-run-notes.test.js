import test from "node:test";
import assert from "node:assert/strict";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import { agentSshFixture, hostId } from "../helpers/agent-ssh-fixture.js";

// AGENTPIER-246: what a routine's or a hook's run did over SSH shows with that run
// in the event area, never as a row of the main transcript.
const remote = (messages) =>
  messages.filter((m) => ["ssh-run", "sftp-run"].includes(m.event));

async function routineChat(t) {
  const f = await agentSshFixture(t);
  const results = [];
  f.assistants.routines = { results: { forConversation: () => results } };
  f.grant([{ accessId: hostId, mode: "routines" }]);
  const run = async (command, { bindingId = "binding-1", job = "job-1" } = {}) => {
    const runAtMs = Date.now() - 1;
    const inv = f.routineTurn({
      sessionKey: `agent:${f.store.getAssistant(f.id).runtimeAgentId}:cron:${job}:run:r1`,
      routine: {
        binding: { id: bindingId },
        conversation: f.store.getConversation(f.channel.conversationId),
      },
    });
    await f.execute(inv, command);
    const id = `${job}:${runAtMs}`;
    results.push({
      id,
      conversationId: f.channel.conversationId,
      bindingId,
      name: "Zabbix check",
      runAtMs,
      at: Date.now() + 1,
      status: "ok",
      text: `Checked ${command}`,
      committed: false,
    });
    return `routine:${id}`;
  };
  const history = () => conversationHistory(f.assistants, f.channel.conversationId);
  return { f, run, history, results };
}

test("a routine run's SSH rows join its event row, not the transcript", async (t) => {
  const { f, run, history } = await routineChat(t);
  const first = await run("process.exit(0)");
  await f.execute(f.ownTurn(), "process.exit(1)");
  const second = await run("process.exit(2)");
  const view = await history();
  // Only the owner's own run stays a transcript row.
  assert.deepEqual(
    remote(view.messages).map((n) => n.command),
    ["process.exit(1)"],
  );
  const rows = Object.fromEntries(view.events.map((e) => [e.id, e]));
  assert.deepEqual(
    rows[first].runNotes.map((n) => [n.event, n.hostName, n.command, n.outcome]),
    [["ssh-run", "opnsense", "process.exit(0)", "done"]],
  );
  assert.deepEqual(
    rows[second].runNotes.map((n) => [n.command, n.outcome, n.exitCode]),
    [["process.exit(2)", "exit", 2]],
  );
  // The routine's rows name it, so they cannot join another routine's run.
  const actions = f.workflows.store
    .list(f.id)
    .filter((a) => a.origin?.kind === "routine");
  assert.deepEqual(
    actions.map((a) => a.origin),
    [
      { kind: "routine", bindingId: "binding-1" },
      { kind: "routine", bindingId: "binding-1" },
    ],
  );
});

test("a routine's row never joins another routine's run", async (t) => {
  const { f, run, history, results } = await routineChat(t);
  const own = await run("process.exit(0)", { bindingId: "binding-2", job: "job-2" });
  // Another routine's run that overlaps it in time.
  results.push({
    ...results[0],
    id: "job-1:1",
    bindingId: "binding-1",
    runAtMs: 1,
  });
  const view = await history();
  const rows = Object.fromEntries(view.events.map((e) => [e.id, e]));
  assert.equal(rows["routine:job-1:1"].runNotes, undefined);
  assert.equal(rows[own].runNotes.length, 1);
  assert.deepEqual(remote(view.messages), []);
  assert.equal(f.workflows.store.list(f.id).length, 1);
});

test("rows recorded before they named the routine join the run by time", async (t) => {
  const { f, run, history } = await routineChat(t);
  const id = await run("process.exit(0)");
  const [action] = f.workflows.store.list(f.id);
  f.workflows.store.patch(action.id, { origin: { kind: "routine" } });
  const view = await history();
  assert.deepEqual(remote(view.messages), []);
  assert.equal(view.events.find((e) => e.id === id).runNotes.length, 1);
});

test("a hook run's SSH rows stay out of the transcript", async (t) => {
  const { f, history } = await routineChat(t);
  f.workflows.store.reserve({
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    attemptId: null,
    origin: { kind: "hook", hookId: "hook-1", eventId: "event-1" },
    key: "hook-ssh",
    state: "completed",
    expiresAt: Date.now(),
    payload: {
      action: "ssh",
      trusted: true,
      accessId: hostId,
      hostName: "opnsense",
      commandPreview: "uptime",
      command: "uptime",
      originClass: "hook",
    },
    result: { exitCode: 0, durationMs: 5 },
    chatNotes: { result: { at: Date.now(), state: "completed" } },
    settled: true,
  });
  assert.deepEqual(remote((await history()).messages), []);
});

test("a routine run's memory note joins its event row", async (t) => {
  const { f, run, history, results } = await routineChat(t);
  const id = await run("process.exit(0)");
  const at = results[0].at;
  const runtime = f.store.getAssistant(f.id).runtimeAgentId;
  const notes = [
    {
      id: `memory-note:agent:${runtime}:cron:job-1:run:r1:shared-write`,
      role: "event",
      event: "memory-note",
      reason: "shared-write",
      timestamp: at,
      runId: null,
    },
    {
      id: "memory-note:attempt-1:shared-write",
      role: "event",
      event: "memory-note",
      reason: "shared-write",
      timestamp: at,
      runId: null,
    },
  ];
  f.assistants.memoryNotes = { forConversation: () => notes };
  const view = await history();
  assert.deepEqual(
    view.messages.filter((m) => m.event === "memory-note").map((m) => m.id),
    ["memory-note:attempt-1:shared-write"],
  );
  assert.deepEqual(
    view.events.find((e) => e.id === id).runNotes.map((n) => n.event),
    ["ssh-run", "memory-note"],
  );
});
