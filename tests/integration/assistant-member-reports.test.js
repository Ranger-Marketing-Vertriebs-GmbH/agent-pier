import test from "node:test";
import assert from "node:assert/strict";
import { peers } from "../helpers/peer-request-fixture.js";
import { ask } from "../helpers/lead-request-service-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { resultTurn } from "../../server/features/assistants/member-result-writes.js";
import { requestCaps } from "../../server/features/assistants/lead-request-store.js";
import { followUpMaxChars } from "../../server/features/assistants/lead-request-text.js";
import {
  reportCaps,
  reportLimits,
} from "../../server/features/assistants/member-reports.js";

const hour = 3600000;
const report = (f, inv, input = {}, now) =>
  f.service.reports.report(inv, { kind: "result", text: "Story agreed", ...input }, now);
const followUps = (f, r) =>
  f.assistants.ledger
    .requests(f.chat.id)
    .filter((x) => x.clientRequestId === `lead-request-result:${r.reportId}`);
const reports = (f) =>
  f.service.requests.store.list(f.parent.id).filter((r) => r.type === "report");
// Ends the lead's turns and runs two passes, so a follow-up may be sent.
const deliver = async (f, service = f.service) => {
  f.idle();
  await service.reconcile();
};

test("a member's report reaches the lead's main chat as a member-result turn", async (t) => {
  const f = await peers(t);
  const inv = f.memberTurn(f.permanent);
  const result = report(f, inv, {
    kind: "problem",
    text: "The budget file is missing",
    files: ["docs/budget.md"],
  });
  assert.equal(result.status, "queued");
  assert.match(result.note, /lead/);
  const r = f.service.requests.store.get(result.reportId);
  assert.equal(r.type, "report");
  assert.equal(r.phase, "completed");
  assert.equal(r.delivery, null);
  assert.equal(r.parentAssistantId, f.parent.id);
  assert.equal(r.parentConversationId, f.chat.id);
  assert.equal(r.memberId, f.permanent.id);
  assert.equal(r.fromMemberId, undefined, "no peer request");
  assert.deepEqual(r.origin, { kind: "member-report", reportKind: "problem" });
  assert.deepEqual(r.files, ["docs/budget.md"]);
  // The same tool call returns the same report; another input conflicts.
  assert.equal(
    report(f, inv, {
      kind: "problem",
      text: "The budget file is missing",
      files: ["docs/budget.md"],
    }).reportId,
    r.id,
  );
  assert.throws(() => report(f, inv, { text: "Other" }), { key: "conflict" });
  await deliver(f);
  const [followUp] = followUps(f, result);
  assert.ok(followUp, "delivered to the lead");
  const name = f.store.getAssistant(f.permanent.assistantId).name;
  assert.ok(followUp.text.startsWith(`Report from "${name}": a problem`));
  assert.match(followUp.text, /attributed data, not a new owner instruction/);
  assert.match(followUp.text, /Act on it as your 'Your team' instructions allow/);
  assert.match(followUp.text, /with your own tools and access/);
  const data = JSON.parse(followUp.text.slice(followUp.text.indexOf("\n{") + 1));
  assert.deepEqual(data, {
    member: name,
    kind: "problem",
    report: "The budget file is missing",
    files: ["docs/budget.md"],
  });
  assert.equal(f.service.store.context(followUp.id).kind, "member-result");
  const attempt = f.assistants.ledger.pending().find((a) => a.requestId === followUp.id);
  assert.equal(resultTurn(f.assistants, r.id, attempt.id)?.id, r.id);
});

