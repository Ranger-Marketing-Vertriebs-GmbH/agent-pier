import { setImmediate as tick } from "node:timers/promises";
import { teamFixture } from "./assistant-team-fixture.js";
import { requestCaps } from "../../server/features/assistants/lead-request-store.js";

// The owner's own words for each member of the fixture team.
export const quoteFor = (member) => `ask ${member.name} what the budget is`;
const ownerText =
  "Please ask Member 0 what the budget is, and ask Member 1 what the budget is";
export async function until(read, label = "condition", ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw Error(`Timed out waiting for ${label}`);
}
// A lead whose team finished: its members can be asked; the second one is permanent.
export async function lead(t) {
  const f = teamFixture(t);
  // Rate limits have their own tests; flows here run many requests in a moment.
  const saved = requestCaps.perMinute;
  requestCaps.perMinute = 1000;
  t.after(() => (requestCaps.perMinute = saved));
  const { team, parent, chat, attempt } = await f.proposal({ count: 2 });
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId);
  await f.service.reconcile();
  const synthesis = f.service.store.get(team.id).resultAttemptId;
  if (synthesis) f.complete(synthesis);
  await f.service.reconcile();
  const [temporary, second] = f.service.store.members(team.id);
  const permanent = await f.service.lifecycle("promote", second.id, second.revision);
  const turn = (text = ownerText, context = { kind: "owner" }) => {
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text,
    });
    f.service.store.recordContext(request.id, context);
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: crypto.randomUUID(), assertCurrent() {} };
  };
  // Ends every turn of the lead's chat, so a follow-up may be delivered.
  const idle = () => {
    for (const a of f.assistants.ledger.pending())
      if (f.assistants.ledger.getRequest(a.requestId).conversationId === chat.id)
        f.assistants.ledger.transition(a.id, "completed");
  };
  const requests = () => f.service.requests.store.list();
  const sends = () => f.calls.filter((c) => c.method === "sessions.send");
  return { ...f, team, parent, chat, temporary, permanent, turn, idle, requests, sends };
}
export const ask = (f, member, inv, extra = {}) =>
  f.service.ask(inv, {
    memberId: member.id,
    question: "What is the budget?",
    ...extra,
  });
