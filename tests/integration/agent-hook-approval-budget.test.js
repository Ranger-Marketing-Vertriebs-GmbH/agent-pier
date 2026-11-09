import test from "node:test";
import assert from "node:assert/strict";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
  settle,
} from "../helpers/agent-hook-fixture.js";
import { eventArea } from "../../server/features/assistants/agent-event-area.js";
import {
  approvalRunSeconds,
  hookRunSeconds,
} from "../../server/features/assistants/agent-hook-runs.js";

// A hook run whose shell asks the owner gets 30 minutes, so the owner can decide;
// a run that timed out on an undecided approval says so instead of the generic line.

function approvalFixture(t) {
  const f = hookFixture(t);
  const revision = () => f.store.getAssistant(f.id).revision;
  f.store.updateAssistant(f.id, { shell: "approval" }, revision());
  const actions = [];
  f.assistants.workflows.store = {
    list: (id) => actions.filter((a) => !id || a.assistantId === id),
  };
  const approval = (running, state, extra = {}) =>
    actions.push({
      id: `action-${actions.length + 1}`,
      assistantId: f.id,
      state,
      payload: {
        action: "exec",
        sessionKey: `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`,
        ...extra,
      },
    });
  return { ...f, approval };
}
const timedOut = {
  status: "error",
  error: "cron: job execution timed out (last phase: tool-execution-started)",
};
const timeoutLine = {
  de: "Der Hook Zabbix hat auf deine Freigabe gewartet und ist nach 30 Minuten abgelaufen. Der Befehl wurde nicht ausgeführt.",
};

test("a hook run with shell approval gets 30 minutes; other runs keep 5", async (t) => {
  assert.equal(approvalRunSeconds, 1800);
  assert.equal(hookRunSeconds({ shell: "approval" }), 1800);
  assert.equal(hookRunSeconds({ shell: "full" }), 300);
  assert.equal(hookRunSeconds({ shell: "off" }), 300);
  const f = approvalFixture(t);
  await f.hooks.deliver(
    makeHook(f, { name: "Shell", rights: { shell: "approval" } }),
    body('{"id":"p1"}'),
  );
  await f.hooks.deliver(makeHook(f, { name: "Plain" }), body('{"id":"p2"}'));
  const adds = f.calls.filter((c) => c.method === "cron.add");
  assert.deepEqual(
    adds.map((c) => [c.input.name, c.input.payload.timeoutSeconds]),
    [
      ["Hook Shell", 1800],
      ["Hook Plain", 300],
    ],
  );
});

test("a timed-out run with an undecided approval tells the owner it waited", async (t) => {
  for (const state of ["awaiting_approval", "cancelled", "expired"]) {
    const f = approvalFixture(t);
    const hook = makeHook(f, { rights: { shell: "approval", telegram: true } });
    await f.hooks.deliver(hook, body('{"id":"p1"}'));
    const running = event(f, hook, "p1");
    assert.equal(running.runSeconds, 1800);
    f.approval(running, state);
    await f.hooks.runs.complete(running.id, done(running.jobId, timedOut));
    await settle();
    const settled = f.hooks.events.get(running.id);
    assert.equal(settled.status, "failed");
    assert.equal(settled.failure, "approval-timeout", state);
    const [entry] = f.service.outbox.all(f.channel.id);
    assert.equal(entry.text, timeoutLine.de, state);
    const [row] = eventArea(f.assistants, f.reminders.mainConversation(f.id));
    assert.equal(row.approvalTimeoutMinutes, 30);
  }
});

test("other failures keep the generic failure line", async (t) => {
  const cases = [
    // Timed out, but the owner had decided the command.
    ["completed", timedOut],
    // An undecided approval of another run.
    ["other-run", timedOut],
    // An undecided approval, but the run failed for another reason.
    ["awaiting_approval", { status: "error", error: "429 Too Many Requests" }],
  ];
  for (const [state, completion] of cases) {
    const f = approvalFixture(t);
    const hook = makeHook(f, { rights: { shell: "approval", telegram: true } });
    await f.hooks.deliver(hook, body('{"id":"p1"}'));
    const running = event(f, hook, "p1");
    if (state === "other-run") f.approval({ jobId: "another-job" }, "awaiting_approval");
    else f.approval(running, state);
    await f.hooks.runs.complete(running.id, done(running.jobId, completion));
    await settle();
    const settled = f.hooks.events.get(running.id);
    assert.equal(settled.status, "failed");
    assert.equal("failure" in settled, false, state);
    const [entry] = f.service.outbox.all(f.channel.id);
    assert.equal(
      entry.text,
      "Der Hook Zabbix konnte nicht ausgeführt werden. Prüfe seine Ereignisse im Chat des Agenten.",
    );
    const [row] = eventArea(f.assistants, f.reminders.mainConversation(f.id));
    assert.equal("approvalTimeoutMinutes" in row, false);
  }
});