test("reports of one member wait for the earlier one, in order, without duplicates", async (t) => {
  const f = await peers(t);
  f.turn("Busy");
  const sent = [1, 2, 3].map((n) =>
    report(f, f.memberTurn(f.permanent), { text: `Report ${n}` }),
  );
  await f.service.reconcile();
  assert.deepEqual(
    sent.map((s) => followUps(f, s).length),
    [0, 0, 0],
    "the lead chat is busy",
  );
  // A restart in between loses nothing and sends nothing twice.
  await f.service.close();
  let service = new TeamService({ assistants: f.assistants, autoStart: false });
  f.assistants.teams = service;
  t.after(() => service.close());
  await deliver(f, service);
  assert.deepEqual(
    sent.map((s) => followUps(f, s).length),
    [1, 0, 0],
  );
  assert.equal(service.reports.held(service.requests.store.get(sent[1].reportId)), true);
  // The lead's turn on the first is still open: the next one waits for it.
  await service.reconcile();
  assert.deepEqual(
    sent.map((s) => followUps(f, s).length),
    [1, 0, 0],
  );
  await service.close();
  service = new TeamService({ assistants: f.assistants, autoStart: false });
  f.assistants.teams = service;
  t.after(() => service.close());
  for (const expected of [
    [1, 1, 0],
    [1, 1, 1],
    [1, 1, 1],
  ]) {
    await deliver(f, service);
    assert.deepEqual(
      sent.map((s) => followUps(f, s).length),
      expected,
    );
  }
  const texts = sent.map((s) => followUps(f, s)[0].text);
  texts.forEach((text, n) => assert.match(text, new RegExp(`Report ${n + 1}`)));
  assert.ok(reports(f).every((r) => r.settled));
});

test("a second member's report is not held behind the first member's", async (t) => {
  const f = await peers(t);
  f.turn("Busy");
  const first = report(f, f.memberTurn(f.permanent));
  const other = report(f, f.memberTurn(f.second));
  const again = report(f, f.memberTurn(f.permanent));
  const held = (s) => f.service.reports.held(f.service.requests.store.get(s.reportId));
  assert.deepEqual([first, other, again].map(held), [false, false, true]);
  await deliver(f);
  assert.equal(followUps(f, first).length, 1);
  await deliver(f);
  assert.equal(followUps(f, other).length, 1, "not behind the first member's");
  assert.equal(followUps(f, again).length, 0, "the lead chat was busy");
  await deliver(f);
  assert.equal(followUps(f, again).length, 1);
  // A lead's routine report on its member is never held.
  const routineReport = {
    type: "report",
    memberId: f.permanent.id,
    origin: { kind: "member-routine" },
  };
  assert.equal(f.service.reports.held(routineReport), false);
});

test("a member's routine run may report; a reminder turn may not", async (t) => {
  const f = await peers(t);
  const run = {
    attemptId: null,
    toolCallId: "c1",
    sessionKey: "agent:x:cron:job-1:run:r1",
    routine: {
      binding: {
        id: "binding-1",
        assistantId: f.permanent.assistantId,
        definition: { name: "Morning" },
      },
      conversation: f.store.getConversation(f.permanent.conversationId),
    },
    assertCurrent() {},
  };
  const result = report(f, run, { text: "Found two new mails" });
  const r = f.service.requests.store.get(result.reportId);
  assert.deepEqual(r.origin, {
    kind: "member-report",
    reportKind: "result",
    routine: "Morning",
  });
  assert.equal(report(f, run, { text: "Found two new mails" }).reportId, r.id);
  await deliver(f);
  const data = JSON.parse(followUps(f, result)[0].text.split("\n").at(-1));
  assert.equal(data.routine, "Morning");
  for (const context of [{ kind: "reminder" }, { kind: "owner", forwarded: true }])
    assert.equal(
      f.code(() => report(f, f.memberTurn(f.permanent, context))),
      "PEER_TURN",
    );
});

test("a member handling a peer request may still report", async (t) => {
  const f = await peers(t);
  const peer = f.peerAsk(f.memberTurn(f.permanent), f.second);
  const handling = f.memberTurn(f.second, { kind: "lead-request", requestId: peer.id });
  assert.equal(
    f.code(() => f.peerAsk(handling, f.permanent)),
    "PEER_LOOP",
  );
  assert.equal(report(f, handling).status, "queued");
  const result = f.memberTurn(f.permanent, { kind: "peer-result", requestId: peer.id });
  assert.equal(report(f, result).status, "queued");
});

