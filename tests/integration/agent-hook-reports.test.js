import test from "node:test";
import assert from "node:assert/strict";
import { leadRoutineFixture } from "../helpers/lead-routine-fixture.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { resultTurn } from "../../server/features/assistants/member-result-writes.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";
import { done } from "../helpers/agent-hook-fixture.js";

const secret = "PAYLOAD-SECRET-9f3a";

// The lead fixture's permanent member (or the lead itself) with the hook service.
async function setup(t, { own = false } = {}) {
  const f = await leadRoutineFixture(t);
  f.assistants.workflows = {
    access: { get: () => ({ projectIds: [], sshAccesses: [] }), sshHosts: () => [] },
    folders: { ownAndShared: () => ({}) },
    close() {},
  };
  f.assistants.gatewayEvents = new GatewayEventHub();
  const hooks = new AgentHooks({
    reminders: f.reminders,
    routines: f.routines,
    notifications: { notify: async () => {} },
    addresses: (id) => ({ local: `http://127.0.0.1:4380/hooks/${id}` }),
  });
  t.after(() => hooks.runs.close());
  // Both the member and the lead have a main chat and reminders on.
  const agentId = own ? f.parent.id : f.member.id;
  for (const id of [f.parent.id, f.member.id]) {
    const a = f.store.getAssistant(id);
    f.store.updateAssistant(
      id,
      { capabilities: { ...a.capabilities, memory: true, reminders: true } },
      a.revision,
    );
    mainConversation(f.store, id) || f.store.createConversation?.(id);
  }
  const { hook } = hooks.create(agentId, { name: "Zabbix", sender: "zabbix01" });
  const stored = () => hooks.store.get(hook.id);
  // A hook event running as the Gateway would have it (job started).
  let n = 0;
  const complete = async (extra = {}, reply) => {
    const id = `evt-${++n}`;
    const { event } = hooks.events.admit(stored(), {
      eventId: id,
      payload: `{"alert":"${secret}"}`,
      size: 30,
      contentType: "application/json",
      source: "local",
    });
    hooks.events.patch(event.id, { status: "running", jobId: `job-${n}` });
    await hooks.runs.complete(event.id, {
      ...done(`job-${n}`, { runAtMs: 1000 + n }),
      ...(reply === undefined ? {} : { summary: reply }),
      ...extra,
    });
    return event;
  };
  const reports = () =>
    f.service.requests.store.list(f.parent.id).filter((r) => r.type === "report");
  return { ...f, hooks, hook, stored, complete, reports };
}

test("a member's hook result reaches its lead as one read-only report", async (t) => {
  const f = await setup(t);
  const event = await f.complete();
  const [report] = f.reports();
  assert.equal(report.phase, "completed");
  assert.equal(report.memberName, "Member 1");
  assert.equal(report.text, "Hook Zabbix from zabbix01");
  assert.deepEqual(report.origin, {
    kind: "member-hook",
    hookId: f.hook.id,
    name: "Zabbix",
  });
  assert.equal(report.writeAllowed, false);
  const chat = mainConversation(f.store, f.parent.id);
  assert.equal(report.parentConversationId, chat.id);
  const card = f.service.requests.list(f.parent.id).find((r) => r.id === report.id);
  assert.equal(card.memberHook, "Zabbix");
  assert.equal(
    f.service.store.db
      .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
      .get(`lead-hook-report:${event.id}`).id,
    report.id,
  );
  f.idle();
  await f.service.reconcile();
  const followUp = f.assistants.ledger
    .requests(f.chat.id)
    .find((x) => x.clientRequestId === `lead-request-result:${report.id}`);
  assert.match(followUp.text, /^Report from Member 1 · hook "Zabbix"/);
  assert.match(followUp.text, /read-only/);
});

test("a replayed hook completion reports nothing twice", async (t) => {
  const f = await setup(t);
  const event = await f.complete();
  await f.hooks.runs.complete(event.id, done("job-1", { runAtMs: 1001 }));
  assert.equal(f.reports().length, 1);
});

test("an agent that is not a team member reports to nobody", async (t) => {
  const f = await setup(t, { own: true });
  await f.complete();
  assert.equal(f.reports().length, 0);
});

test("the payload text never appears in the report record", async (t) => {
  const f = await setup(t);
  await f.complete({}, "Handled the alert.");
  const [report] = f.reports();
  assert.ok(report);
  assert.equal(JSON.stringify(report).includes(secret), false);
  const rows = f.service.store.db
    .prepare("SELECT body FROM assistant_team_records")
    .all();
  assert.equal(JSON.stringify(rows).includes(secret), false);
});

test("a failed hook run is reported once until it succeeds again; silence stays silent", async (t) => {
  const f = await setup(t);
  await f.complete({}, "NO_REPLY");
  assert.equal(f.reports().length, 0, "nothing to report");
  const revision = f.stored().revision;
  await f.complete({ status: "error", summary: undefined });
  await f.complete({ status: "error", summary: undefined });
  assert.deepEqual(
    f.reports().map((r) => [r.phase, r.diagnostic]),
    [["failed", "HOOK_FAILED"]],
  );
  assert.equal(f.stored().leadReportFailing, true);
  assert.equal(f.stored().revision, revision, "the flag does not bump the revision");
  await f.complete();
  assert.equal(f.stored().leadReportFailing, false);
  assert.equal(f.stored().revision, revision);
  await f.complete({ status: "error", summary: undefined });
  assert.deepEqual(
    f.reports().map((r) => r.phase),
    ["failed", "completed", "failed"],
  );
});

test("the lead's follow-up turn on a hook report cannot write, on a routine report it can", async (t) => {
  const f = await setup(t);
  // One follow-up is delivered at a time: each report is handed over and checked.
  const turn = async (report) => {
    f.idle();
    await f.service.reconcile();
    const request = f.assistants.ledger
      .requests(f.chat.id)
      .find((x) => x.clientRequestId === `lead-request-result:${report.id}`);
    const attempt = f.assistants.ledger.pending().find((a) => a.requestId === request.id);
    return resultTurn(f.assistants, report.id, attempt.id);
  };
  await f.complete();
  const [hookReport] = f.reports();
  assert.equal(hookReport.origin.kind, "member-hook");
  assert.equal(await turn(hookReport), null);
  const created = await f.create();
  await f.run(created.id);
  const routineReport = f.reports().find((r) => r.origin.kind === "member-routine");
  assert.equal((await turn(routineReport))?.id, routineReport.id);
});
