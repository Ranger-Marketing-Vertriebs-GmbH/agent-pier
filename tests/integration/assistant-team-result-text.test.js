import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { ask, lead } from "../helpers/lead-request-service-fixture.js";
import { followUp } from "../../server/features/assistants/lead-request-text.js";
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
  const [entry] = f.service.store.get(team.id).resultBatch;
  assert.equal(entry.text, report);
  assert.equal(entry.cut, undefined);
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
  assert.equal(entry.text, "a".repeat(65535));
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

test("a refused synthesis ends visibly instead of retrying silently", async (t) => {
  const { f, team, attempt } = await finishedTeam(t, [["Report"]]);
  f.assistants.ledger.transition(attempt.id, "completed");
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  let sends = 0;
  f.assistants.send = async () => {
    sends++;
    throw Object.assign(Error("invalid"), { status: 400, key: "invalid" });
  };
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(sends, 1);
  const stored = f.service.store.get(team.id);
  assert.equal(stored.resultState, "unsent");
  assert.equal(stored.resultDiagnostic, "RESULT_REFUSED");
  assert.ok(warnings.some((w) => w.includes(team.id)));
});

test("a 10,000-character member answer is stored whole and reaches the lead whole", async (t) => {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  const inv = f.turn();
  await ask(f, f.temporary, inv);
  const r = f.requests()[0];
  const answer = long("Answer");
  f.complete(r.attemptId, "ok", [answer]);
  await f.service.reconcile();
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.answer, answer);
  assert.equal(stored.answerCut, undefined);
  f.idle();
  await f.service.reconcile();
  const delivered = f.assistants.ledger
    .requests(f.chat.id)
    .find((x) => x.clientRequestId === `lead-request-result:${r.id}`);
  assert.ok(delivered.text.includes(JSON.stringify(answer)));
  assert.ok(!delivered.text.includes('"shortened"'));
});

test("a stored cut answer is announced as shortened to the lead", () => {
  const text = followUp({
    type: "question",
    memberName: "Member 0",
    phase: "completed",
    text: "What is the budget?",
    answer: "The budget is",
    answerCut: true,
  });
  assert.match(text, /"shortened":true/);
  assert.match(text, /whole text is in the member's own chat/);
});
