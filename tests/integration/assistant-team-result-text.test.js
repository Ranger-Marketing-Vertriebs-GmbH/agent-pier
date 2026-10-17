import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import {
  synthesisMaxChars,
  synthesisPrompt,
} from "../../server/features/assistants/team-results.js";

// Longer than OpenClaw's 8000-character history page and the old 6000 cap.
const long = (label, size = 10000) =>
  `${label}: ${"finding, with detail. ".repeat(size / 22)}end of ${label}.`;
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
async function finishedTeam(t, replies) {
  const f = teamFixture(t),
    { team, attempt, chat } = await f.proposal({ count: replies.length });
  await f.service.reconcile();
  f.service.store
    .members(team.id)
    .forEach((m, n) => f.complete(m.attemptId, "ok", replies[n]));
  await f.service.reconcile();
  return { f, team, attempt, chat };
}
const synthesisOf = (f, chat, team) =>
  f.assistants.ledger
    .requests(chat.id)
    .find((r) => r.clientRequestId === `team-result:${team.id}`);

test("a 10,000-character member report reaches the result batch and the lead's prompt whole", async (t) => {
  const report = long("Report");
  assert.ok(report.length > 10000);
  const { f, team, attempt, chat } = await finishedTeam(t, [[report]]);
  // The record keeps an excerpt; the whole report has its own row.
  const stored = f.service.store.get(team.id);
  const [entry] = stored.resultBatch;
  assert.equal(entry.text, Array.from(report).slice(0, 2000).join(""));
  assert.equal(entry.truncated, true);
  assert.equal(entry.cut, undefined);
  assert.deepEqual(f.service.report(team.id, entry.memberId), {
    memberId: entry.memberId,
    text: report,
  });
  assert.ok(JSON.stringify(f.service.list().teams).length < 4000);
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  await f.service.reconcile();
  const synthesis = synthesisOf(f, chat, team);
  assert.ok(synthesis.text.includes(JSON.stringify(report)));
  assert.ok(!synthesis.text.includes('"shortened"'));
});

test("the final answer is the run's last reply, not the text before its tool calls", async (t) => {
  const { f, team } = await finishedTeam(t, [
    ["Let me check the files.", "Final report"],
  ]);
  assert.equal(f.service.store.get(team.id).resultBatch[0].text, "Final report");
});

test("a report beyond the history limit is cut by code point and marked", async (t) => {
  // OpenClaw's single read cuts at 65536 code units, inside the emoji.
  const report = `${"a".repeat(65535)}😀 and more`;
  const { f, team, attempt, chat } = await finishedTeam(t, [[report]]);
  const [entry] = f.service.store.get(team.id).resultBatch;
  assert.equal(f.service.report(team.id, entry.memberId).text, "a".repeat(65535));
  assert.equal(entry.cut, true);
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  await f.service.reconcile();
  const synthesis = synthesisOf(f, chat, team);
  assert.ok(synthesis.text.length <= synthesisMaxChars);
  assert.match(synthesis.text, /"shortened":true/);
  assert.match(synthesis.text, /whole report is in that member's own chat/);
});

test("eight long reports fit the lead's prompt, the longest shortened first", () => {
  const resultBatch = Array.from({ length: 8 }, (_, n) => ({
    memberId: `m${n}`,
    name: `Member ${n}`,
    role: "Review",
    phase: "completed",
    reportAvailable: true,
    // Quotes and newlines grow under JSON escaping; one emoji per report.
    text: n ? `${'"line"\n'.repeat(3000)}😀${"x".repeat(n * 1000)}` : "Short report",
  }));
  const text = synthesisPrompt({ objective: "Review", resultBatch });
  assert.ok(text.length <= synthesisMaxChars);
  assert.ok(text.length > synthesisMaxChars - 200, "the budget is used");
  const sent = JSON.parse(text.slice(text.indexOf("\n[") + 1));
  assert.deepEqual(sent[0], { ...resultBatch[0] });
  for (const entry of sent.slice(1)) {
    assert.equal(entry.shortened, true);
    assert.ok(!lone.test(entry.text), "no surrogate pair is split");
  }
  // One common length: the shortened reports are equally long.
  assert.equal(new Set(sent.slice(1).map((e) => Array.from(e.text).length)).size, 1);
  assert.match(text, /whole report is in that member's own chat/);
});

test("a provider refusal of the synthesis is retried, not given up", async (t) => {
  const { f, team, attempt } = await finishedTeam(t, [["Report"]]);
  f.assistants.ledger.transition(attempt.id, "completed");
  const send = f.assistants.send.bind(f.assistants);
  let sends = 0;
  f.assistants.send = async (...args) => {
    // As a model account that cannot sign in right now (assistantProblem's 400).
    if (++sends === 1) throw Object.assign(Error("provider"), { status: 400 });
    return send(...args);
  };
  await f.service.reconcile();
  assert.equal(f.service.store.get(team.id).resultState, "queued");
  await f.service.reconcile();
  assert.equal(sends, 2);
  assert.ok(f.service.store.get(team.id).resultAttemptId);
});

test("a synthesis that send would refuse ends visibly instead of looping", async (t) => {
  const { f, team, attempt } = await finishedTeam(t, [["Report"]]);
  // JSON escapes a report's NUL; only text outside the batch can still carry one.
  f.service.store.write(f.service.store.get(team.id), { objective: "Plan \0" });
  f.assistants.ledger.transition(attempt.id, "completed");
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  let sends = 0;
  f.assistants.send = async () => sends++;
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(sends, 0);
  const stored = f.service.store.get(team.id);
  assert.equal(stored.resultState, "unsent");
  assert.equal(stored.resultDiagnostic, "RESULT_UNSENDABLE");
  assert.ok(warnings.some((w) => w.includes(team.id)));
});

test("many coding runs are shortened too, so the synthesis always fits", () => {
  const run = (n) => ({
    actionId: `a${n}`,
    state: "awaiting_approval",
    project: "Shop",
    pipeline: "Build",
    task: "t".repeat(500),
    pending: true,
  });
  const resultBatch = Array.from({ length: 8 }, (_, n) => ({
    memberId: `m${n}`,
    name: `Member ${n}`,
    role: "Build",
    phase: "completed",
    reportAvailable: true,
    text: "r".repeat(20000),
    codingRuns: Array.from({ length: n < 4 ? 60 : 100 }, (_, k) => run(n * 100 + k)),
  }));
  const text = synthesisPrompt({ objective: "o".repeat(4096), resultBatch });
  assert.ok(text.length <= synthesisMaxChars, String(text.length));
  assert.match(text, /"codingRunCount":100/);
  assert.match(text, /Still pending: 640 coding runs/);
});

test("the lead's status tool gets excerpts marked shortened", async (t) => {
  const report = long("Report");
  const { f, team, attempt } = await finishedTeam(t, [[report]]);
  const inv = { attemptId: attempt.id, toolCallId: "status", assertCurrent() {} };
  const status = f.service.status(inv, { teamId: team.id });
  assert.equal(status.resultBatch[0].shortened, true);
  assert.equal(status.resultBatch[0].truncated, undefined);
  assert.ok(status.resultBatch[0].text.length <= 2000);
  assert.match(status.note, /whole report is in that member's own chat/);
});
