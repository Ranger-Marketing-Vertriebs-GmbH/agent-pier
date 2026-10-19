import test from "node:test";
import assert from "node:assert/strict";
import { leadRoutineFixture as setup } from "../helpers/lead-routine-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { resultTurn } from "../../server/features/assistants/member-result-writes.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";

const reports = (f) =>
  f.service.requests.store.list(f.parent.id).filter((r) => r.type === "report");
const followUps = (f) =>
  f.assistants.ledger
    .requests(f.chat.id)
    .filter((x) => x.clientRequestId.startsWith("lead-request-result:"));

test("a finished run reaches the lead as an attributed member result", async (t) => {
  const f = await setup(t);
  const created = await f.create();
  f.idle();
  await f.run(created.id);
  // The run shows in the member's chat as routines do.
  const memberChat = mainConversation(f.store, f.member.id);
  const [shown] = f.routines.results.forConversation(memberChat.id);
  assert.equal(shown.name, "Inbox check");
  assert.equal(shown.text, "Two new requests arrived.");
  const [report] = reports(f);
  assert.equal(report.phase, "completed");
  assert.equal(report.memberName, "Member 1");
  assert.equal(report.answer, "Two new requests arrived.");
  assert.deepEqual(report.origin, {
    kind: "member-routine",
    bindingId: created.id,
    name: "Inbox check",
  });
  await f.service.reconcile();
  const [followUp] = followUps(f);
  assert.equal(followUp.clientRequestId, `lead-request-result:${report.id}`);
  assert.match(followUp.text, /^Report from Member 1 · routine "Inbox check"/);
  assert.match(followUp.text, /not a new owner instruction/);
  assert.match(followUp.text, /Two new requests arrived\./);
  assert.equal(f.service.store.context(followUp.id).kind, "member-result");
  // Shown in Work → Teams with the routine's name.
  const card = f.service.requests.list(f.parent.id).find((r) => r.id === report.id);
  assert.equal(card.type, "report");
  assert.equal(card.memberRoutine, "Inbox check");
  // The lead's follow-up on it acts like the lead's own work (member-result-writes.js).
  const attempt = f.assistants.ledger.pending().find((a) => a.requestId === followUp.id);
  assert.equal(resultTurn(f.assistants, report.id, attempt.id)?.id, report.id);
  // A replayed completion reports nothing twice.
  const runAtMs = Date.parse(report.startedAt);
  await f.run(created.id, { runAtMs });
  assert.equal(reports(f).length, 1);
});

test("a failed run is reported once until the routine works again; silence stays silent", async (t) => {
  const f = await setup(t);
  const created = await f.create();
  let at = 1_000_000;
  const run = (event) => f.run(created.id, { runAtMs: (at += 1000), ...event });
  await run({ summary: "NO_REPLY" });
  assert.equal(reports(f).length, 0, "nothing to report");
  await run({ status: "error", summary: undefined });
  await run({ status: "error", summary: undefined });
  assert.deepEqual(
    reports(f).map((r) => [r.phase, r.diagnostic]),
    [["failed", "ROUTINE_FAILED"]],
  );
  await run({});
  await run({ status: "error", summary: undefined });
  assert.deepEqual(
    reports(f).map((r) => r.phase),
    ["failed", "completed", "failed"],
  );
  f.idle();
  await f.service.reconcile();
  assert.match(followUps(f)[0].text, /failed; later failures are not reported/);
});

test("a lead routine's run writes only with the owner's switch or an autonomous lead", async (t) => {
  const f = await setup(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const created = await f.create();
  const binding = f.routines.bindings.get(created.id);
  const write = (path = "notes/report.md") =>
    bridge.toolPolicy({
      agentId: f.member.runtimeAgentId,
      sessionKey: `agent:${f.member.runtimeAgentId}:cron:${binding.nativeId}:run:r1`,
      toolName: "write",
      path,
    }).allow;
  assert.equal(write(), false, "read-only by default");
  assert.equal(write("MEMORY.md"), false);
  const updated = await f.routines.update(f.member.id, created.id, {
    writes: true,
    revision: created.revision,
  });
  assert.equal(write(), true, "the owner's May write");
  await f.routines.update(f.member.id, created.id, {
    writes: false,
    revision: updated.revision,
  });
  assert.equal(write(), false);
  const policy = f.service.store.policy(f.parent.id);
  f.service.store.savePolicy(f.parent.id, { usage: "autonomous" }, policy.revision);
  assert.equal(write(), true, "an autonomous lead");
});

test("lead routines end when the member is archived or the lead goes, audited", async (t) => {
  for (const who of ["member", "lead"]) {
    await t.test(who, async (t) => {
      const f = await setup(t);
      const created = await f.create();
      const binding = f.routines.bindings.get(created.id);
      const session = `agent:${f.member.runtimeAgentId}:cron:${binding.nativeId}:run:r1`;
      assert.ok(f.routines.runOrigin(f.member, session));
      if (who === "member")
        await f.service.lifecycle(
          "archive",
          f.permanent.id,
          f.service.store.member(f.permanent.id).revision,
        );
      else {
        const lead = f.store.getAssistant(f.parent.id);
        f.store.db
          .prepare("UPDATE assistants SET body=? WHERE id=?")
          .run(
            JSON.stringify({ ...lead, archivedAt: new Date().toISOString() }),
            lead.id,
          );
      }
      // Ended at once: no tools, no writes, no report.
      if (who === "lead") assert.equal(f.routines.runOrigin(f.member, session), null);
      await f.run(created.id).catch(() => {});
      assert.equal(reports(f).length, 0);
      await f.routines.lead.prune();
      assert.equal(f.routines.bindings.get(created.id).state, "removed");
      assert.equal(f.jobs.size, 0);
      const audit = f.audits.findLast((e) => e.details?.kind === "lead-routine");
      assert.deepEqual(
        [audit.details.change, audit.details.by, audit.details.reason],
        ["remove", "system", `${who}-archived`],
      );
      // At most every 30 seconds; nothing is left to prune anyway.
      await f.routines.lead.prune();
    });
  }
});
