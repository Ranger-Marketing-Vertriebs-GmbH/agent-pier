import test from "node:test";
import assert from "node:assert/strict";
import { ask, lead, until } from "../helpers/lead-request-service-fixture.js";
import { followUp } from "../../server/features/assistants/lead-request-text.js";

// Longer than OpenClaw's 8000-character history page and the old 6000 cap.
const long = (label, size = 10000) =>
  `${label}: ${"finding, with detail. ".repeat(size / 22)}end of ${label}.`;
async function answered(t, replies) {
  const f = await lead(t);
  f.service.requests.waitMs = 0;
  await ask(f, f.temporary, f.turn());
  const r = f.requests()[0];
  f.complete(r.attemptId, "ok", replies);
  await f.service.reconcile();
  return { f, r };
}

test("a 10,000-character member answer is stored whole and reaches the lead whole", async (t) => {
  const answer = long("Answer");
  const { f, r } = await answered(t, [answer]);
  // The record keeps an excerpt; the whole answer has its own row.
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.answer, Array.from(answer).slice(0, 2000).join(""));
  assert.equal(stored.answerTruncated, true);
  assert.equal(stored.answerCut, undefined);
  assert.equal(f.service.requestDetail(r.id).answer, answer);
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

test("an answer OpenClaw serves only as too large is cut, not missing", async (t) => {
  const { f, r } = await answered(t, ["[chat.history omitted: message too large]"]);
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.answerCut, true);
  assert.equal(stored.answer, "");
  assert.equal(stored.diagnostic, undefined);
});

test("pruning a request drops its whole answer too", async (t) => {
  const { f, r } = await answered(t, [long("Answer")]);
  const texts = () =>
    f.service.store.db
      .prepare("SELECT count(*) AS n FROM assistant_team_records WHERE kind='text'")
      .get().n;
  assert.equal(texts(), 1);
  f.service.store.write(f.service.requests.store.get(r.id), { settled: true });
  f.service.requests.store.prune(Date.now() + 40 * 86400000);
  assert.equal(texts(), 0);
});

test("an answer within the wait returns whole as the ask tool's result", async (t) => {
  const f = await lead(t);
  const answer = long("Answer");
  const pending = ask(f, f.temporary, f.turn());
  const r = await until(
    () => f.requests().find((x) => x.phase === "running"),
    "dispatch",
  );
  f.complete(r.attemptId, "ok", [answer]);
  await f.service.reconcile();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, answer);
});