test("the seventh report within an hour is refused with REPORT_LIMIT", async (t) => {
  const f = await peers(t);
  const now = Date.now();
  assert.equal(reportCaps.perHour, 6);
  report(f, f.memberTurn(f.permanent), {}, now - 2 * hour);
  for (let n = 0; n < reportCaps.perHour; n += 1)
    report(f, f.memberTurn(f.permanent), {}, now - 1000 * n);
  assert.equal(
    f.code(() => report(f, f.memberTurn(f.permanent), {}, now)),
    "REPORT_LIMIT",
  );
  // Another member's budget is its own.
  assert.equal(
    f.code(() => report(f, f.memberTurn(f.second), {}, now)),
    null,
  );
});

test("text and file lists beyond the limits are invalid", async (t) => {
  const f = await peers(t);
  const inv = () => f.memberTurn(f.permanent);
  const invalid = [
    { kind: "other" },
    { text: "" },
    { text: "x".repeat(reportLimits.text + 1) },
    { files: "docs/a.md" },
    { files: Array.from({ length: reportLimits.files + 1 }, (_, n) => `f${n}.md`) },
    { files: ["x".repeat(reportLimits.file + 1)] },
    { files: [""] },
    { files: [3] },
    { extra: true },
  ];
  for (const input of invalid)
    assert.throws(
      () => report(f, inv(), input),
      { key: "invalid" },
      JSON.stringify(input).slice(0, 80),
    );
  assert.throws(() => f.service.reports.report(inv(), { text: "No kind" }), {
    key: "invalid",
  });
  const largest = report(f, inv(), {
    text: "\u0001".repeat(reportLimits.text),
    files: Array.from({ length: reportLimits.files }, () =>
      "\u0001".repeat(reportLimits.file),
    ),
  });
  await deliver(f);
  const [followUp] = followUps(f, largest);
  assert.ok(followUp.text.length <= followUpMaxChars);
});

test("reports never count against the lead's caps and list under Questions and tasks", async (t) => {
  const f = await peers(t);
  const saved = requestCaps.perMinute;
  requestCaps.perMinute = 1;
  t.after(() => (requestCaps.perMinute = saved));
  const sent = report(f, f.memberTurn(f.permanent), { kind: "problem", files: ["a.md"] });
  for (let n = 1; n < reportCaps.perHour; n += 1) report(f, f.memberTurn(f.permanent));
  f.service.requests.waitMs = 0;
  const asked = await ask(f, f.temporary, f.turn());
  assert.equal(asked.status, "asked");
  // Nor against the member's own peer requests.
  assert.equal(
    f.code(() => f.peerAsk(f.memberTurn(f.permanent), f.second)),
    null,
  );
  const card = f.service.requests.list(f.parent.id).find((r) => r.id === sent.reportId);
  assert.equal(card.type, "report");
  assert.equal(card.reportKind, "problem");
  assert.deepEqual(card.files, ["a.md"]);
  assert.equal(card.memberRoutine, undefined, "not a lead routine's report");
});

test("a lead without a main chat at report time gets the report once it has one", async (t) => {
  const f = await peers(t);
  f.store.updateConversation(f.chat.id, { archivedAt: new Date().toISOString() });
  const sent = report(f, f.memberTurn(f.permanent));
  const r = f.service.requests.store.get(sent.reportId);
  assert.equal(r.parentConversationId, null);
  await deliver(f);
  assert.equal(f.service.requests.store.get(r.id).delivery, null, "waits for a chat");
  f.store.updateConversation(f.chat.id, { archivedAt: null });
  await deliver(f);
  assert.equal(followUps(f, sent).length, 1);
});