test("an approval run's event is stale only after three times its budget", async (t) => {
  const f = approvalFixture(t);
  const hook = makeHook(f, { rights: { shell: "approval" } });
  const timers = [];
  f.hooks.runs.later = (run, ms) => {
    timers.push({ run, ms });
    return timers.length;
  };
  // Received 16 minutes ago, its job gone: a 5-minute run would be stale by now.
  let clock = Date.now() - 16 * 60000;
  f.hooks.events.now = () => clock;
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  f.jobs.delete(running.jobId);
  clock += 16 * 60000;
  await f.hooks.runs.reconcile();
  assert.equal(f.hooks.events.get(running.id).status, "running");
  const sweep = timers.at(-1);
  assert.ok(sweep.ms > 73 * 60000 && sweep.ms <= 75 * 60000, String(sweep.ms));
  clock += sweep.ms;
  await f.hooks.runs.reconcile();
  assert.equal(f.hooks.events.get(running.id).status, "failed");
});

test("Hermes hook runs keep 5 minutes: Hermes enforces no budget and asks for 5", () => {
  const hermes = { runtime: "hermes" };
  assert.equal(hookRunSeconds({ shell: "approval" }, hermes), 300);
  assert.equal(hookRunSeconds({ shell: "approval" }, { runtime: "openclaw" }), 1800);
  assert.equal(hookRunSeconds({ shell: "approval" }, {}), 1800);
});

test("the budget follows the shell level capped by the agent's", async (t) => {
  const budget = async (f, hook, id) => {
    await f.hooks.deliver(f.hooks.store.get(hook.id), body(`{"id":"${id}"}`));
    return event(f, hook, id).runSeconds;
  };
  const level = (f, fields) =>
    f.store.updateAssistant(f.id, fields, f.store.getAssistant(f.id).revision);

  // Every command (approval with the strict flag) still asks the owner.
  const strict = approvalFixture(t);
  level(strict, { shellEveryCommand: true });
  assert.equal(strict.store.getAssistant(strict.id).shellEveryCommand, true);
  const asks = makeHook(strict, { rights: { shell: "approval" } });
  assert.equal(await budget(strict, asks, "p1"), 1800);

  // A hook saved with Full access on an agent now at With approval runs with approval.
  const lowered = approvalFixture(t);
  level(lowered, { shell: "full" });
  const full = makeHook(lowered, { rights: { shell: "full" } });
  level(lowered, { shell: "approval" });
  assert.equal(await budget(lowered, full, "p1"), 1800);

  // A hook saved With approval on an agent now at Full access fails closed (shell
  // off, effectiveShell), so it keeps 5 minutes.
  const raised = approvalFixture(t);
  const approval = makeHook(raised, { rights: { shell: "approval" } });
  level(raised, { shell: "full" });
  assert.equal(await budget(raised, approval, "p1"), 300);
  const tools = raised.calls.filter((c) => c.method === "cron.add").at(-1).input
    .payload.toolsAllow;
  assert.equal(tools.includes("exec"), false);
});

test("a cancel at the run's end recorded as an unattributed decline still counts", async (t) => {
  for (const [result, expected] of [
    [{ decision: "deny", unattributed: true }, "approval-timeout"],
    // The owner's own deny (decideExec) is never unattributed.
    [{ decision: "deny" }, undefined],
  ]) {
    const f = approvalFixture(t);
    const hook = makeHook(f, { rights: { shell: "approval", telegram: true } });
    await f.hooks.deliver(hook, body('{"id":"p1"}'));
    const running = event(f, hook, "p1");
    f.approval(running, "declined");
    f.assistants.workflows.store.list(f.id).at(-1).result = result;
    await f.hooks.runs.complete(running.id, done(running.jobId, timedOut));
    await settle();
    assert.equal(f.hooks.events.get(running.id).failure, expected);
  }
});
